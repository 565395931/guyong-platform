const express = require('express')
const router = express.Router()
const axios = require('axios')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const path = require('path')
const registry = require('../modules/waha-registry')
const { ChannelAccount } = require('../models')
const { sequelize } = require('../config/database')
const { parseWahaAccountConfig } = require('../shared/utils/wahaConfig')

const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'
const COMPOSE_PATH = path.join(__dirname, '..', '..', '..', 'docker', 'waha', 'docker-compose.yml')
const RECEIVE_STALE_MINUTES = Number.parseInt(process.env.WAHA_RECEIVE_STALE_MINUTES || '360', 10)
const DEFAULT_WAHA_ENGINE = String(process.env.WAHA_ENGINE || 'gows').trim().toLowerCase() === 'webjs' ? 'webjs' : 'gows'

// ========== WAHA 状态辅助函数 ==========
function isSessionConnected(status) {
  return status === 'CONNECTED' || status === 'WORKING'
}

function normalizeStatus(rawStatus) {
  if (!rawStatus) return 'UNKNOWN'
  const map = {
    WORKING: 'CONNECTED',
    SCAN_QR_CODE: 'SCAN_QR'
  }
  return map[rawStatus] || rawStatus
}

function addDiagnostic(item, severity, type, message, hint) {
  item.diagnostics.push({ severity, type, message, hint })
}

function readComposeEnvByPort() {
  const result = { available: false, byPort: new Map() }

  try {
    if (!fs.existsSync(COMPOSE_PATH)) return result

    const content = fs.readFileSync(COMPOSE_PATH, 'utf-8')
    const serviceRegex = /waha-(\d+):[\s\S]*?ports:\s*\n\s*-\s*"(\d+):3000"[\s\S]*?environment:\s*\n((?:\s+-\s+[^\n]+\n|\s+#\s*[^\n]+\n)+)/g
    let match

    while ((match = serviceRegex.exec(content)) !== null) {
      const port = Number.parseInt(match[2], 10)
      const envBlock = match[3] || ''
      const env = {}

      envBlock.split(/\r?\n/).forEach(line => {
        const envMatch = line.match(/^\s*-\s*([A-Z0-9_]+)=(.*)$/)
        if (envMatch) {
          env[envMatch[1]] = envMatch[2].trim()
        }
      })

      result.byPort.set(port, env)
    }

    result.available = true
  } catch (err) {
    console.warn('[WAHA Proxy] read compose env failed:', err.message)
  }

  return result
}

function parseWebhookAccountId(hookUrl) {
  if (!hookUrl) return null

  try {
    const url = new URL(hookUrl)
    const parsed = Number.parseInt(url.searchParams.get('account_id'), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    const match = String(hookUrl).match(/[?&]account_id=(\d+)/)
    return match ? Number.parseInt(match[1], 10) : null
  }
}

async function loadActiveAccountsByPort() {
  const accounts = await ChannelAccount.findAll({
    where: { channel: 'whatsapp', adapter_type: 'waha', status: 'active' }
  })
  const byPort = new Map()

  for (const account of accounts) {
    const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
    if (config.port) {
      byPort.set(Number(config.port), { account, config })
    }
  }

  return byPort
}

async function loadLastInboundByAccountId() {
  try {
    const [rows] = await sequelize.query(
      `SELECT account_id, MAX(created_at) AS last_inbound_at
         FROM plat_messages
        WHERE channel = 'whatsapp'
          AND direction = 'inbound'
          AND account_id IS NOT NULL
        GROUP BY account_id`
    )

    return new Map(rows.map(row => [Number(row.account_id), row.last_inbound_at]))
  } catch (err) {
    console.warn('[WAHA Proxy] load last inbound failed:', err.message)
    return new Map()
  }
}

// ========== 错误分类函数 ==========
function classifyWahaError(err) {
  if (!err) return { type: 'UNKNOWN', message: '未知错误' }

  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
    return { type: 'WAHA_OFFLINE', message: 'WAHA 容器无法访问，请检查 Docker 容器是否正在运行' }
  }

  if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
    return { type: 'TIMEOUT', message: '请求 WAHA 超时，可能是容器正在启动或网络不稳定' }
  }

  const status = err.response?.status
  const responseData = err.response?.data

  if (status === 409) {
    return { type: 'SESSION_CONFLICT', message: 'Session 冲突：容器中已存在残留的旧 session，正在自动清理...' }
  }

  if (status === 401 || status === 403) {
    return { type: 'AUTH_ERROR', message: 'WAHA API Key 不匹配，请检查 .env 配置与 docker-compose.yml 是否一致' }
  }

  if (status === 404) {
    return { type: 'ENDPOINT_NOT_FOUND', message: 'WAHA API 端点不存在，可能是 WAHA 版本不兼容' }
  }

  if (status === 422) {
    return { type: 'SESSION_NOT_READY', message: 'Session 尚未连接，无法执行此操作' }
  }

  if (status >= 500) {
    const errMsg = typeof responseData === 'string' ? responseData : responseData?.message || responseData?.error || ''
    if (errMsg.includes('proxy') || errMsg.includes('Proxy') || errMsg.includes('connect ECONNREFUSED')) {
      return { type: 'PROXY_ERROR', message: '代理连接失败，WhatsApp 服务器无法访问。请检查代理配置（WHATSAPP_PROXY_SERVER）' }
    }
    return { type: 'WAHA_SERVER_ERROR', message: `WAHA 服务器错误: ${errMsg || err.message}` }
  }

  return { type: 'WAHA_ERROR', message: err.message || 'WAHA 请求失败' }
}

// ========== 辅助函数：从 session 对象提取 WhatsApp 账号信息 ==========
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
  const whatsappName = me.pushName || me.name || me.PushName || null
  return { phoneNumber, whatsappName }
}

