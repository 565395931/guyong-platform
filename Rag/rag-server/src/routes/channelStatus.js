/**
 * 多渠道连接状态 API
 *
 * GET /api/v1/channels/status
 * 认证：任意有效 JWT（agent/supervisor/admin 均可访问）
 * 返回所有已配置渠道的连接状态摘要，WhatsApp 提供实时 session 级别状态。
 */

const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const { sequelize } = require('../config/database')
const registry = require('../modules/waha-registry')

const JWT_SECRET = process.env.JWT_SECRET || 'rag_secret_key_2024_dev_only'

const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  wecom_kf: '微信客服',
  douyin: '抖店',
  pinduoduo: '拼多多',
  taobao: '淘宝',
  alibaba1688: '1688'
}

router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ success: false, message: '未提供认证令牌' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

async function getWahaSessionStatuses() {
  const instances = registry.getAllInstances()
  const sessions = []
  await Promise.all(instances.map(async (inst) => {
    try {
      const client = registry.createClient(inst)
      const res = await client.get('/api/sessions', { timeout: 4000 })
      const list = Array.isArray(res.data) ? res.data : []
      for (const s of list) {
        sessions.push({
          sessionName: s.name || s.sessionName || inst.containerName,
          status: s.status || 'UNKNOWN',
          phone: s.me?.id?.replace('@c.us', '') || '',
          displayName: s.me?.pushName || s.me?.name || ''
        })
      }
    } catch (_e) {
      sessions.push({ sessionName: inst.containerName, status: 'OFFLINE', phone: '', displayName: '' })
    }
  }))
  return sessions
}

/**
 * @param accountRows 按渠道聚合的账号行
 * @param sessions    WAHA 会话（null 表示这次没取到，不能据此判异常）
 * @param desktopBridge 桌面桥接渠道的健康情况 `{ douyin: true }`；
 *        不传就不判（老调用方/测试只关心 WhatsApp，行为不变）。
 *        桌面桥接没有"会话列表"可查，唯一的信号是**有没有节点持有有效租约**：
 *        节点每 15 秒续租一次，租约过期即视为掉线。
 */
function buildChannelStatusSummary(accountRows, sessions, desktopBridge = null) {
  const channels = []
  let overall = accountRows.length === 0 ? 'UNKNOWN' : 'HEALTHY'

  for (const row of accountRows) {
    const ch = {
      channel: row.channel,
      label: CHANNEL_LABELS[row.channel] || row.channel,
      accountCount: Number(row.account_count),
      status: 'ACTIVE'
    }

    if (row.channel === 'whatsapp' && sessions !== null) {
      const connected = sessions.filter(s => s.status === 'WORKING' || s.status === 'CONNECTED').length
      const total = sessions.length
      if (total === 0) {
        ch.status = 'UNKNOWN'
        if (overall === 'HEALTHY') overall = 'WARNING'
      } else if (connected === 0) {
        ch.status = 'OFFLINE'
        overall = 'CRITICAL'
      } else if (connected < total) {
        ch.status = 'PARTIAL'
        if (overall === 'HEALTHY') overall = 'WARNING'
      } else {
        ch.status = 'CONNECTED'
      }
      ch.sessions = sessions.map(s => ({
        name: s.displayName || s.phone || s.sessionName,
        status: s.status,
        phone: s.phone
      }))
    }

    // 桌面桥接（抖店等本地客户端账号）：没有节点持有有效租约 = 连不上 = 异常
    if (desktopBridge && Object.prototype.hasOwnProperty.call(desktopBridge, row.channel)) {
      const healthy = desktopBridge[row.channel]
      ch.status = healthy ? 'CONNECTED' : 'OFFLINE'
      if (!healthy) overall = 'CRITICAL'
    }

    channels.push(ch)
  }

  return { overall, channels }
}

/**
 * 桌面桥接渠道是否有节点在线：按"渠道是否有未过期的租约"判断。
 * 节点每 15 秒心跳续租，租约过期就说明节点掉线了（连不上）。
 */
async function getDesktopBridgeHealth() {
  const [rows] = await sequelize.query(
    `SELECT a.channel,
            SUM(CASE WHEN l.expires_at > NOW(3) AND n.disabled_at IS NULL THEN 1 ELSE 0 END) AS live_leases
       FROM channel_accounts a
       LEFT JOIN desktop_bridge_leases l ON l.channel_account_id = a.id
       LEFT JOIN desktop_bridge_nodes n ON n.id = l.node_id
      WHERE a.status = 'active' AND a.adapter_type = 'desktop_bridge'
      GROUP BY a.channel`
  )
  const health = {}
  for (const row of rows) {
    health[row.channel] = Number(row.live_leases || 0) > 0
  }
  return health
}

router.get('/', async (req, res) => {
  try {
    const [accountRows] = await sequelize.query(
      `SELECT channel, COUNT(*) AS account_count FROM channel_accounts WHERE status = 'active' GROUP BY channel ORDER BY channel`
    )

    let waSessions = null
    if (accountRows.some(r => r.channel === 'whatsapp')) {
      try {
        waSessions = await getWahaSessionStatuses()
      } catch (_e) {
        waSessions = []
      }
    }

    // 桌面桥接渠道（抖店本地客户端）没有"会话"可查，只能看有没有节点持租约。
    // 查询本身已按 adapter_type 过滤，没这类账号时返回空对象，不影响其它渠道。
    let desktopBridge = null
    try {
      desktopBridge = await getDesktopBridgeHealth()
    } catch (err) {
      // 查不到就不判异常：宁可漏报，也不要因为一次查询失败就把抖店标成"连不上"闪红光
      console.error('[ChannelStatus] 桌面桥接健康检查失败:', err.message)
      desktopBridge = null
    }

    res.json({ success: true, data: buildChannelStatusSummary(accountRows, waSessions, desktopBridge) })
  } catch (err) {
    console.error('[ChannelStatus] failed:', err)
    res.status(500).json({ success: false, message: '查询渠道状态失败: ' + err.message })
  }
})

module.exports = router
module.exports.buildChannelStatusSummary = buildChannelStatusSummary
