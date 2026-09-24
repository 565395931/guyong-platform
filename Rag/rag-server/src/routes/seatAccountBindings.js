/**
 * 坐席账号绑定管理 API
 *
 * 接口列表：
 * - POST   /api/v1/seat-bindings              绑定账号到坐席
 * - DELETE /api/v1/seat-bindings/:id           解绑账号
 * - GET    /api/v1/seat-bindings               查询绑定列表（支持筛选）
 * - GET    /api/v1/seat-bindings/available      查询可绑定的账号
 *
 * 认证：需要 JWT Token（admin/supervisor 权限）
 */

const express = require('express')
const router = express.Router()
const axios = require('axios')
const { Op } = require('sequelize')
const { User, ChannelAccount, SeatAccountBinding } = require('../models')
const { sequelize } = require('../config/database')
const { createAuthenticate, normalizeRole } = require('../middleware/authenticate')
const { parseWahaAccountConfig } = require('../shared/utils/wahaConfig')

// ========== 认证中间件 ==========
router.use(createAuthenticate(), (req, res, next) => {
  if (!['admin', 'supervisor'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: '无权限管理坐席绑定' })
  }
  return next()
})

// ========== 渠道元数据（便于前端展示）==========
const CHANNEL_META = {
  whatsapp: { label: 'WhatsApp', icon: 'Cellphone', color: '#25D366' },
  douyin: { label: '抖音', icon: 'VideoPlay', color: '#FE2C55' },
  wechat: { label: '微信', icon: 'ChatDotRound', color: '#07C160' }
}

function shouldSyncRealtime(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase())
}

function isSessionConnected(status) {
  return status === 'CONNECTED' || status === 'WORKING'
}

function extractAccountInfoFromSession(session) {
  if (!session || !session.me) {
    return { phoneNumber: null, whatsappName: null }
  }

  const me = session.me
  let phoneNumber = null
  if (me.id) {
    phoneNumber = String(me.id).replace(/@.*$/, '')
  } else if (me.wid) {
    phoneNumber = String(me.wid).replace(/@.*$/, '')
  }

  return {
    phoneNumber,
    whatsappName: me.pushName || me.name || me.PushName || null
  }
}

async function syncWahaAccountProfile(account, config) {
  const host = config.wahaInstanceUrl || config.host || (config.port ? `http://localhost:${config.port}` : null)
  const apiKey = config.apiKey || ''

  if (!host) {
    return { synced: false, status: 'UNKNOWN', reason: 'missing WAHA host' }
  }

  try {
    const client = axios.create({
      baseURL: host,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      timeout: 8000
    })
    const response = await client.get('/api/sessions')
    const sessions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean)
    const session = sessions[0] || null
    const rawStatus = session?.status || session?.Status || 'NO_SESSION'

    if (!session || !isSessionConnected(rawStatus)) {
      if (account.phone_number || account.whatsapp_name) {
        await account.update({ phone_number: null, whatsapp_name: null })
        account.phone_number = null
        account.whatsapp_name = null
      }
      return { synced: true, status: rawStatus, cleared: true }
    }

    const phoneInfo = extractAccountInfoFromSession(session)
    if (!phoneInfo.phoneNumber) {
      return { synced: false, status: rawStatus, reason: 'missing session.me phone' }
    }

    const nextWhatsappName = phoneInfo.whatsappName || null
    if (account.phone_number !== phoneInfo.phoneNumber || account.whatsapp_name !== nextWhatsappName) {
      await account.update({
        phone_number: phoneInfo.phoneNumber,
        whatsapp_name: nextWhatsappName
      })
      account.phone_number = phoneInfo.phoneNumber
      account.whatsapp_name = nextWhatsappName
    }

    return { synced: true, status: rawStatus, phoneNumber: phoneInfo.phoneNumber, whatsappName: nextWhatsappName }
  } catch (err) {
    return {
      synced: false,
      status: err.response?.status || err.code || 'ERROR',
      reason: err.response?.data?.message || err.response?.data?.error || err.message
    }
  }
}

