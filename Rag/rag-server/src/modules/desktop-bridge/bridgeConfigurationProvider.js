const { QueryTypes } = require('sequelize')

const HEARTBEAT_INTERVAL_MS = 15_000
const LEASE_DURATION_MS = 45_000

/**
 * 节点上线时下发配置，并顺带完成租约获取。
 *
 * 为什么放在这里：协议里**没有任何"申请租约"的报文**——`node.hello` 不带，
 * `node.heartbeat` 只做续租（renew）。而 `leaseService.acquire()` 是纯服务端调用。
 * gateway 已经预留了 `configurationProvider({ nodeId, databaseNodeId })` 这个扩展点，
 * 在这里取租约既补上了缺口，又不需要改动已测试通过的 bridgeGateway。
 *
 * 租约令牌随 node.ready 下发给节点，节点在后续 heartbeat 里带上它续租；
 * 服务端只存哈希，所以令牌只在这一次响应里出现。
 */
function createBridgeConfigurationProvider({
  sequelize,
  leaseService,
  logger = console,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  leaseDurationMs = LEASE_DURATION_MS
} = {}) {
  if (!sequelize) throw new Error('sequelize is required')
  if (!leaseService) throw new Error('leaseService is required')

  return async function configurationProvider({ nodeId, databaseNodeId } = {}) {
    const candidates = await sequelize.query(
      `SELECT b.channel_account_id, b.adapter_id, b.preferred_node_id,
              a.channel, a.account_name
         FROM desktop_bridge_bindings b
         JOIN channel_accounts a ON a.id = b.channel_account_id
        WHERE b.enabled = 1
          AND a.status = 'active'
          AND (b.preferred_node_id IS NULL OR b.preferred_node_id = :databaseNodeId)
        ORDER BY b.channel_account_id ASC`,
      { replacements: { databaseNodeId }, type: QueryTypes.SELECT }
    )

    const accounts = []
    for (const row of candidates) {
      try {
        // 用 reclaim 而不是 acquire：节点重启时旧租约往往还没到 45 秒 TTL，
        // acquire 会无条件抛 CONFLICT（哪怕持有者就是本节点），导致节点静默拿不到账号。
        // reclaim 在"持有者是本节点"时直接重发租约，持有者是别的节点才拒绝。
        const lease = await leaseService.reclaim({
          accountId: row.channel_account_id,
          // 注意：租约用的是数据库自增 id，不是 node_key
          nodeId: databaseNodeId
        })
        accounts.push({
          accountId: lease.accountId,
          channel: row.channel,
          accountName: row.account_name,
          adapterId: row.adapter_id,
          generation: lease.generation,
          leaseToken: lease.leaseToken,
          expiresAt: lease.expiresAt instanceof Date ? lease.expiresAt.toISOString() : lease.expiresAt
        })
      } catch (error) {
        // 已有其它节点持租约时不该让整个 hello 失败，跳过并在日志里说明
        logger.warn(
          '[BridgeConfig] 账号 %s 取租约失败（%s），本次不下发',
          row.channel_account_id,
          error && error.code ? error.code : (error && error.message) || 'UNKNOWN'
        )
      }
    }

    return {
      accounts,
      heartbeatIntervalMs,
      leaseDurationMs,
      serverTime: new Date().toISOString(),
      nodeKey: nodeId
    }
  }
}

module.exports = { createBridgeConfigurationProvider, HEARTBEAT_INTERVAL_MS, LEASE_DURATION_MS }
