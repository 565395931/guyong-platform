const { QueryTypes } = require('sequelize')
const currentConversationRegistry = require('./currentConversationRegistry')

const DEFAULT_TTL_MINUTES = 3
const DEFAULT_INTERVAL_MS = 30_000

/**
 * 桌面桥接会话的"过期归档"。
 *
 * 规则：账号在 TTL（默认 3 分钟）内没有任何消息活动 → 归档。
 * 与飞鸽客户端的行为一致：无互动一段时间后它会关闭当前会话，
 * 此时我方也无法再继续对话，除非客户重新拉起。
 *
 * 实现要点：**不新增字段、不写重置逻辑**。
 * 过期时间由 `conversations.last_message_time + TTL` 派生——客户回复、AI 回复、
 * 我方手动回复都会刷新 last_message_time，所以"倒计时随消息重置"是天然成立的。
 * 少一个字段就少一处可能不同步的状态。
 *
 * ⚠️ 跳过"节点当前打开的会话"
 * ---------------------------
 * 客户端里还开着的会话不按 TTL 归档。否则会与 `accountSnapshotService` 的
 * "当前会话从归档恢复"直接打架：同一个会话每 30 秒被归档一次、又被快照恢复一次，
 * `conv_status` 反复横跳，发送会随机撞上 archived 被 409 拒绝（实测）。
 * 归属判定交给 AccountSnapshot（它的输入就是客户端此刻的状态），
 * TTL 只负责清理节点静默/离线时的陈旧会话。
 */
function createBridgeExpiryService({
  sequelize,
  logger = console,
  ttlMinutes = DEFAULT_TTL_MINUTES,
  intervalMs = DEFAULT_INTERVAL_MS,
  channel = 'douyin',
  registry = currentConversationRegistry
} = {}) {
  if (!sequelize) throw new Error('sequelize is required')

  let timer = null

  async function sweepOnce() {
    // 先选出候选（哪些会话已超时），再在内存里剔除"当前打开的会话"。
    // 用 SELECT + UPDATE 而不是纯 UPDATE：需要拿 account_id / user_id 才能
    // 和快照登记的当前会话比对。
    const candidates = await sequelize.query(
      `SELECT id, account_id, user_id
         FROM conversations
        WHERE channel = :channel
          AND conv_status <> 'archived'
          AND last_message_time IS NOT NULL
          AND last_message_time < DATE_SUB(NOW(3), INTERVAL :ttl MINUTE)`,
      { replacements: { channel, ttl: ttlMinutes }, type: QueryTypes.SELECT }
    )

    const expirable = (candidates || []).filter(
      row => !registry.isCurrent(row.account_id, row.user_id)
    )
    if (expirable.length === 0) return 0

    // UPDATE 里再判一次 TTL：SELECT 与 UPDATE 之间若有新消息，
    // last_message_time 已被刷新，这一行就不该再被归档。
    const [result] = await sequelize.query(
      `UPDATE conversations
          SET conv_status = 'archived', status = 'closed', ai_epoch = ai_epoch + 1, updated_at = NOW(3)
        WHERE id IN (:ids)
          AND conv_status <> 'archived'
          AND last_message_time < DATE_SUB(NOW(3), INTERVAL :ttl MINUTE)`,
      {
        replacements: { ids: expirable.map(row => row.id), ttl: ttlMinutes }
      }
    )
    const affected = (result && result.affectedRows) || 0
    if (affected > 0) {
      logger.info(
        '[BridgeExpiry] %d 条会话超过 %d 分钟无消息活动，已归档（channel=%s）',
        affected, ttlMinutes, channel
      )
    }
    return affected
  }

  function start() {
    if (timer) return
    // unref：不要让这个定时器阻止进程退出
    timer = setInterval(() => {
      sweepOnce().catch(error => logger.warn('[BridgeExpiry] 扫描失败:', error.message))
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    logger.info('[BridgeExpiry] 已启动：%s 会话 idle > %d 分钟即归档，每 %ds 扫描一次',
      channel, ttlMinutes, Math.round(intervalMs / 1000))
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop, sweepOnce }
}

module.exports = { createBridgeExpiryService, DEFAULT_TTL_MINUTES, DEFAULT_INTERVAL_MS }