// ========== 绑定账号到坐席 ==========
router.post('/', async (req, res) => {
  try {
    const { seat_id, account_id } = req.body

    if (!seat_id || !account_id) {
      return res.status(400).json({ success: false, message: 'seat_id 和 account_id 不能为空' })
    }

    // 校验坐席存在且角色为 agent 或 supervisor
    const seat = await User.findByPk(seat_id)
    if (!seat) {
      return res.status(404).json({ success: false, message: '坐席不存在' })
    }
    if (!['agent', 'supervisor'].includes(normalizeRole(seat.role))) {
      return res.status(400).json({ success: false, message: '该用户不是坐席角色，无法绑定账号' })
    }

    // 校验渠道账号存在且活跃
    const account = await ChannelAccount.findByPk(account_id)
    if (!account) {
      return res.status(404).json({ success: false, message: '渠道账号不存在' })
    }
    if (account.status !== 'active') {
      return res.status(400).json({ success: false, message: '该渠道账号不活跃，无法绑定' })
    }

    // 检查同一坐席是否已绑定该账号（防重复，不限制多坐席绑同一账号）
    const existingBinding = await SeatAccountBinding.findOne({
      where: { seat_id, account_id, status: 'active' }
    })
    if (existingBinding) {
      return res.status(400).json({ success: false, message: '该账号已绑定到此坐席' })
    }

    // 创建绑定
    const binding = await SeatAccountBinding.create({
      seat_id,
      account_id,
      channel: account.channel,
      status: 'active'
    })

    console.log(`[SeatBinding] 坐席 ${seat.username}(${seat_id}) 绑定 ${account.channel} 账号 ${account.account_name}(${account_id})`)

    let realtimeSync = null
    if (account.channel === 'whatsapp' && account.adapter_type === 'waha') {
      const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
      realtimeSync = await syncWahaAccountProfile(account, config)
    }

    // 查询该账号还被哪些坐席绑定（多选模式下展示）
    const [otherRows] = await sequelize.query(
      `SELECT sab.seat_id, u.username
       FROM seat_account_bindings sab
       LEFT JOIN users u ON u.id = sab.seat_id
       WHERE sab.account_id = :accountId AND sab.status = 'active' AND sab.seat_id != :seatId`,
      { replacements: { accountId: account_id, seatId: seat_id } }
    )
    const otherSeats = otherRows.map(r => ({ seat_id: r.seat_id, username: r.username || '未知' }))

    // 返回绑定信息（含账号基本信息）
    res.json({
      success: true,
      message: '账号绑定成功',
      data: {
        id: binding.id,
        binding_id: binding.id,
        seat_id: binding.seat_id,
        account_id: binding.account_id,
        channel: binding.channel,
        status: binding.status,
        account_name: account.account_name,
        phone_number: account.phone_number,
        whatsapp_name: account.whatsapp_name,
        realtime_sync: realtimeSync,
        also_bound_to: otherSeats,
        channel_meta: CHANNEL_META[account.channel] || { label: account.channel, icon: 'Connection', color: '#909399' }
      }
    })
  } catch (err) {
    console.error('[SeatBinding] 绑定失败:', err.message)
    res.status(500).json({ success: false, message: '绑定失败: ' + err.message })
  }
})

// ========== 解绑账号 ==========
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const binding = await SeatAccountBinding.findByPk(id)
    if (!binding) {
      return res.status(404).json({ success: false, message: '绑定记录不存在' })
    }

    // 将状态改为 inactive（软删除，保留历史记录）
    await binding.update({ status: 'inactive' })

    console.log(`[SeatBinding] 解绑: seat_id=${binding.seat_id}, account_id=${binding.account_id}, channel=${binding.channel}`)

    res.json({ success: true, message: '账号已解绑' })
  } catch (err) {
    console.error('[SeatBinding] 解绑失败:', err.message)
    res.status(500).json({ success: false, message: '解绑失败: ' + err.message })
  }
})

