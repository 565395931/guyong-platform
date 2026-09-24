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

function buildChannelStatusSummary(accountRows, sessions) {
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

    channels.push(ch)
  }

  return { overall, channels }
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

    res.json({ success: true, data: buildChannelStatusSummary(accountRows, waSessions) })
  } catch (err) {
    console.error('[ChannelStatus] failed:', err)
    res.status(500).json({ success: false, message: '查询渠道状态失败: ' + err.message })
  }
})

module.exports = router
module.exports.buildChannelStatusSummary = buildChannelStatusSummary
