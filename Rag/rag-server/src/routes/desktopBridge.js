const express = require('express')
const { createAuthenticate } = require('../middleware/authenticate')
const { sequelize } = require('../config/database')
const { QueryTypes } = require('sequelize')
const { createBridgeRepository } = require('../modules/desktop-bridge/bridgeRepository')

const router = express.Router()

// ========== 认证中间件 ==========
router.use(createAuthenticate(), (req, res, next) => {
  if (!['admin', 'supervisor'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: '无权限管理桌面节点' })
  }
  return next()
})

function bridgeRepository() {
  return createBridgeRepository(sequelize)
}

/**
 * 为同机节点签发凭据（免配对码）。
 *
 * 配对码是给"另一台电脑上的节点"用的：网页生成码 → 那台机器输入。后端与飞鸽
 * 客户端同机时没有第二设备，这一步是多余的，所以直接签发。
 *
 * 返回的 enrollmentToken **只在本次响应里出现一次**，服务端只存它的 SHA-256。
 * 节点拿 nodeKey + enrollmentToken 去连 /bridge/v1 发 node.hello。
 */
router.post('/provision', async (req, res) => {
  try {
    const {
      machineFingerprint,
      displayName,
      version = '1.0.0',
      adapterIds = [],
      capabilities = {}
    } = req.body || {}

    if (!machineFingerprint) {
      return res.status(400).json({ success: false, message: 'machineFingerprint 必填' })
    }

    const result = await bridgeRepository().provisionNode({
      machineFingerprint,
      displayName,
      version,
      adapterIds,
      capabilities,
      actorId: req.user && req.user.id ? req.user.id : null
    })

    return res.json({
      success: true,
      data: {
        nodeId: result.nodeId,
        nodeKey: result.nodeKey,
        enrollmentToken: result.enrollmentToken,
        rotated: result.rotated,
        bridgePath: '/bridge/v1',
        warning: result.rotated
          ? '该机器已有节点，凭据已轮换，旧 token 立即失效'
          : '请在节点进程中以环境变量保存该 token，它不会再次显示'
      }
    })
  } catch (error) {
    const code = error && error.code
    if (code === 'PROVISION_INVALID_FINGERPRINT' || code === 'PROVISION_INVALID_VERSION') {
      return res.status(400).json({ success: false, message: error.message, code })
    }
    console.error('[DesktopBridge] provision 失败:', error.message)
    return res.status(500).json({ success: false, message: '签发节点凭据失败', detail: error.message })
  }
})

/** 节点列表：用于确认节点是否上线、绑了哪些账号。 */
router.get('/nodes', async (req, res) => {
  try {
    const nodes = await sequelize.query(
      `SELECT id, node_key, display_name, agent_version, status,
              last_seen_at, disabled_at, created_at
         FROM desktop_bridge_nodes
        ORDER BY id ASC`,
      { type: QueryTypes.SELECT }
    )
    const bindings = await sequelize.query(
      `SELECT b.channel_account_id, b.adapter_id, b.mode, b.enabled, b.preferred_node_id,
              a.channel, a.account_name
         FROM desktop_bridge_bindings b
         LEFT JOIN channel_accounts a ON a.id = b.channel_account_id
        ORDER BY b.channel_account_id ASC`,
      { type: QueryTypes.SELECT }
    )
    const leases = await sequelize.query(
      `SELECT channel_account_id, node_id, generation, expires_at, heartbeat_at
         FROM desktop_bridge_leases
        ORDER BY channel_account_id ASC`,
      { type: QueryTypes.SELECT }
    )

    // node_key 是节点凭据的一半，列表里不回传，只回传 id
    const safeNodes = nodes.map(node => ({
      id: node.id,
      displayName: node.display_name,
      agentVersion: node.agent_version,
      status: node.status,
      lastSeenAt: node.last_seen_at,
      disabled: Boolean(node.disabled_at),
      createdAt: node.created_at
    }))

    return res.json({
      success: true,
      data: {
        nodes: safeNodes,
        bindings: bindings.map(row => ({
          channelAccountId: row.channel_account_id,
          channel: row.channel,
          accountName: row.account_name,
          adapterId: row.adapter_id,
          mode: row.mode,
          enabled: Boolean(row.enabled),
          preferredNodeId: row.preferred_node_id
        })),
        leases: leases.map(row => ({
          channelAccountId: row.channel_account_id,
          nodeId: row.node_id,
          generation: Number(row.generation),
          expiresAt: row.expires_at,
          heartbeatAt: row.heartbeat_at
        }))
      }
    })
  } catch (error) {
    console.error('[DesktopBridge] 查询节点失败:', error.message)
    return res.status(500).json({ success: false, message: '查询节点失败', detail: error.message })
  }
})

module.exports = router
