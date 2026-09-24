/**
 * 渠道账号管理 API
 *
 * 接口列表：
 * - POST   /api/v1/channel-accounts        绑定渠道账号
 * - GET    /api/v1/channel-accounts         查询账号列表
 * - GET    /api/v1/channel-accounts/:id     查询单个账号
 * - DELETE /api/v1/channel-accounts/:id     解绑账号
 *
 * 认证：需要 JWT Token（admin/supervisor 权限）
 */

const express = require('express')
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
const { getAdapter } = require('../modules/channel-adapters')
const registry = require('../modules/waha-registry')
const { CHANNEL_CODE_PATTERN, normalizeKnowledgeMetadata } = require('../modules/rag/knowledgeScope')
const { getChannelCapabilities } = require('../modules/channel-capabilities/channelCapabilities')
const {
  presentChannelAccountListItem,
  presentChannelAccountDetail
} = require('./channelAccounts.presenter')

const DEFAULT_WAHA_ENGINE = String(process.env.WAHA_ENGINE || 'gows').trim().toLowerCase() === 'webjs' ? 'webjs' : 'gows'

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
router.use(createAuthenticate(), (req, res, next) => {
  if (!['admin', 'supervisor'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: '无权限管理渠道账号' })
  }
  return next()
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

    if (channelCode === 'douyin') {
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
    const account = await ChannelAccount.create({
      channel: channelCode,
      account_name,
      config: encryptedConfig,
      status: 'active',
      adapter_type: adapterType,
      max_daily_quota: max_daily_quota || 1000,
      knowledge_scope: knowledgeMetadata.knowledgeScope,
      knowledge_channels: knowledgeMetadata.knowledgeChannels
    })

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

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const account = await ChannelAccount.findByPk(id)
    if (!account) {
      return res.status(404).json({ success: false, message: '账号不存在' })
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
    res.status(500).json({ success: false, message: '解绑失败: ' + err.message })
  }
})

module.exports = router
