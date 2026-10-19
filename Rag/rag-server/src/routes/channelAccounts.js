/**
 * 渠道账号管理 API
 *
 * 接口列表：
 * - POST   /api/v1/channel-accounts        绑定渠道账号
 * - GET    /api/v1/channel-accounts         查询账号列表
 * - GET    /api/v1/channel-accounts/:id     查询单个账号
 * - DELETE /api/v1/channel-accounts/:id     解绑账号
 *
 * 认证：需要 JWT Token（admin 权限）
 */

const express = require('express')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const router = express.Router()
const { createAuthenticate } = require('../middleware/authenticate')
const { ChannelAccount } = require('../models')
const { sequelize } = require('../config/database')
const { encrypt } = require('../shared/utils/encrypt')
const { parseWahaAccountConfig } = require('../shared/utils/wahaConfig')
const {
  parseDouyinAccountConfig,
  prepareDouyinAccountCreation
} = require('../modules/channel-adapters/douyin-commerce/douyinAccountConfig')
const {
  parsePinduoduoAccountConfig,
  preparePinduoduoAccountCreation
} = require('../modules/channel-adapters/pinduoduo-commerce/pinduoduoAccountConfig')
const {
  parseTaobaoAccountConfig,
  prepareTaobaoAccountCreation
} = require('../modules/channel-adapters/taobao-commerce/taobaoAccountConfig')
const {
  parseAlibaba1688AccountConfig,
  prepareAlibaba1688AccountCreation
} = require('../modules/channel-adapters/alibaba1688-commerce/alibaba1688AccountConfig')
const {
  parseWechatMiniProgramAccountConfig,
  prepareWechatMiniProgramAccountCreation
} = require('../modules/channel-adapters/wechat-mini-program/wechatAccountConfig')
const {
  parseXiaohongshuAccountConfig,
  prepareXiaohongshuAccountCreation
} = require('../modules/channel-adapters/xiaohongshu-commerce/xiaohongshuAccountConfig')
const {
  parseWechatShopAccountConfig,
  prepareWechatShopAccountCreation
} = require('../modules/channel-adapters/wechat-shop-commerce/wechatShopAccountConfig')
const {
  parseKuaishouAccountConfig,
  prepareKuaishouAccountCreation
} = require('../modules/channel-adapters/kuaishou-commerce/kuaishouAccountConfig')
const {
  prepareDesktopBridgeAccountCreation
} = require('../modules/channel-adapters/desktop-bridge/desktopBridgeAccountConfig')
const { createBridgeRepository } = require('../modules/desktop-bridge/bridgeRepository')
const { getAdapter } = require('../modules/channel-adapters')
const registry = require('../modules/waha-registry')
const { CHANNEL_CODE_PATTERN, normalizeKnowledgeMetadata } = require('../modules/rag/knowledgeScope')
const { getChannelCapabilities } = require('../modules/channel-capabilities/channelCapabilities')
const {
  presentChannelAccountListItem,
  presentChannelAccountDetail
} = require('./channelAccounts.presenter')

const DEFAULT_WAHA_ENGINE = String(process.env.WAHA_ENGINE || 'gows').trim().toLowerCase() === 'webjs' ? 'webjs' : 'gows'

// 本机桌面客户端检测探针（只读 UIA）。默认路径按仓库结构推导，可用环境变量覆盖。
// 每个渠道一个探针脚本；一台机器只有一个桥接节点，检测结果里的机器指纹
// 在两个平台间完全一致（算法一致），账号会绑到同一个节点上。
const DESKTOP_PROBE_CONFIGS = Object.freeze({
  douyin: {
    scriptEnv: 'FEIGE_PROBE_PATH',
    pythonEnv: 'FEIGE_PROBE_PYTHON',
    timeoutEnv: 'FEIGE_PROBE_TIMEOUT_MS',
    relPath: ['tools', 'feige-uia-probe', 'detect.py']
  },
  xiaohongshu: {
    scriptEnv: 'QIANFAN_PROBE_PATH',
    pythonEnv: 'QIANFAN_PROBE_PYTHON',
    timeoutEnv: 'QIANFAN_PROBE_TIMEOUT_MS',
    relPath: ['tools', 'qianfan-uia-probe', 'detect.py']
  }
})

