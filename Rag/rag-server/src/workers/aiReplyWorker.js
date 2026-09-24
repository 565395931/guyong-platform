/**
 * AI 回复 Worker — BullMQ 消费者
 *
 * 从 ai_reply 队列消费任务，执行 AI 自动回复处理。
 *
 * 任务数据格式：
 *   { conversationId, message, eventId }
 *
 * 处理流程：
 *   1. 从 configService 读取配置（并发数、超时、重试限制）
 *   2. 调用 aiAutoReplyService.handleAiSelfPoolMessage 执行实际逻辑
 *   3. 成功 → 写入 ai_reply_logs（业务事件）
 *   4. 失败 → BullMQ 自动重试（默认3次）
 *   5. 重试耗尽 → 自动转待人工池 + 写入 ai_reply_logs
 *
 * 并发控制：从运营配置读取 ai_queue_concurrency（默认5）
 * 速率限制：通过 BullMQ limiter 实现
 */

const { Worker } = require('bullmq')
const { redisClient, redisConfig } = require('../config/redis')
const { QUEUE_NAMES, isLatestAiReplyJob } = require('../queues')
const configService = require('../services/configService')
const { sequelize } = require('../config/database')
const { POOL_TYPE, CONV_STATUS } = require('../modules/conversation-pool/constants')
const { INTERNAL_EVENTS } = require('../modules/websocket/events')
const { randomUUID } = require('node:crypto')
const systemLogger = require('../utils/systemLogger')
const { createPendingReviewGuard } = require('./aiReplyReviewGuard')

const AI_REPLY_LOCK_POLL_MS = parseInt(process.env.AI_REPLY_LOCK_POLL_MS || '300', 10)

// 延迟加载 aiAutoReplyService 和 poolService，避免循环依赖
let aiAutoReplyService = null
let poolService = null
let pendingReviewGuard = null
let eventEmitterRef = null

function getAiAutoReplyService() {
  if (!aiAutoReplyService) {
    aiAutoReplyService = require('../modules/conversation-pool/ai-auto-reply.service')
  }
  return aiAutoReplyService
}

function getPoolService() {
  if (!poolService) {
    poolService = require('../modules/conversation-pool/pool.service')
  }
  return poolService
}

function getPendingReviewGuard() {
  if (!pendingReviewGuard) {
    pendingReviewGuard = createPendingReviewGuard({
      reviewService: require('../modules/message-review').reviewService,
      logger: systemLogger
    })
  }
  return pendingReviewGuard
}

function emitAiReplyStatus({ conversationId, status, jobId, jobMarker, reason }) {
  if (!eventEmitterRef || !conversationId || !status) return
  eventEmitterRef.emit(INTERNAL_EVENTS.AI_REPLY_STATUS, {
    conversationId,
    status,
    jobId: jobId || null,
    jobMarker: jobMarker || null,
    reason: reason || ''
  })
}

/**
 * 初始化 AI 回复 Worker
 * @param {EventEmitter} eventEmitter - 全局事件总线
 */
