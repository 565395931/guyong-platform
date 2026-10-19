/**
 * 会话池定时器服务
 *
 * 职责：定期扫描各池中的会话，执行超时/超龄自动流转
 *
 * 定时任务：
 *   1. AI 自助池超时退出
 *      - AI 连续回复后客户仍在追问（轮数检测）→ 待人工池
 *      - 客户未回复达到配置时限 → 归档
 *      - 客户仍等待AI回复超时 → 待人工池
 *   2. 待人工池超龄转公共池
 *      - 待人工池 10 分钟无人抢单 → 公共池
 *   3. 公共池超龄归档
 *      - 公共池停留超过 24 小时 → 自动归档
 *   4. 私有池客户沉默归档
 *      - 已回复后无消息活动达到配置时限 → 归档
 *
 * 调用入口：app.js 启动时调用 startPoolTimers(eventEmitter)
 */

const { sequelize } = require('../../config/database')
const poolService = require('./pool.service')
const { POOL_TYPE, CONV_STATUS, POOL_ACTION } = require('./constants')
const { INTERNAL_EVENTS } = require('../websocket/events')

let timerHandle = null
const SCAN_INTERVAL = 60 * 1000 // 每分钟扫描一次

/**
 * 启动池定时器
 * @param {EventEmitter} eventEmitter
 */
function startPoolTimers(eventEmitter) {
  if (timerHandle) {
    console.log('[PoolTimer] 定时器已在运行，跳过')
    return
  }

  console.log('[PoolTimer] 启动会话池定时器，扫描间隔: 60秒')

  // 立即执行一次（延迟 10 秒，等待服务完全启动）
  setTimeout(() => scanAndProcess(eventEmitter).catch(err => {
    console.error('[PoolTimer] 初始扫描失败:', err.message)
  }), 10000)

  // 定时执行
  timerHandle = setInterval(async () => {
    try {
      await scanAndProcess(eventEmitter)
    } catch (err) {
      console.error('[PoolTimer] 定时扫描失败:', err.message)
    }
  }, SCAN_INTERVAL)
}

/**
 * 停止池定时器
 */
function stopPoolTimers() {
  if (timerHandle) {
    clearInterval(timerHandle)
    timerHandle = null
    console.log('[PoolTimer] 定时器已停止')
  }
}

/**
 * 主扫描函数 — 执行所有超时/超龄检查
 */
async function scanAndProcess(eventEmitter) {
  const config = await poolService.getPoolConfig()

  // 1. AI 自助池超时处理
  await processAiSelfPoolTimeout(config, eventEmitter)

  // 2. AI 自助池客户等待 AI 超时转待人工池
  await processAiSelfPoolStale(config, eventEmitter)

  // 待人工保留在可见队列，不再自动移入已取消的公共池。

  // 已经被旧规则移入公共池的已回复会话，也按客户沉默时限归档。
  await processAnsweredPublicPoolIdle(config, eventEmitter)

  // 4. 公共池超龄归档
  await processPublicPoolAging(config, eventEmitter)

  // 5. 私有池已回复后无消息活动自动归档
  await processPrivatePoolStale(config, eventEmitter)
}

/**
 * AI 自助池超时处理
 *
 * 触发条件：
 *   a) 客户 N 分钟未回复 → 自动归档
 *   b) AI 回复轮数超限 → 转待人工池（此处兜底，ai-auto-reply.service 中也有实时检测）
 */