async function syncAccountProfile(account, phoneInfo) {
  if (!account || !phoneInfo?.phoneNumber) return false

  const nextPhoneNumber = phoneInfo.phoneNumber
  const nextWhatsappName = phoneInfo.whatsappName || null
  const currentPhoneNumber = account.phone_number || null
  const currentWhatsappName = account.whatsapp_name || null

  if (currentPhoneNumber === nextPhoneNumber && currentWhatsappName === nextWhatsappName) {
    return false
  }

  await account.update({
    phone_number: nextPhoneNumber,
    whatsapp_name: nextWhatsappName
  })

  console.log(
    `[WAHA Proxy] 已同步账号信息(accountId=${account.id}): ${currentPhoneNumber || '-'} -> ${nextPhoneNumber}, ${currentWhatsappName || '-'} -> ${nextWhatsappName || '-'}`
  )

  return true
}

// ========== 辅助函数：获取 WAHA 上的实际 session ==========
async function getActualSession(client) {
  try {
    const response = await client.get('/api/sessions')
    const sessions = response.data || []
    if (sessions.length > 0) {
      return sessions[0]
    }
  } catch {
    // 忽略
  }
  return null
}

// ========== 辅助函数：根据 accountId / sessionName 解析账号与实例绑定 ==========
function parseOptionalAccountId(rawValue) {
  const parsed = Number.parseInt(rawValue, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

async function resolveAccountBinding({ accountId, sessionName }) {
  if (accountId) {
    const result = await registry.resolveByAccountId(accountId)
    if (!result) return null
    return result // { instance, account }
  }

  if (!sessionName) return null
  return registry.resolveBySessionName(sessionName)
}

// ========== 认证中间件 ==========
router.use((req, res, next) => {
  if (req.path === '/health-status' || req.path === '/health') {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }
    try {
      const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
      req.user = decoded
      return next()
    } catch (err) {
      return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
    }
  }

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    req.user = decoded
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可操作 WAHA session' })
    }
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

// ========== 获取所有实例状态 ==========
router.get('/instances', async (req, res) => {
  try {
    const instances = registry.getAllInstances()
    const instancesWithStatus = []

    for (const instance of instances) {
      let status = 'unknown'
      let available = false

      try {
        const client = registry.createClient(instance)
        const response = await client.get('/api/sessions')
        status = 'online'
        available = response.data.length === 0 ||
                   (response.data.length === 1 && response.data[0].status === 'DISCONNECTED')
      } catch (err) {
        status = err.response ? 'online' : 'offline'
      }

      instancesWithStatus.push({ ...instance, status, available })
    }

    res.json({ success: true, data: instancesWithStatus })
  } catch (err) {
    console.error('[WAHA Proxy] 获取实例状态失败:', err.message)
    res.status(500).json({ success: false, message: '获取实例状态失败' })
  }
})

// ========== 创建 session ==========
router.post('/sessions', async (req, res) => {
  try {
    const instance = await registry.getAvailableInstance()
    if (!instance) {
      return res.status(400).json({
        success: false,
        message: '无可用 WAHA 实例，请先增加 WAHA 容器'
      })
    }

    console.log('[WAHA Proxy] 使用实例:', instance.host)

    // 使用 Registry 统一启动（不传 accountId，因为此时还没创建 channel_account）
    const sessionResult = await registry.startSession(instance, null, { skipWebhook: true })

    if (!sessionResult.success) {
      return res.status(500).json({
        success: false,
        message: sessionResult.error.message,
        errorType: sessionResult.error.type
      })
    }

    res.json({
      success: true,
      message: 'Session 已启动',
      data: {
        sessionName: 'default',
        instance: { port: instance.port, host: instance.host },
        raw: sessionResult.data || { name: 'default', status: 'STARTING' }
      }
    })
  } catch (err) {
    console.error('[WAHA Proxy] 创建 session 失败:', err.message)
    res.status(500).json({ success: false, message: '创建 session 失败: ' + err.message })
  }
})

// ========== 获取二维码 ==========
const QR_MAX_RETRIES = 5
const QR_RETRY_INTERVAL = 2000

router.get('/sessions/:sessionName/qr', async (req, res) => {
  try {
    const { sessionName } = req.params
    const accountId = parseOptionalAccountId(req.query.accountId)

    const result = await resolveAccountBinding({ accountId, sessionName })
    if (!result) {
      return res.status(404).json({ success: false, message: '未找到对应实例' })
    }

    const { instance, account } = result
    const client = registry.createClient(instance)

    console.log('[WAHA Proxy] 获取二维码，实例:', instance.host)

    let session = await getActualSession(client)

    if (!session) {
      // 没有 session，启动一个新的（传入 webhook 配置）
      console.log('[WAHA Proxy] 无 session，正在启动...')
      const startResult = await registry.startSession(instance, account?.id)
      if (!startResult.success) {
        return res.json({
          success: true,
          data: { qr: null, message: startResult.error.message, errorType: startResult.error.type }
        })
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
      session = await getActualSession(client)
    } else if (isSessionConnected(session.status)) {
      return res.json({ success: true, data: { qr: null, message: '已连接，无需扫码' } })
    }

    const actualSessionName = session?.name || session?.Name || 'default'
    console.log(`[WAHA Proxy] 实际 session 名: "${actualSessionName}", 状态: ${session?.status}`)

    let qrData = null
    for (let attempt = 1; attempt <= QR_MAX_RETRIES; attempt++) {
      try {
        const response = await client.get(`/api/${actualSessionName}/auth/qr`, {
          responseType: 'arraybuffer',
          params: { format: 'image' }
        })
        if (response.data && response.data.length > 0) {
          const base64 = Buffer.from(response.data).toString('base64')
          qrData = { qr: `data:image/png;base64,${base64}` }
          console.log(`[WAHA Proxy] 二维码已获取 (第${attempt}次尝试)`)
          break
        }
      } catch {
        // QR 还没生成，继续重试
      }

      const currentSession = await getActualSession(client)
      if (isSessionConnected(currentSession?.status)) {
        return res.json({ success: true, data: { qr: null, message: '已连接，无需扫码' } })
      }

      if (attempt < QR_MAX_RETRIES) {
        console.log(`[WAHA Proxy] 二维码未就绪 (状态: ${currentSession?.status || 'unknown'})，${QR_RETRY_INTERVAL / 1000}秒后重试 (${attempt}/${QR_MAX_RETRIES})`)
        await new Promise(resolve => setTimeout(resolve, QR_RETRY_INTERVAL))
      }
    }

    if (!qrData || !qrData.qr) {
      return res.json({ success: true, data: { qr: null, message: '二维码生成中，请稍后刷新' } })
    }

    res.json({ success: true, data: { qr: qrData.qr } })
  } catch (err) {
    console.error('[WAHA Proxy] 获取二维码失败:', err.message)
    res.json({ success: true, data: { qr: null, message: '二维码生成中，请稍后刷新' } })
  }
})

// ========== 获取 session 状态 ==========
router.get('/sessions/:sessionName/status', async (req, res) => {
  try {
    const { sessionName } = req.params
    const accountId = parseOptionalAccountId(req.query.accountId)

    const result = await resolveAccountBinding({ accountId, sessionName })
    if (!result) {
      return res.json({ success: true, data: { sessionName, status: 'UNKNOWN', raw: null } })
    }

    const { instance, account } = result
    const client = registry.createClient(instance)

    const session = await getActualSession(client)

    if (!session) {
      return res.json({ success: true, data: { sessionName, status: 'NOT_FOUND', raw: null } })
    }

    const rawStatus = session.status || session.Status || 'STARTING'
    const status = normalizeStatus(rawStatus)

    let phoneInfo = null
    if (isSessionConnected(rawStatus)) {
      phoneInfo = extractAccountInfoFromSession(session)

      if (phoneInfo.phoneNumber && account) {
        try {
          await syncAccountProfile(account, phoneInfo)
        } catch (dbErr) {
          console.warn('[WAHA Proxy] 更新账号信息失败:', dbErr.message)
        }
      }
    }

    res.json({
      success: true,
      data: {
        sessionName,
        status,
        engine: instance.engine || DEFAULT_WAHA_ENGINE,
        raw: session,
        phone: phoneInfo?.phoneNumber || account?.phone_number || null,
        whatsappName: phoneInfo?.whatsappName || account?.whatsapp_name || null
      }
    })
  } catch (err) {
    console.error('[WAHA Proxy] 获取状态失败:', err.message)
    res.json({
      success: true,
      data: { sessionName: req.params.sessionName, status: 'UNKNOWN', raw: null }
    })
  }
})

// ========== 重启 session（始终传入 webhook 配置）==========
router.post('/sessions/:sessionName/restart', async (req, res) => {
  try {
    const { sessionName } = req.params
    const accountId = parseOptionalAccountId(req.query.accountId)

    const result = await resolveAccountBinding({ accountId, sessionName })
    if (!result) {
      return res.status(404).json({ success: false, message: '未找到对应实例' })
    }

    const { instance, account } = result
    console.log(`[WAHA Proxy] 重启 session: ${instance.containerName} (accountId=${account?.id})`)

    // 使用 Registry 统一重启（始终传入 webhook，防止重启后消息收不到）
    const startResult = await registry.startSession(instance, account?.id)

    if (!startResult.success) {
      return res.status(500).json({
        success: false,
        message: startResult.error.message,
        errorType: startResult.error.type
      })
    }

    res.json({
      success: true,
      message: 'Session 已重启',
      data: startResult.data || { name: 'default', status: 'STARTING' }
    })
  } catch (err) {
    console.error('[WAHA Proxy] 重启失败:', err.message)
    res.status(500).json({ success: false, message: '重启失败: ' + err.message })
  }
})

// ========== 删除 session ==========
router.delete('/sessions/:sessionName', async (req, res) => {
  try {
    const { sessionName } = req.params
    const accountId = parseOptionalAccountId(req.query.accountId)

    const result = await resolveAccountBinding({ accountId, sessionName })
    if (result) {
      const { instance } = result
      const client = registry.createClient(instance)

      // 清理所有 session
      try {
        const response = await client.get('/api/sessions')
        const sessions = response.data || []
        for (const session of sessions) {
          const name = session.name || session.Name
          if (name) {
            try { await client.post(`/api/sessions/${name}/stop`) } catch { /* 忽略 */ }
            try { await client.delete(`/api/sessions/${name}`) } catch { /* 忽略 */ }
            console.log(`[WAHA Proxy] 已清理 session: ${name}`)
          }
        }
      } catch {
        // 忽略
      }
    }

    res.json({ success: true, message: 'Session 已删除' })
  } catch (err) {
    console.error('[WAHA Proxy] 删除失败:', err.message)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

// ========== 健康检查 ==========
router.get('/health', async (req, res) => {
  const instances = registry.getAllInstances()
  let totalOnline = 0

  for (const instance of instances) {
    try {
      const client = registry.createClient(instance)
      await client.get('/api/sessions', { timeout: 3000 })
      totalOnline++
    } catch {
      // 忽略
    }
  }

  res.json({
    success: true,
    data: { status: 'ok', totalInstances: instances.length, onlineInstances: totalOnline }
  })
})

// ========== 详细健康状态 API ==========
let _healthStatusCache = null
const HEALTH_CACHE_TTL_MS = 10 * 1000

router.get('/health-status', async (req, res) => {
  if (_healthStatusCache && Date.now() - _healthStatusCache.timestamp < HEALTH_CACHE_TTL_MS) {
    return res.json({ success: true, data: _healthStatusCache.data })
  }

  const instances = registry.getAllInstances()
  const composeEnv = readComposeEnvByPort()
  const accountsByPort = await loadActiveAccountsByPort()
  const lastInboundByAccountId = await loadLastInboundByAccountId()
  const backendProxyConfigured = Boolean(process.env.WHATSAPP_PROXY_SERVER)
  const staleMinutes = Number.isInteger(RECEIVE_STALE_MINUTES) && RECEIVE_STALE_MINUTES > 0 ? RECEIVE_STALE_MINUTES : 360

  const results = await Promise.all(instances.map(async (instance, idx) => {
    const accountBinding = accountsByPort.get(Number(instance.port))
    const account = accountBinding?.account || null
    const instanceEnv = composeEnv.byPort.get(Number(instance.port)) || {}
    const actualWebhookUrl = instanceEnv.WHATSAPP_HOOK_URL || null
    const actualWebhookEvents = instanceEnv.WHATSAPP_HOOK_EVENTS || null
    const actualWebhookAccountId = parseWebhookAccountId(actualWebhookUrl)
    const expectedWebhookUrl = account ? registry.buildWebhookConfig(account.id)?.url || null : null
    const containerProxyConfigured = Boolean(instanceEnv.WHATSAPP_PROXY_SERVER)

    const item = {
      containerName: instance.containerName || `waha-${idx + 1}`,
      host: instance.host,
      port: instance.port,
      engine: instance.engine || DEFAULT_WAHA_ENGINE,
      accountId: account?.id || null,
      accountName: account?.account_name || null,
      status: 'OFFLINE',
      sessionName: null,
      phoneNumber: null,
      whatsappName: null,
      error: null,
      diagnostics: [],
      proxyConfigured: containerProxyConfigured || backendProxyConfigured,
      backendProxyConfigured,
      containerProxyConfigured,
      webhookConfigured: Boolean(actualWebhookUrl),
      webhookAccountId: actualWebhookAccountId,
      expectedWebhookUrl,
      actualWebhookUrl,
      lastInboundAt: account ? lastInboundByAccountId.get(Number(account.id)) || null : null,
      receiveStaleMinutes: staleMinutes,
      checkedAt: new Date().toISOString()
    }

    if (composeEnv.available && !containerProxyConfigured) {
      addDiagnostic(
        item,
        'warning',
        'PROXY_NOT_CONFIGURED',
        '未检测到 WAHA 容器代理配置；在大陆网络下 WhatsApp 可能无法收发消息。',
        '请在 docker/waha/docker-compose.yml 或生成配置中设置 WHATSAPP_PROXY_SERVER，然后重建 WAHA 容器。'
      )
    } else if (!composeEnv.available && !backendProxyConfigured) {
      addDiagnostic(
        item,
        'warning',
        'PROXY_UNKNOWN',
        '无法确认 WAHA 代理配置。',
        '请确认 WAHA 容器已配置 WHATSAPP_PROXY_SERVER。'
      )
    }

    if (account) {
      if (!actualWebhookUrl) {
        addDiagnostic(
          item,
          'critical',
          'WEBHOOK_MISSING',
          '未检测到 WAHA webhook URL，入站 WhatsApp 消息无法进入后端。',
          `请为端口 ${instance.port} 配置带 account_id=${account.id} 的 WHATSAPP_HOOK_URL，然后重建 WAHA 容器。`
        )
      } else if (actualWebhookAccountId !== Number(account.id)) {
        addDiagnostic(
          item,
          'critical',
          'WEBHOOK_ACCOUNT_MISMATCH',
          `WAHA webhook account_id=${actualWebhookAccountId || '-'} 与当前绑定账号 account_id=${account.id} 不一致，消息可能进错账号。`,
          `请把端口 ${instance.port} 的 WHATSAPP_HOOK_URL 改为 account_id=${account.id}，然后重建 WAHA 容器。`
        )
      }

      if (actualWebhookUrl && actualWebhookEvents && !String(actualWebhookEvents).split(',').map(e => e.trim()).includes('message')) {
        addDiagnostic(
          item,
          'critical',
          'WEBHOOK_MESSAGE_EVENT_MISSING',
          'WAHA webhook 已配置，但未启用 message 事件。',
          '请设置 WHATSAPP_HOOK_EVENTS=message。'
        )
      }

      if (!item.lastInboundAt) {
        addDiagnostic(
          item,
          'warning',
          'NO_INBOUND_SEEN',
          '该账号还没有记录到任何 WhatsApp 入站消息。',
          '请向该账号发送一条测试消息后刷新状态。'
        )
      } else {
        const lastInboundTime = new Date(item.lastInboundAt).getTime()
        const silentMinutes = Math.floor((Date.now() - lastInboundTime) / 60000)
        item.receiveSilenceMinutes = silentMinutes

        if (silentMinutes >= staleMinutes) {
          addDiagnostic(
            item,
            'warning',
            'INBOUND_STALE',
            `已 ${silentMinutes} 分钟没有记录到 WhatsApp 入站消息。`,
            '如果刚刚发过测试消息，请检查代理、WAHA 日志和 WHATSAPP_HOOK_URL。'
          )
        }
      }
    } else {
      addDiagnostic(
        item,
        'warning',
        'ACCOUNT_NOT_BOUND',
        '该 WAHA 实例未绑定活跃 WhatsApp 账号。',
        '需要先在 WhatsApp 账号管理中创建或绑定账号。'
      )
    }

    try {
      const client = registry.createClient(instance)
      const response = await client.get('/api/sessions', { timeout: 5000 })
      const sessions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean)

      if (sessions.length === 0) {
        item.status = 'NO_SESSION'
        item.error = '无 session（需创建并扫码）'
      } else {
        const session = sessions[0]
        item.sessionName = session.name || 'default'
        item.status = normalizeStatus(session.status)

        if (session.me) {
          item.phoneNumber = session.me.id ? String(session.me.id).replace(/@.*$/, '') : null
          item.whatsappName = session.me.pushName || null
        }

        if (!isSessionConnected(session.status)) {
          addDiagnostic(
            item,
            'warning',
            'SESSION_NOT_CONNECTED',
            `WAHA session 当前状态为 ${item.status}，可能无法接收消息。`,
            '请在 WhatsApp 账号管理中刷新状态或重新扫码。'
          )
        }
      }
    } catch (err) {
      item.error = err.code === 'ECONNREFUSED' ? '容器无法访问' : (err.message || '未知错误')
      item.status = 'OFFLINE'
    }

    item.canReceiveMessages = item.status === 'CONNECTED' && !item.diagnostics.some(d => d.severity === 'critical')

    return item
  }))

  const allConnected = results.length > 0 && results.every(r => r.status === 'CONNECTED')
  const anyOffline = results.some(r => r.status === 'OFFLINE')
  const hasCritical = results.some(r => r.diagnostics.some(d => d.severity === 'critical'))
  const hasWarning = results.some(r => r.diagnostics.some(d => d.severity === 'warning'))

  const data = {
    overall: results.length === 0 ? 'UNKNOWN' : ((anyOffline || hasCritical) ? 'CRITICAL' : (allConnected && !hasWarning ? 'HEALTHY' : 'WARNING')),
    instances: results,
    totalInstances: results.length,
    connectedInstances: results.filter(r => r.status === 'CONNECTED').length,
    receiveStaleMinutes: staleMinutes
  }

  _healthStatusCache = { data, timestamp: Date.now() }
  res.json({ success: true, data })
})

module.exports = router