function initAiReplyWorker(eventEmitter) {
  eventEmitterRef = eventEmitter

  const worker = new Worker(
    QUEUE_NAMES.AI_REPLY,
    async (job) => {
      const { conversationId, message, enqueuedAt, jobMarker } = job.data

      console.log(`[AiReplyWorker] 处理任务 #${job.id}，会话 ${conversationId}`)

      // 任务开始前校验：如果会话已离开 AI 自助池，说明这是连续消息或池流转后的残留任务，直接跳过。
      // 同时校验任务入队后是否已有更新的客户消息；连续消息只回复最新一条。
      const stateBefore = await getConversationAiState(conversationId, enqueuedAt, jobMarker)
      if (!stateBefore.canAiReply) {
        const reason = stateBefore.reason || '会话已不在AI自助池，跳过残留AI回复任务'
        console.log(`[AiReplyWorker] 跳过任务 #${job.id}: ${reason}`)
        await logAiReplyEvent({
          conversationId,
          jobId: job.id,
          status: 'skipped',
          reason,
          retryCount: job.attemptsMade
        })
        emitAiReplyStatus({ conversationId, status: 'skipped', jobId: job.id, jobMarker, reason })
        return { replied: false, transferredToHuman: false, skipped: true, reason }
      }

      const reviewSkip = await getPendingReviewGuard()(message, conversationId)
      if (reviewSkip) {
        await logAiReplyEvent({
          conversationId,
          jobId: job.id,
          status: 'skipped',
          reason: reviewSkip.reason,
          retryCount: job.attemptsMade
        })
        emitAiReplyStatus({
          conversationId,
          status: 'skipped',
          jobId: job.id,
          jobMarker,
          reason: reviewSkip.reason
        })
        return { replied: false, transferredToHuman: false, ...reviewSkip }
      }

      const lockResult = await acquireConversationLock({ conversationId, jobId: job.id, enqueuedAt, jobMarker })
      if (!lockResult.acquired) {
        const reason = lockResult.reason || '会话串行锁等待失败'

        if (lockResult.retryable) {
          await logAiReplyEvent({
            conversationId,
            jobId: job.id,
            status: 'retrying',
            reason,
            retryCount: job.attemptsMade
          })
          emitAiReplyStatus({ conversationId, status: 'retrying', jobId: job.id, jobMarker, reason })
          throw new Error(reason)
        }

        console.log(`[AiReplyWorker] 跳过任务 #${job.id}: ${reason}`)
        await logAiReplyEvent({
          conversationId,
          jobId: job.id,
          status: 'skipped',
          reason,
          retryCount: job.attemptsMade
        })
        emitAiReplyStatus({ conversationId, status: 'skipped', jobId: job.id, jobMarker, reason })
        return { replied: false, transferredToHuman: false, skipped: true, reason }
      }

      emitAiReplyStatus({ conversationId, status: 'replying', jobId: job.id, jobMarker })

      const lockHeartbeat = startConversationLockHeartbeat(conversationId, lockResult.token, lockResult.lockTtlMs)
      let result
      try {
        // 调用核心 AI 回复逻辑
        result = await getAiAutoReplyService().handleAiSelfPoolMessage(
          conversationId,
          message,
          eventEmitterRef,
          { enqueuedAt, jobMarker }
        )
      } finally {
        stopConversationLockHeartbeat(lockHeartbeat)
        await releaseConversationLock(conversationId, lockResult.token)
      }

      // 判断业务状态
      let logStatus
      if (result.replied) {
        logStatus = 'success'
      } else if (result.transferredToHuman) {
        logStatus = 'transferred'
      } else if (result.error) {
        // 有错误（AI回复为空、RAG生成失败、API超时等），将触发 BullMQ 重试
        logStatus = 'retrying'
      } else {
        logStatus = 'skipped'
      }

      // 写入业务日志
      await logAiReplyEvent({
        conversationId,
        jobId: job.id,
        status: logStatus,
        reason: result.reason || result.error || '',
        retryCount: job.attemptsMade,
        extra: result.extra || null
      })

      emitAiReplyStatus({
        conversationId,
        status: logStatus === 'success' ? 'done' : logStatus,
        jobId: job.id,
        jobMarker,
        reason: result.reason || result.error || ''
      })

      // 如果 AI 回复失败且未转人工，抛出错误触发 BullMQ 重试
      // 包括：API 超时、AI 回复为空、RAG 生成失败等
      // BullMQ 会按 backoff 策略延迟重试，重试耗尽后由 failed 事件处理转人工
      if (!result.replied && !result.transferredToHuman && result.error) {
        throw new Error(result.error)
      }

      return result
    },
    {
      connection: redisConfig,
      // 并发数从配置读取（启动时同步读取，后续可通过重启生效）
      // 这里用同步方式获取默认值，实际并发数在 Worker 启动后可通过 configService 动态调整
      concurrency: 5
    }
  )

  // ========== Worker 事件监听 ==========
  worker.on('completed', (job) => {
    console.log(`[AiReplyWorker] 任务 #${job.id} 完成`)
  })

  worker.on('failed', async (job, err) => {
    console.error(`[AiReplyWorker] 任务 #${job.id} 失败:`, err.message)

    // 重试耗尽 → 自动转人工
    const retryLimit = await configService.getConfig('ai_retry_limit', 3)
    if (job.attemptsMade >= retryLimit) {
      const { conversationId, message } = job.data

      console.log(`[AiReplyWorker] 任务 #${job.id} 重试耗尽(${job.attemptsMade}/${retryLimit})，自动转人工`)

      // 转待人工池
      const poolSvc = getPoolService()
      await poolSvc.aiTransferToHuman(
        conversationId,
        `AI回复重试${retryLimit}次仍失败: ${err.message}`,
        eventEmitterRef
      )

      // 写入业务日志
      await logAiReplyEvent({
        conversationId,
        jobId: job.id,
        status: 'failed_transferred',
        reason: `重试${job.attemptsMade}次后失败，自动转人工: ${err.message}`,
        retryCount: job.attemptsMade
      })
      emitAiReplyStatus({
        conversationId,
        status: 'transferred',
        jobId: job.id,
        jobMarker: job.data?.jobMarker || null,
        reason: `重试${job.attemptsMade}次后失败，自动转人工: ${err.message}`
      })
    }
  })

  console.log('[AiReplyWorker] Worker 已启动，并发数: 5')

  return worker
}