async function processAiSelfPoolTimeout(config, eventEmitter) {
  try {
    // a) 客户未回复超时 → 归档
    const noReplyTimeout = (config.ai_no_reply_timeout || 1800) // 默认 30 分钟
    const noReplyTimeoutEnabled = config.ai_no_reply_timeout_enabled !== false
    let staleConvs = []
    if (noReplyTimeoutEnabled) {
      const [rows] = await sequelize.query(
        `SELECT id, updated_at, last_message_time, last_reply_by FROM conversations
         WHERE pool_type = :poolType
           AND conv_status = :convStatus
           AND last_reply_by = :replyBy
           AND last_reply_time IS NOT NULL
           AND TIMESTAMPDIFF(SECOND, last_reply_time, NOW()) > :timeout`,
        {
          replacements: {
            poolType: POOL_TYPE.AI_SELF,
            convStatus: CONV_STATUS.AI_SERVING,
            replyBy: 'ai',
            timeout: noReplyTimeout
          }
        }
      )
      staleConvs = rows
    }

    for (const conv of staleConvs) {
      await archiveIdleConversation(conv, {
        poolType:POOL_TYPE.AI_SELF,convStatus:CONV_STATUS.AI_SERVING,
        replyBy:'ai',timeout:noReplyTimeout,activityColumn:'last_reply_time',
        reason:`AI回复后客户${Math.floor(noReplyTimeout / 60)}分钟未回复，自动归档`
      },eventEmitter)
    }

    // b) AI 回复轮数超限兜底（0=不限制，与实时检测一致）
    const maxRounds = config.ai_max_rounds !== undefined ? parseInt(config.ai_max_rounds, 10) : 0
    if (maxRounds > 0) {
      const [overLimitConvs] = await sequelize.query(
        `SELECT c.id FROM conversations c
         WHERE c.pool_type = :poolType
           AND c.conv_status = :convStatus
           AND (SELECT COUNT(*) FROM plat_messages WHERE conversation_id = c.id AND direction = 'outbound' AND sender_type = 'ai' AND send_status = 'sent') > :maxRounds`,
        {
          replacements: {
            poolType: POOL_TYPE.AI_SELF,
            convStatus: CONV_STATUS.AI_SERVING,
            maxRounds
          }
        }
      )

      for (const conv of overLimitConvs) {
        const result = await poolService.aiTransferToHuman(
          conv.id,
          `AI回复轮数超限兜底(>${maxRounds}轮)`,
          eventEmitter
        )
        if (result.success) {
          console.log(`[PoolTimer] AI自助池会话 ${conv.id} 回复轮数超限转待人工池`)
        }
      }
    } // end if maxRounds > 0
  } catch (err) {
    console.error('[PoolTimer] AI自助池超时处理失败:', err.message)
  }
}

/**
 * AI 自助池客户等待 AI 超时转待人工池
 *
 * 检测客户最后发言后 AI 长时间未回复的停滞会话。
 * 与 processAiSelfPoolTimeout 的区别：
 *   - processAiSelfPoolTimeout 检查 AI 已回复、客户沉默，归档
 *   - 本函数检查客户已发言、AI 未跟上，转待人工池兜底
 *
 * 配置项：ai_self_stale_timeout（秒），默认 1800（30 分钟）
 */
async function processAiSelfPoolStale(config, eventEmitter) {
  try {
    const staleTimeout = config.ai_self_stale_timeout || 1800 // 默认 30 分钟

    const [staleConvs] = await sequelize.query(
      `SELECT id, last_message_time, last_reply_by FROM conversations
       WHERE pool_type = :poolType
         AND conv_status = :convStatus
         AND last_reply_by = :replyBy
         AND last_message_time IS NOT NULL
         AND TIMESTAMPDIFF(SECOND, GREATEST(last_message_time, COALESCE((SELECT MAX(l.created_at) FROM conversation_pool_logs l WHERE l.conversation_id = conversations.id AND l.to_pool = :poolType), last_message_time)), NOW()) > :timeout`,
      {
        replacements: {
          poolType: POOL_TYPE.AI_SELF,
          convStatus: CONV_STATUS.AI_SERVING,
          replyBy: 'customer',
          timeout: staleTimeout
        }
      }
    )

    for (const conv of staleConvs) {
      const result = await poolService.movePool({
        conversationId: conv.id,
        targetPool: POOL_TYPE.PENDING_HUMAN,
        operatorType: 'system',
        operatorName: '系统定时器',
        reason: `客户等待AI超过${Math.floor(staleTimeout / 60)}分钟未收到回复，转待人工池`,
        eventEmitter
      })
      if (result.success) {
        console.log(`[PoolTimer] AI自助池会话 ${conv.id} 客户等待AI超时转待人工池`)
      }
    }
  } catch (err) {
    console.error('[PoolTimer] AI自助池消息超时处理失败:', err.message)
  }
}

/**
 * 待人工池超龄转公共池
 *
 * 待人工池 10 分钟无人抢单 → 公共池
 */
