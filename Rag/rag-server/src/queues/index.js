/**
 * BullMQ 队列定义
 *
 * 队列列表：
 *   ai_reply  - AI 自动回复主队列（替代同步调用）
 *
 * 定时任务（超时/归档/提醒）保留 setInterval，不走 BullMQ，
 * 因为它们是扫描型任务而非单会话延迟任务。
 *
 * 配置刷新用 Redis Pub/Sub，不走 BullMQ。
 */

const { Queue, QueueEvents } = require('bullmq')
const { redisClient, redisConfig } = require('../config/redis')

// ========== 队列名称常量 ==========
const QUEUE_NAMES = {
  AI_REPLY: 'ai_reply'
}

// ========== 队列定义 ==========
// 注意：Queue 实例用于添加任务，可在多个模块中共享
const aiReplyQueue = new Queue(QUEUE_NAMES.AI_REPLY, {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,           // 默认重试 3 次
    backoff: {
      type: 'exponential',  // 指数退避
      delay: 2000           // 首次重试延迟 2 秒
    },
    removeOnComplete: { count: 100 }, // 保留最近 100 条完成记录
    removeOnFail: { count: 200 }      // 保留最近 200 条失败记录
  }
})

// ========== 队列事件监听（用于监控） ==========
const aiReplyQueueEvents = new QueueEvents(QUEUE_NAMES.AI_REPLY, {
  connection: redisConfig
})

/**
 * 获取队列监控指标
 * @returns {Promise<Object>}
 */
async function getQueueStats() {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      aiReplyQueue.getWaitingCount(),
      aiReplyQueue.getActiveCount(),
      aiReplyQueue.getCompletedCount(),
      aiReplyQueue.getFailedCount(),
      aiReplyQueue.getDelayedCount()
    ])

    return {
      queue_name: QUEUE_NAMES.AI_REPLY,
      waiting,    // 等待处理
      active,     // 处理中
      completed,  // 已完成
      failed,     // 失败（含重试中）
      delayed,    // 延迟中
      total: waiting + active + delayed
    }
  } catch (err) {
    console.error('[Queue] 获取队列统计失败:', err.message)
    return {
      queue_name: QUEUE_NAMES.AI_REPLY,
      waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0
    }
  }
}

/**
 * 清理指定会话尚未开始执行的 AI 回复任务。
 *
 * 只删除 waiting/delayed/prioritized/paused 状态的任务；active 任务不能安全删除，
 * active 任务会在 Worker 和发送前通过会话池状态校验自行跳过。
 *
 * @param {string} conversationId
 * @param {string} reason
 * @returns {Promise<number>} 已移除任务数
 */
function getAiReplyLatestMarkerKey(conversationId) {
  return `ai_reply:latest:${conversationId}`
}

async function markLatestAiReplyJob(conversationId, marker) {
  if (!conversationId || !marker) return
  await redisClient.set(getAiReplyLatestMarkerKey(conversationId), String(marker), 'EX', 3600)
}

async function isLatestAiReplyJob(conversationId, marker) {
  if (!conversationId || !marker) return true
  const latest = await redisClient.get(getAiReplyLatestMarkerKey(conversationId))
  // 没有 marker 时兼容旧任务；有 marker 时只有最新任务可继续执行/发送。
  return !latest || String(latest) === String(marker)
}

async function removePendingAiReplyJobs(conversationId, reason = '') {
  if (!conversationId) return 0

  try {
    const jobs = await aiReplyQueue.getJobs(['waiting', 'delayed', 'prioritized', 'paused'], 0, -1, true)
    let removed = 0

    for (const job of jobs) {
      if (job?.data?.conversationId === conversationId) {
        await job.remove()
        removed++
      }
    }

    if (removed > 0) {
      console.log(`[Queue] 已清理会话 ${conversationId} 的 AI 待处理任务 ${removed} 个${reason ? `，原因: ${reason}` : ''}`)
    }

    return removed
  } catch (err) {
    console.error('[Queue] 清理 AI 待处理任务失败:', err.message)
    return 0
  }
}

module.exports = {
  QUEUE_NAMES,
  aiReplyQueue,
  aiReplyQueueEvents,
  getQueueStats,
  getAiReplyLatestMarkerKey,
  markLatestAiReplyJob,
  isLatestAiReplyJob,
  removePendingAiReplyJobs
}