/**
 * 写入 AI 回复业务日志到 ai_reply_logs 表
 */
async function logAiReplyEvent(params) {
  const { conversationId, jobId, status, reason, retryCount, extra } = params
  if (shouldSuppressAiReplyLog({ status, reason })) {
    return
  }

  try {
    const logId = randomUUID()
    await sequelize.query(
      `INSERT INTO ai_reply_logs (id, conversation_id, job_id, status, reason, retry_count, extra, created_at)
       VALUES (:id, :conversationId, :jobId, :status, :reason, :retryCount, :extra, NOW())`,
      {
        replacements: {
          id: logId,
          conversationId,
          jobId: jobId || null,
          status,
          reason: reason || '',
          retryCount: retryCount || 0,
          extra: extra ? JSON.stringify(extra) : null
        }
      }
    )
  } catch (err) {
    // 日志写入失败不影响主流程
    console.error('[AiReplyWorker] 写入日志失败:', err.message)
  }
}

function shouldSuppressAiReplyLog({ status, reason }) {
  if (status !== 'skipped') return false

  const text = String(reason || '')
  if (!text) return false

  return [
    '会话不存在',
    'AI自助聊天总开关已关闭',
    '不在AI自助池',
    '不是 ai_self/ai_serving',
    '不是该会话最新的 AI 回复任务',
    '任务入队后又收到',
    '跳过旧任务'
  ].some(pattern => text.includes(pattern))
}