async function processPendingHumanAging(config, eventEmitter) {
  try {
    const agingTimeoutEnabled = config.pending_human_aging_timeout_enabled !== false
    if (!agingTimeoutEnabled) return

    const agingTimeout = config.pending_human_aging_timeout || 600 // 默认 10 分钟

    const [agingConvs] = await sequelize.query(
      `SELECT id, created_at, updated_at FROM conversations
       WHERE pool_type = :poolType
         AND conv_status = :convStatus
         AND TIMESTAMPDIFF(SECOND, updated_at, NOW()) > :timeout`,
      {
        replacements: {
          poolType: POOL_TYPE.PENDING_HUMAN,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          timeout: agingTimeout
        }
      }
    )

    for (const conv of agingConvs) {
      const result = await poolService.movePool({
        conversationId: conv.id,
        targetPool: POOL_TYPE.PUBLIC,
        operatorType: 'system',
        operatorName: '系统定时器',
        reason: `待人工池${Math.floor(agingTimeout / 60)}分钟无人抢单，转公共池`,
        eventEmitter
      })
      if (result.success) {
        console.log(`[PoolTimer] 待人工池会话 ${conv.id} 超龄转公共池`)
      }
    }
  } catch (err) {
    console.error('[PoolTimer] 待人工池超龄处理失败:', err.message)
  }
}

/**
 * 公共池超龄归档
 *
 * 公共池停留超过 24 小时无人认领 → 自动归档，标记"客户流失"
 */
async function processPublicPoolAging(config, eventEmitter) {
  try {
    const archiveTimeout = config.public_pool_archive_timeout || 86400 // 默认 24 小时

    const [agingConvs] = await sequelize.query(
      `SELECT id, updated_at FROM conversations
       WHERE pool_type = :poolType
         AND conv_status = :convStatus
         AND TIMESTAMPDIFF(SECOND, updated_at, NOW()) > :timeout`,
      {
        replacements: {
          poolType: POOL_TYPE.PUBLIC,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          timeout: archiveTimeout
        }
      }
    )

    for (const conv of agingConvs) {
      // 归档
      await sequelize.query(
        `UPDATE conversations SET conv_status = :archived, status = 'closed', ai_epoch = ai_epoch + 1, updated_at = NOW() WHERE id = :id`,
        { replacements: { archived: CONV_STATUS.ARCHIVED, id: conv.id } }
      )
      poolService.clearPoolStatsCache?.()

      await poolService.logPoolAction({
        conversationId: conv.id,
        action: POOL_ACTION.ARCHIVE,
        fromPool: POOL_TYPE.PUBLIC,
        toPool: null,
        operatorType: 'system',
        operatorName: '系统定时器',
        reason: '公共池24小时无人认领，自动归档（客户流失）'
      })

      // 通知前端
      if (eventEmitter) {
        eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
          id: conv.id,
          conversationId: conv.id,
          type: 'archived',
          reason: '公共池超龄自动归档'
        })
      }

      console.log(`[PoolTimer] 公共池会话 ${conv.id} 超龄自动归档`)
    }
  } catch (err) {
    console.error('[PoolTimer] 公共池超龄归档失败:', err.message)
  }
}

/**
 * 私有池人工已回复后无消息活动自动归档
 *
 * 坐席已回复后客户长时间没有再发消息 → 自动归档
 * 与 releaseOnSeatOffline 的区别：
 *   - releaseOnSeatOffline 在坐席 WebSocket 断开时触发
 *   - 本函数在定时器扫描时按 last_message_time 判断停滞会话
 *
 * 配置项：private_pool_stale_timeout_enabled（开关），private_pool_stale_timeout（秒），默认 3600（1 小时）
 */