function resolveProbeConfig(channelCode) {
  return DESKTOP_PROBE_CONFIGS[channelCode] || DESKTOP_PROBE_CONFIGS.douyin
}

function resolveProbeScript(probeConfig) {
  if (probeConfig.scriptEnv && process.env[probeConfig.scriptEnv]) {
    return process.env[probeConfig.scriptEnv]
  }
  return path.join(__dirname, '..', '..', '..', ...probeConfig.relPath)
}

/**
 * 解析探针输出。探针失败时**仍然打印 JSON 并以非零码退出**，
 * 因此不能只靠 try/catch 判断，必须优先读 error.stdout。
 */
function parseProbeStdout(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop()
  try {
    return JSON.parse(lastLine)
  } catch {
    return null
  }
}

function normalizeChannelCode(code = '') {
  return String(code || '').trim().toLowerCase()
}

function defaultScopeForChannel(channel = '') {
  const normalized = normalizeChannelCode(channel)
  if (normalized === 'whatsapp') return 'overseas'
  if (['wechat', 'douyin', 'pinduoduo', 'taobao', 'alibaba1688', 'xiaohongshu', 'wechat_shop', 'kuaishou'].includes(normalized)) return 'domestic'
  return 'common'
}

function mapChannelDefinition(row = {}) {
  const knowledgeMetadata = normalizeKnowledgeMetadata({
    knowledgeScope: row.knowledge_scope,
    knowledgeChannels: row.knowledge_channels
  }, row.code)
  return {
    code: row.code,
    label: row.label,
    adapterType: row.adapter_type || (row.code === 'whatsapp' ? 'waha' : row.code === 'wechat' ? 'wechat_mini_program' : 'manual'),
    knowledgeScope: knowledgeMetadata.knowledgeScope,
    knowledgeChannels: knowledgeMetadata.knowledgeChannels,
    sortOrder: row.sort_order || 0,
    status: row.status || 'active',
    capabilities: getChannelCapabilities(row.code),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function getChannelDefinition(code, { includeInactive = false } = {}) {
  const normalized = normalizeChannelCode(code)
  if (!CHANNEL_CODE_PATTERN.test(normalized)) return null
  const statusClause = includeInactive ? '' : "AND status = 'active'"
  const [rows] = await sequelize.query(
    `SELECT * FROM channel_definitions WHERE code = :code ${statusClause} LIMIT 1`,
    { replacements: { code: normalized } }
  )
  return rows[0] ? mapChannelDefinition(rows[0]) : null
}

// ========== 认证中间件 ==========
router.use(createAuthenticate())
router.use(async (req, res, next) => {
  if (req.user.role === 'admin') return next()
  if (req.method === 'GET' && req.path === '/') {
    try {
      const [rows] = await sequelize.query(`SELECT a.id, a.channel, a.account_name, a.status, a.adapter_type
        FROM channel_accounts a WHERE EXISTS (SELECT 1 FROM seat_account_bindings b
          WHERE b.account_id = a.id AND b.seat_id = :seatId AND b.status = 'active')
          AND (:channel IS NULL OR a.channel = :channel) AND (:status IS NULL OR a.status = :status)
        ORDER BY a.id`, { replacements: { seatId: req.user.id,
          channel: req.query.channel || null, status: req.query.status || null } })
      return res.json({ success: true, data: rows })
    } catch { return res.status(503).json({ success: false, message: '接待账号暂时无法读取，请重试' }) }
  }
  return res.status(403).json({ success: false, message: '仅管理员可管理渠道账号' })
})

// ========== 绑定渠道账号 ==========
// ========== 渠道字典 ==========
router.get('/channels', async (req, res) => {
  try {
    const { status } = req.query
    const conditions = []
    const replacements = {}
    if (status && status !== 'all') {
      conditions.push('status = :status')
      replacements.status = status
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await sequelize.query(
      `SELECT * FROM channel_definitions ${whereClause} ORDER BY sort_order ASC, created_at ASC`,
      { replacements }
    )
    res.json({ success: true, data: rows.map(mapChannelDefinition) })
  } catch (err) {
    console.error('[ChannelDefinitions] 查询失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

router.post('/channels', async (req, res) => {
  try {
    const code = normalizeChannelCode(req.body.code)
    const label = String(req.body.label || '').trim()
    if (!CHANNEL_CODE_PATTERN.test(code) || code === 'all') {
      return res.status(400).json({ success: false, message: '渠道编码仅支持 2-30 位小写字母、数字、下划线或中划线' })
    }
    if (!label) {
      return res.status(400).json({ success: false, message: '渠道名称不能为空' })
    }

    const adapterType = String(req.body.adapterType || req.body.adapter_type || (code === 'whatsapp' ? 'waha' : 'manual')).trim().toLowerCase()
    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: req.body.knowledgeScope || req.body.knowledge_scope || defaultScopeForChannel(code),
      knowledgeChannels: req.body.knowledgeChannels || req.body.knowledge_channels || ['all']
    }, code)
    const sortOrder = Number.isFinite(Number(req.body.sortOrder ?? req.body.sort_order))
      ? Number(req.body.sortOrder ?? req.body.sort_order)
      : 100

    await sequelize.query(
      `INSERT INTO channel_definitions
         (code, label, adapter_type, knowledge_scope, knowledge_channels, sort_order, status, created_at, updated_at)
       VALUES
         (:code, :label, :adapterType, :knowledgeScope, :knowledgeChannels, :sortOrder, 'active', NOW(), NOW())`,
      {
        replacements: {
          code,
          label,
          adapterType,
          knowledgeScope: knowledgeMetadata.knowledgeScope,
          knowledgeChannels: JSON.stringify(knowledgeMetadata.knowledgeChannels),
          sortOrder
        }
      }
    )

    const channel = await getChannelDefinition(code, { includeInactive: true })
    res.json({ success: true, message: '渠道已新增', data: channel })
  } catch (err) {
    const duplicate = /Duplicate entry/i.test(err.message)
    res.status(duplicate ? 409 : 500).json({ success: false, message: duplicate ? '渠道编码已存在' : '新增失败: ' + err.message })
  }
})

router.patch('/channels/:code', async (req, res) => {
  try {
    const code = normalizeChannelCode(req.params.code)
    const existing = await getChannelDefinition(code, { includeInactive: true })
    if (!existing) {
      return res.status(404).json({ success: false, message: '渠道不存在' })
    }

    const label = req.body.label !== undefined ? String(req.body.label || '').trim() : existing.label
    if (!label) {
      return res.status(400).json({ success: false, message: '渠道名称不能为空' })
    }
    const status = ['active', 'inactive'].includes(req.body.status) ? req.body.status : existing.status
    const adapterType = String(req.body.adapterType || req.body.adapter_type || existing.adapterType).trim().toLowerCase()
    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: req.body.knowledgeScope || req.body.knowledge_scope || existing.knowledgeScope,
      knowledgeChannels: req.body.knowledgeChannels || req.body.knowledge_channels || existing.knowledgeChannels
    }, code)
    const sortOrder = Number.isFinite(Number(req.body.sortOrder ?? req.body.sort_order))
      ? Number(req.body.sortOrder ?? req.body.sort_order)
      : existing.sortOrder

    await sequelize.query(
      `UPDATE channel_definitions
       SET label = :label,
           adapter_type = :adapterType,
           knowledge_scope = :knowledgeScope,
           knowledge_channels = :knowledgeChannels,
           sort_order = :sortOrder,
           status = :status,
           updated_at = NOW()
       WHERE code = :code`,
      {
        replacements: {
          code,
          label,
          adapterType,
          knowledgeScope: knowledgeMetadata.knowledgeScope,
          knowledgeChannels: JSON.stringify(knowledgeMetadata.knowledgeChannels),
          sortOrder,
          status
        }
      }
    )

    const channel = await getChannelDefinition(code, { includeInactive: true })
    res.json({ success: true, message: '渠道已更新', data: channel })
  } catch (err) {
    console.error('[ChannelDefinitions] 更新失败:', err.message)
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

  // 检测本机桌面客户端（飞鸽 / 千帆），供「本地桌面客户端」接入方式使用。
  // 只调用只读探针（UIA 元素树读取），不点击、不输入、不发送消息。
  // 前提是后端与客户端同机。默认渠道 douyin，可传 channel=xiaohongshu。
  router.post('/detect-desktop', async (req, res) => {
    const channelCode = normalizeChannelCode((req.body && req.body.channel) || 'douyin')
    const probeConfig = resolveProbeConfig(channelCode)
    const pythonBin = process.env[probeConfig.pythonEnv] || process.env.FEIGE_PROBE_PYTHON || 'python'
    const probeScript = resolveProbeScript(probeConfig)
    const timeoutMs = Number(
      process.env[probeConfig.timeoutEnv] || process.env.FEIGE_PROBE_TIMEOUT_MS || 40000
    )

    try {
      const { stdout } = await execFileAsync(pythonBin, ['-X', 'utf8', probeScript], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })
      const parsed = parseProbeStdout(stdout)
      if (!parsed) {
        return res.status(502).json({ success: false, message: '检测探针返回了无法解析的输出' })
      }
      if (!parsed.ok) {
        return res.status(422).json({
          success: false,
          message: parsed.error && parsed.error.reason ? parsed.error.reason : '未检测到本地客户端',
          detail: parsed.error || null
        })
      }
      return res.json({ success: true, data: parsed })
    } catch (error) {
      // 探针失败时也会输出结构化 JSON，优先把它透出去而不是报 500
      const parsed = parseProbeStdout(error.stdout)
      if (parsed && parsed.error) {
        return res.status(422).json({
          success: false,
          message: parsed.error.reason || '未检测到本地客户端',
          detail: parsed.error
        })
      }
      if (error.code === 'ENOENT') {
        return res.status(503).json({
          success: false,
          message: `未找到 Python 解释器（${pythonBin}），请安装或在 ${probeConfig.pythonEnv} 中指定路径`,
          detail: { code: error.code, probeScript }
        })
      }
      if (error.killed || error.signal) {
        return res.status(504).json({
          success: false,
          message: `检测超时（${timeoutMs}ms），客户端可能未运行或元素树未就绪`,
          detail: { signal: error.signal || null }
        })
      }
      return res.status(500).json({
        success: false,
        message: '检测失败',
        detail: { code: error.code || null, message: error.message }
      })
    }
  })

  router.post('/', async (req, res) => {
  try {
    const { channel, account_name, config, adapter_type, max_daily_quota, knowledge_scope, knowledge_channels } = req.body

    if (!channel || !account_name) {
      return res.status(400).json({ success: false, message: 'channel, account_name 不能为空' })
    }

    const channelCode = normalizeChannelCode(channel)
    const channelDefinition = await getChannelDefinition(channelCode)
    if (!channelDefinition) {
      return res.status(400).json({ success: false, message: '渠道不存在或已停用，请先在渠道下拉中新增/启用' })
    }

    // 默认适配器类型
    let adapterType = adapter_type || channelDefinition.adapterType || (channelCode === 'whatsapp' ? 'waha' : 'manual')

    let fullConfig = { ...config }

    // 接入方式：官方 API（默认，走 App Key）／本地桌面客户端（走本机检测信息）
    const connectionMode = typeof req.body.connection_mode === 'string'
      ? req.body.connection_mode.trim()
      : ''
    let bridgeBinding = null

    if (connectionMode === 'desktop_bridge') {
      try {
        const prepared = prepareDesktopBridgeAccountCreation({ config, channel: channelCode })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
        // adapterId 供 desktop_bridge_bindings 使用（绑定表要求 adapter_id 非空）
        bridgeBinding = { adapterId: prepared.adapterId }
      } catch (error) {
        if (error.code === 'DESKTOP_BRIDGE_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    // 选了桌面客户端就不再走官方 App Key 校验（两条互斥的接入路径）
    if (connectionMode !== 'desktop_bridge' && channelCode === 'douyin') {
      try {
        const prepared = prepareDouyinAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'DOUYIN_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }


    if (channelCode === 'pinduoduo') {
      try {
        const prepared = preparePinduoduoAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'PINDUODUO_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (channelCode === 'taobao') {
      try {
        const prepared = prepareTaobaoAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'TAOBAO_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (channelCode === 'alibaba1688') {
      try {
        const prepared = prepareAlibaba1688AccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'ALIBABA1688_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (channelCode === 'xiaohongshu') {
      try {
        const prepared = prepareXiaohongshuAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'XIAOHONGSHU_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (channelCode === 'wechat_shop') {
      try {
        const prepared = prepareWechatShopAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'WECHAT_SHOP_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (channelCode === 'kuaishou') {
      try {
        const prepared = prepareKuaishouAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'KUAISHOU_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    // WhatsApp 账号需要从实例池分配
    if (channelCode === 'wechat') {
      try {
        const prepared = prepareWechatMiniProgramAccountCreation({ adapter_type, config })
        adapterType = prepared.adapterType
        fullConfig = prepared.config
      } catch (error) {
        if (error.code === 'WECHAT_MINI_PROGRAM_ACCOUNT_CONFIG_INVALID') {
          return res.status(400).json({ success: false, message: error.message, fields: error.fields })
        }
        throw error
      }
    }

    if (adapterType === 'waha' && channelCode === 'whatsapp') {
      // 获取可用实例
      const instance = await registry.getAvailableInstance()
      if (!instance) {
        return res.status(400).json({ 
          success: false, 
          message: '无可用 WAHA 实例，请先增加 WAHA 容器' 
        })
      }

      console.log('[ChannelAccounts] 使用实例:', instance.host)

      fullConfig = {
        ...fullConfig,
        wahaInstanceUrl: instance.host,
        apiKey: instance.apiKey,
        port: instance.port,
        sessionName: 'default', // 免费版固定使用 default
        engine: instance.engine || DEFAULT_WAHA_ENGINE
      }
    }

    // 加密配置
    const encryptedConfig = encrypt(fullConfig)
    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: req.body.knowledgeScope || knowledge_scope || channelDefinition.knowledgeScope,
      knowledgeChannels: req.body.knowledgeChannels || knowledge_channels || channelDefinition.knowledgeChannels
    }, channelCode)

    // 存入数据库
    const accountPayload = {
      channel: channelCode,
      account_name,
      config: encryptedConfig,
      status: 'active',
      adapter_type: adapterType,
      max_daily_quota: max_daily_quota || 1000,
      knowledge_scope: knowledgeMetadata.knowledgeScope,
      knowledge_channels: knowledgeMetadata.knowledgeChannels
    }

    // 桌面桥接账号必须与绑定行同事务落库：绑定缺失时 leaseService.acquire
    // 一定会抛 ACCOUNT_NOT_BOUND，账号等于不可用。两者要么都成功，要么都回滚。
    let account
    if (bridgeBinding) {
      const bridgeRepository = createBridgeRepository(sequelize)
      account = await sequelize.transaction(async transaction => {
        const created = await ChannelAccount.create(accountPayload, { transaction })
        await bridgeRepository.upsertBinding({
          channelAccountId: created.id,
          adapterId: bridgeBinding.adapterId,
          mode: 'desktop_bridge',
          enabled: 1,
          actorId: req.user && req.user.id ? req.user.id : null,
          transaction
        })
        return created
      })
    } else {
      account = await ChannelAccount.create(accountPayload)
    }

    // 启动 WAHA Session（使用 Registry 统一启动，自动传入正确的 webhook 配置）
    if (adapterType === 'waha' && channelCode === 'whatsapp') {
      // 自动更新 docker-compose.yml 中的 WHATSAPP_HOOK_URL（env 级兜底，防止 --force-recreate 后断流）
      try { registry.updateComposeWebhook(fullConfig.port, account.id) } catch (e) { console.warn('[ChannelAccounts] 更新 docker-compose webhook 失败:', e.message) }

      const instance = registry.getInstanceByPort(fullConfig.port)
      const startResult = await registry.startSession(instance, account.id)

      if (!startResult.success) {
        // Session 启动失败，但数据库记录已创建
        // 返回成功但附带警告，让前端知道需要手动重试
        console.warn('[ChannelAccounts] WAHA session 启动失败:', startResult.error.type, startResult.error.message)
        return res.json({
          success: true,
          message: '账号已创建，但 WAHA Session 启动失败: ' + startResult.error.message,
          data: {
            id: account.id,
            channel: channelCode,
            account_name,
            adapter_type: adapterType,
            knowledgeScope: knowledgeMetadata.knowledgeScope,
            knowledgeChannels: knowledgeMetadata.knowledgeChannels,
            sessionName: 'default',
            engine: fullConfig.engine || DEFAULT_WAHA_ENGINE,
            warning: {
              type: startResult.error.type,
              message: startResult.error.message
            }
          }
        })
      }
    }

    res.json({
      success: true,
      message: '渠道账号绑定成功',
      data: { 
        id: account.id, 
        channel: channelCode,
        account_name, 
        adapter_type: adapterType,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels,
        sessionName: 'default',
        engine: fullConfig.engine || DEFAULT_WAHA_ENGINE
      }
    })
  } catch (err) {
    console.error('[ChannelAccounts] 绑定失败:', err.message)
    res.status(500).json({ success: false, message: '绑定失败: ' + err.message })
  }
})

// ========== 查询账号列表 ==========
router.get('/', async (req, res) => {
  try {
    const { channel, status } = req.query

    const where = {}
    if (channel) where.channel = channel
    if (status) where.status = status

    const accounts = await ChannelAccount.findAll({
      where,
      attributes: ['id', 'channel', 'account_name', 'config', 'status', 'adapter_type', 'daily_quota', 'max_daily_quota', 'phone_number', 'whatsapp_name', 'knowledge_scope', 'knowledge_channels', 'created_at', 'updated_at'],
      order: [['created_at', 'DESC']]
    })

    const result = accounts.map(account => {
    const item = presentChannelAccountListItem(account.toJSON(), {
      parseWahaConfig: parseWahaAccountConfig,
      parseDouyinConfig: parseDouyinAccountConfig,
      parsePinduoduoConfig: parsePinduoduoAccountConfig,
      parseTaobaoConfig: parseTaobaoAccountConfig,
      parseAlibaba1688Config: parseAlibaba1688AccountConfig,
      parseWechatMiniProgramConfig: parseWechatMiniProgramAccountConfig,
      parseXiaohongshuConfig: parseXiaohongshuAccountConfig,
      parseWechatShopConfig: parseWechatShopAccountConfig,
      parseKuaishouConfig: parseKuaishouAccountConfig,
      defaultWahaEngine: DEFAULT_WAHA_ENGINE
    })
      const knowledgeMetadata = normalizeKnowledgeMetadata({
        knowledgeScope: item.knowledge_scope,
        knowledgeChannels: item.knowledge_channels
      }, item.channel)
      item.knowledgeScope = knowledgeMetadata.knowledgeScope
      item.knowledgeChannels = knowledgeMetadata.knowledgeChannels
      return item
    })

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[ChannelAccounts] 查询列表失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 查询单个账号 ==========
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const account = await ChannelAccount.findByPk(id, {
      attributes: ['id', 'channel', 'account_name', 'config', 'status', 'adapter_type', 'daily_quota', 'max_daily_quota', 'phone_number', 'whatsapp_name', 'knowledge_scope', 'knowledge_channels', 'created_at', 'updated_at']
    })

    if (!account) {
      return res.status(404).json({ success: false, message: '账号不存在' })
    }

    const result = presentChannelAccountDetail(account.toJSON(), {
      parseWahaConfig: parseWahaAccountConfig,
      parseDouyinConfig: parseDouyinAccountConfig,
      parsePinduoduoConfig: parsePinduoduoAccountConfig,
      parseTaobaoConfig: parseTaobaoAccountConfig,
      parseAlibaba1688Config: parseAlibaba1688AccountConfig,
      parseWechatMiniProgramConfig: parseWechatMiniProgramAccountConfig,
      parseXiaohongshuConfig: parseXiaohongshuAccountConfig,
      parseWechatShopConfig: parseWechatShopAccountConfig,
      parseKuaishouConfig: parseKuaishouAccountConfig,
      defaultWahaEngine: DEFAULT_WAHA_ENGINE
    })
    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: result.knowledge_scope,
      knowledgeChannels: result.knowledge_channels
    }, result.channel)
    result.knowledgeScope = knowledgeMetadata.knowledgeScope
    result.knowledgeChannels = knowledgeMetadata.knowledgeChannels

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[ChannelAccounts] 查询详情失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 解绑账号 ==========
// ========== 更新渠道账号知识归类 ==========
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const account = await ChannelAccount.findByPk(id)
    if (!account) {
      return res.status(404).json({ success: false, message: '账号不存在' })
    }

    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: req.body.knowledgeScope || req.body.knowledge_scope,
      knowledgeChannels: req.body.knowledgeChannels || req.body.knowledge_channels
    }, account.channel)

    await account.update({
      knowledge_scope: knowledgeMetadata.knowledgeScope,
      knowledge_channels: knowledgeMetadata.knowledgeChannels
    })

    res.json({
      success: true,
      message: '知识归类已更新',
      data: {
        id: account.id,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels
      }
    })
  } catch (err) {
    console.error('[ChannelAccounts] 更新知识归类失败:', err.message)
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

router.get('/:id/deletion-preview', async (req, res) => {
  try {
    const account = await ChannelAccount.findByPk(req.params.id)
    if (!account || account.adapter_type !== 'wechat_shop_cloud') return res.status(404).json({ success: false, message: '小店不存在' })
    const { previewShopDeletion } = require('../modules/cloud-gateway/shopAccountDeletion')
    res.json({ success: true, data: { name: account.account_name, counts: await previewShopDeletion(sequelize, account.id) } })
  } catch { res.status(500).json({ success: false, message: '无法读取删除范围，请重试' }) }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const account = await ChannelAccount.findByPk(id)
    if (!account) {
      return res.status(404).json({ success: false, message: '账号不存在' })
    }

    if (account.adapter_type === 'wechat_shop_cloud') {
      const { deleteShopAccount } = require('../modules/cloud-gateway/shopAccountDeletion')
      const data = await deleteShopAccount({ sequelize, account, manager: req.app.get('localShopConnection'), confirmation: req.body?.confirmName })
      return res.json({ success: true, message: '本地店铺资料已删除', data })
    }

    // 如果是 WAHA 适配器，同时删除 WAHA session
    if (account.adapter_type === 'waha') {
      try {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
        if (config.wahaInstanceUrl && config.apiKey) {
          const client = registry.createClient(
            { host: config.wahaInstanceUrl, apiKey: config.apiKey },
            10000
          )

          // 先查询实际 session 名（免费版可能不叫 default）
          const sessionName = config.sessionName || 'default'
          try {
            const sessionsRes = await client.get('/api/sessions')
            const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [sessionsRes.data].filter(Boolean)
            for (const session of sessions) {
              const name = session.name || session.Name
              if (name) {
                try { await client.post(`/api/sessions/${name}/stop`) } catch { /* 忽略 */ }
                try { await client.delete(`/api/sessions/${name}`) } catch { /* 忽略 */ }
                console.log(`[ChannelAccounts] WAHA session 已删除: ${name} (account=${account.id}, port=${config.port || '-'})`)
              }
            }
          } catch {
            // 容器可能离线，降级为直接删 default
            await client.delete(`/api/sessions/${sessionName}`).catch(() => {})
            console.log(`[ChannelAccounts] WAHA session 已删除(fallback): ${sessionName}`)
          }
        }
      } catch (wahaErr) {
        console.warn('[ChannelAccounts] WAHA session 删除失败（继续删除数据库记录）:', wahaErr.message)
      }
    }

    // 物理删除数据库记录（解绑后不再保留）
    await account.destroy()

    res.json({ success: true, message: '渠道账号已解绑' })
  } catch (err) {
    console.error('[ChannelAccounts] 解绑失败:', err.message)
    res.status(err.status || 500).json({ success: false, message: err.status === 400 ? err.message : '删除未完成，请检查连接后重试；远端消息和其他店铺未删除' })
  }
})

module.exports = router