async function getConversationAiState(conversationId, enqueuedAt = null, jobMarker = null) {
  try {
    const [rows] = await sequelize.query(
      `SELECT pool_type, conv_status FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { canAiReply: false, reason: '会话不存在' }
    }

    const aiSelfPoolEnabled = await configService.getConfig('ai_self_pool_enabled', true)
    if (aiSelfPoolEnabled === false) {
      return { canAiReply: false, reason: 'AI自助聊天总开关已关闭，跳过自动回复' }
    }

    const conv = rows[0]
    if (conv.pool_type !== POOL_TYPE.AI_SELF || conv.conv_status !== CONV_STATUS.AI_SERVING) {
      return {
        canAiReply: false,
        reason: `会话当前为 ${conv.pool_type}/${conv.conv_status}，不是 ${POOL_TYPE.AI_SELF}/${CONV_STATUS.AI_SERVING}`
      }
    }

    if (jobMarker) {
      const isLatest = await isLatestAiReplyJob(conversationId, jobMarker)
      if (!isLatest) {
        return { canAiReply: false, reason: '当前任务不是该会话最新的 AI 回复任务' }
      }
    }

    if (enqueuedAt) {
      const [newerRows] = await sequelize.query(
        `SELECT COUNT(*) AS cnt
         FROM plat_messages
         WHERE conversation_id = :conversationId
           AND direction = 'inbound'
           AND sender_type = 'customer'
           AND created_at > FROM_UNIXTIME(:enqueuedAtMs / 1000)`,
        { replacements: { conversationId, enqueuedAtMs: enqueuedAt } }
      )
      const newerCount = newerRows[0]?.cnt || 0
      if (newerCount > 0) {
        return { canAiReply: false, reason: `任务入队后又收到 ${newerCount} 条新客户消息，跳过旧任务` }
      }
    }

    return { canAiReply: true }
  } catch (err) {
    console.error('[AiReplyWorker] 查询会话AI状态失败:', err.message)
    // 查询失败时保守处理：不执行 AI 回复，避免状态不明时误发消息
    return { canAiReply: false, reason: '查询会话AI状态失败: ' + err.message }
  }
}

function getConversationLockKey(conversationId) {
  return `ai_reply:lock:${conversationId}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function acquireConversationLock({ conversationId, jobId, enqueuedAt, jobMarker }) {
  const lockTtlMs = await configService.getConfig('ai_reply_lock_ttl_ms')
  const lockWaitMs = await configService.getConfig('ai_reply_lock_wait_ms')
  const lockKey = getConversationLockKey(conversationId)
  const token = `${jobId}:${Date.now()}`
  const deadline = Date.now() + lockWaitMs
  let loggedWaiting = false

  while (Date.now() <= deadline) {
    const acquired = await redisClient.set(lockKey, token, 'PX', lockTtlMs, 'NX')
    if (acquired) {
      console.log(`[AiReplyWorker] 获取会话锁成功，会话 ${conversationId}，任务 #${jobId}`)
      return { acquired: true, token, lockTtlMs }
    }

    if (!loggedWaiting) {
      console.log(`[AiReplyWorker] 会话 ${conversationId} 已有执行中的 AI 任务，最新任务 #${jobId} 等待串行锁`)
      loggedWaiting = true
    }

    const state = await getConversationAiState(conversationId, enqueuedAt, jobMarker)
    if (!state.canAiReply) {
      return { acquired: false, reason: state.reason }
    }

    await sleep(AI_REPLY_LOCK_POLL_MS)
  }

  return {
    acquired: false,
    retryable: true,
    reason: `等待会话串行锁超时(${lockWaitMs}ms)，将按队列重试等待当前执行完成`
  }
}

function startConversationLockHeartbeat(conversationId, token, lockTtlMs) {
  return setInterval(async () => {
    try {
      await extendConversationLock(conversationId, token, lockTtlMs)
    } catch (err) {
      console.error('[AiReplyWorker] 会话锁续期失败:', err.message)
    }
  }, Math.max(1000, Math.floor(lockTtlMs / 3)))
}

function stopConversationLockHeartbeat(timer) {
  if (timer) clearInterval(timer)
}

async function extendConversationLock(conversationId, token, lockTtlMs) {
  if (!conversationId || !token) return

  const lockKey = getConversationLockKey(conversationId)
  await redisClient.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
    1,
    lockKey,
    token,
    String(lockTtlMs)
  )
}

async function releaseConversationLock(conversationId, token) {
  if (!conversationId || !token) return

  try {
    const lockKey = getConversationLockKey(conversationId)
    await redisClient.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      token
    )
  } catch (err) {
    console.error('[AiReplyWorker] 释放会话锁失败:', err.message)
  }
}

module.exports = {
  initAiReplyWorker
}