// ========== 查询绑定列表 ==========
router.get('/', async (req, res) => {
  try {
    const { seat_id, account_id, channel, status, sync } = req.query
    const realtimeSync = shouldSyncRealtime(sync)

    const where = { status: status || 'active' }
    if (seat_id) where.seat_id = seat_id
    if (account_id) where.account_id = account_id
    if (channel) where.channel = channel

    const bindings = await SeatAccountBinding.findAll({
      where,
      order: [['created_at', 'DESC']]
    })

    // 批量查询关联的账号信息
    const accountIds = bindings.map(b => b.account_id)
    const accounts = accountIds.length > 0
      ? await ChannelAccount.findAll({
        where: { id: accountIds },
        attributes: ['id', 'channel', 'account_name', 'config', 'status', 'adapter_type', 'phone_number', 'whatsapp_name']
      })
      : []

    const accountMap = {}
    for (const account of accounts) {
      if (realtimeSync && account.channel === 'whatsapp' && account.adapter_type === 'waha') {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
        await syncWahaAccountProfile(account, config)
      }
      const item = account.toJSON()
      delete item.config
      accountMap[item.id] = item
    }

    // 批量查询坐席信息
    const seatIds = bindings.map(b => b.seat_id)
    const seats = seatIds.length > 0
      ? await User.findAll({
        where: { id: seatIds },
        attributes: ['id', 'username', 'role']
      })
      : []

    const seatMap = {}
    seats.forEach(s => { seatMap[s.id] = s.toJSON() })

    const result = bindings.map(binding => {
      const b = binding.toJSON()
      const accountInfo = accountMap[b.account_id] || {}
      const seatInfo = seatMap[b.seat_id] || {}
      return {
        ...b,
        account_name: accountInfo.account_name || '',
        phone_number: accountInfo.phone_number || '',
        whatsapp_name: accountInfo.whatsapp_name || '',
        account_status: accountInfo.status || '',
        seat_username: seatInfo.username || '',
        channel_meta: CHANNEL_META[b.channel] || { label: b.channel, icon: 'Connection', color: '#909399' }
      }
    })

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[SeatBinding] 查询绑定列表失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 查询可绑定的账号（未被任何坐席绑定）==========
router.get('/available', async (req, res) => {
  try {
    const { channel, sync } = req.query
    const realtimeSync = shouldSyncRealtime(sync)

    // 多选模式：返回全部活跃账号，附带已被哪些坐席绑定的信息
    const where = { status: 'active' }
    if (channel) where.channel = channel

    const availableAccounts = await ChannelAccount.findAll({
      where,
      attributes: ['id', 'channel', 'account_name', 'config', 'status', 'adapter_type', 'phone_number', 'whatsapp_name'],
      order: [['created_at', 'DESC']]
    })

    // 批量查询每个账号已绑定的坐席
    const accountIds = availableAccounts.map(a => a.id)
    let bindingMap = {}
    if (accountIds.length > 0) {
      const [bindingRows] = await sequelize.query(
        `SELECT sab.account_id, sab.seat_id, u.username
         FROM seat_account_bindings sab
         LEFT JOIN users u ON u.id = sab.seat_id
         WHERE sab.account_id IN (:accountIds) AND sab.status = 'active'`,
        { replacements: { accountIds } }
      )
      for (const row of bindingRows) {
        if (!bindingMap[row.account_id]) bindingMap[row.account_id] = []
        bindingMap[row.account_id].push({ seat_id: row.seat_id, username: row.username || '未知' })
      }
    }

    // 解析 config 提取 sessionName/port（用于 WhatsApp 账号展示）
    const result = []
    for (const account of availableAccounts) {
      const item = account.toJSON()
      const config = parseWahaAccountConfig(item.config, `accountId=${item.id}`)

      let realtime = null
      if (realtimeSync && item.channel === 'whatsapp' && item.adapter_type === 'waha') {
        realtime = await syncWahaAccountProfile(account, config)
        item.phone_number = account.phone_number || null
        item.whatsapp_name = account.whatsapp_name || null
      }

      item.sessionName = config.sessionName || null
      item.port = config.port || null
      delete item.config
      item.channel_meta = CHANNEL_META[item.channel] || { label: item.channel, icon: 'Connection', color: '#909399' }
      item.bound_to = bindingMap[item.id] || []
      if (realtimeSync) {
        item.realtime_sync = realtime
      }
      result.push(item)
    }

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[SeatBinding] 查询可绑定账号失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

module.exports = router