async function processPrivatePoolStale(config, eventEmitter) {
  try {
    const staleTimeoutEnabled = config.private_pool_stale_timeout_enabled !== false
    if (!staleTimeoutEnabled) return

    const staleTimeout = config.private_pool_stale_timeout || 3600 // 默认 1 小时

    const [staleConvs] = await sequelize.query(
      `SELECT id, updated_at, last_message_time, last_reply_by, claimed_by FROM conversations
       WHERE pool_type = :poolType
         AND conv_status = :convStatus
         AND last_reply_by = :replyBy
         AND last_message_time IS NOT NULL
         AND TIMESTAMPDIFF(SECOND, last_message_time, NOW()) > :timeout`,
      {
        replacements: {
          poolType: POOL_TYPE.PRIVATE,
          convStatus: CONV_STATUS.HANDLING,
          replyBy: 'agent',
          timeout: staleTimeout
        }
      }
    )

    for (const conv of staleConvs) {
      await archiveIdleConversation(conv, {
        poolType:POOL_TYPE.PRIVATE,convStatus:CONV_STATUS.HANDLING,
        replyBy:'agent',timeout:staleTimeout,activityColumn:'last_message_time',
        reason:`人工回复后会话${Math.floor(staleTimeout / 60)}分钟无活动，自动归档`
      },eventEmitter)
    }
  } catch (err) {
    console.error('[PoolTimer] 私有池超时释放失败:', err.message)
  }
}

async function processAnsweredPublicPoolIdle(config, eventEmitter) {
  for (const rule of [
    {enabled:config.ai_no_reply_timeout_enabled !== false,replyBy:'ai',timeout:config.ai_no_reply_timeout || 1800,activityColumn:'last_reply_time'},
    {enabled:config.private_pool_stale_timeout_enabled !== false,replyBy:'agent',timeout:config.private_pool_stale_timeout || 3600,activityColumn:'last_message_time'}
  ]) {
    if (!rule.enabled) continue
    try {
      const [rows] = await sequelize.query(
        `SELECT id, updated_at FROM conversations WHERE pool_type = :poolType AND conv_status = :convStatus
         AND last_reply_by = :replyBy AND TIMESTAMPDIFF(SECOND, ${rule.activityColumn}, NOW()) > :timeout`,
        {replacements:{poolType:POOL_TYPE.PUBLIC,convStatus:CONV_STATUS.PENDING_CLAIM,replyBy:rule.replyBy,timeout:rule.timeout}}
      )
      for (const conv of rows) await archiveIdleConversation(conv,{
        ...rule,poolType:POOL_TYPE.PUBLIC,convStatus:CONV_STATUS.PENDING_CLAIM,
        reason:`已回复会话客户${Math.floor(rule.timeout/60)}分钟无活动，从公共池自动归档`
      },eventEmitter)
    } catch (err) { console.error('[PoolTimer] 公共池客户沉默归档失败:',err.message) }
  }
}

async function archiveIdleConversation(conv, rule, eventEmitter) {
  const activityColumn = rule.activityColumn === 'last_reply_time' ? 'last_reply_time' : 'last_message_time'
  // Recheck state and activity at update time: incoming messages or a pool change cancel this scan.
  const [, metadata] = await sequelize.query(
    `UPDATE conversations SET conv_status = :archived, status = 'closed', ai_epoch = ai_epoch + 1, updated_at = NOW()
     WHERE id = :id AND pool_type = :poolType AND conv_status = :convStatus
       AND last_reply_by = :replyBy AND updated_at <=> :observedUpdate
       AND TIMESTAMPDIFF(SECOND, ${activityColumn}, NOW()) > :timeout`,
    {replacements:{id:conv.id,poolType:rule.poolType,convStatus:rule.convStatus,replyBy:rule.replyBy,
      observedUpdate:conv.updated_at,timeout:rule.timeout,archived:CONV_STATUS.ARCHIVED}}
  )
  const affected = typeof metadata === 'number' ? metadata : metadata?.affectedRows
  if (!affected) return false
  poolService.clearPoolStatsCache?.()
  await poolService.logPoolAction({conversationId:conv.id,action:POOL_ACTION.AUTO_ARCHIVE,
    fromPool:rule.poolType,toPool:null,operatorType:'system',operatorName:'系统定时器',reason:rule.reason})
  eventEmitter?.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE,{id:conv.id,conversationId:conv.id,type:'archived',reason:rule.reason})
  console.log(`[PoolTimer] 会话 ${conv.id} 超时自动归档`)
  return true
}

module.exports = {
  startPoolTimers,
  stopPoolTimers,
  scanAndProcess
}
