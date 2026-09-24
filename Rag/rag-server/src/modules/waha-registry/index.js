/**
 * WahaRegistry - WAHA 多实例统一注册中心
 *
 * 职责：
 *  1. 加载 WAHA 实例配置（从 WAHA_INSTANCES 环境变量）
 *  2. 维护 instance <-> account 映射（从 channel_accounts 表实时查询）
 *  3. 提供统一的实例解析接口，消除所有降级路径
 *  4. 提供统一的 session 启动/重启逻辑（含 webhook 配置）
 *  5. 提供配置一致性校验
 *
 * 设计原则：
 *  - 所有模块通过 Registry 查询实例，不允许自行解析 config/降级
 *  - 找不到实例时返回 null 并打 warn 日志，不猜测
 *  - 默认使用 docker-compose 的 WHATSAPP_HOOK_URL 作为 webhook 来源，避免 session + env 双推
 */

const axios = require('axios')
const crypto = require('crypto')
const { sequelize } = require('../../config/database')
const { parseWahaAccountConfig } = require('../../shared/utils/wahaConfig')
const { ChannelAccount } = require('../../models')

const BASE_PORT = 3005
const DEFAULT_SESSION_NAME = 'default'
// WAHA 在 Docker 容器内运行，webhook 回调地址必须用 host.docker.internal 才能到达宿主机
// 不要用 localhost——容器内的 localhost 指向容器自身，webhook 无法送达
const SERVER_HOST = process.env.SERVER_HOST || 'http://host.docker.internal:3001'
// 默认以 docker-compose 中的 WHATSAPP_HOOK_URL 作为唯一 webhook 来源，避免 env + session 双推。
const SESSION_WEBHOOK_ENABLED = process.env.WAHA_SESSION_WEBHOOK_ENABLED === 'true'
const DEFAULT_WAHA_ENGINE = String(process.env.WAHA_ENGINE || 'gows').trim().toLowerCase() === 'webjs' ? 'webjs' : 'gows'

// ========== 加载实例配置 ==========

function loadInstances() {
  // 优先级 1：WAHA_INSTANCES（JSON 数组）
  try {
    const envInstances = process.env.WAHA_INSTANCES
    if (envInstances) {
      const parsed = JSON.parse(envInstances)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((inst, i) => ({
          port: inst.port || BASE_PORT + i,
          apiKey: inst.apiKey || '',
          host: inst.host || `http://localhost:${inst.port || BASE_PORT + i}`,
          containerName: `waha-${i + 1}`,
          engine: String(inst.engine || DEFAULT_WAHA_ENGINE).trim().toLowerCase() === 'gows' ? 'gows' : 'webjs'
        }))
      }
    }
  } catch (err) {
    console.error('[WahaRegistry] 解析 WAHA_INSTANCES 失败:', err.message)
  }

  // 优先级 2：WAHA_POOL_SIZE
  const poolSize = parseInt(process.env.WAHA_POOL_SIZE, 10)
  if (!isNaN(poolSize) && poolSize > 0) {
    console.warn(`[WahaRegistry] WAHA_INSTANCES 未配置，根据 WAHA_POOL_SIZE=${poolSize} 生成（API Key 为随机值，需手动同步）`)
    const instances = []
    for (let i = 0; i < poolSize; i++) {
      instances.push({
        port: BASE_PORT + i,
        apiKey: `waha-key-${crypto.randomBytes(8).toString('hex')}`,
        host: `http://localhost:${BASE_PORT + i}`,
        containerName: `waha-${i + 1}`,
        engine: DEFAULT_WAHA_ENGINE
      })
    }
    return instances
  }

  console.warn('[WahaRegistry] 未配置 WAHA_INSTANCES 或 WAHA_POOL_SIZE，使用默认 1 个实例')
  return [{
    port: BASE_PORT,
    apiKey: process.env.WAHA_API_KEY || '',
    host: process.env.WAHA_API_URL || `http://localhost:${BASE_PORT}`,
    containerName: 'waha-1',
    engine: DEFAULT_WAHA_ENGINE
  }]
}

const INSTANCES = loadInstances()

console.log(`[WahaRegistry] 已加载 ${INSTANCES.length} 个实例: ${INSTANCES.map(i => `${i.containerName}(:${i.port})`).join(', ')}`)

// ========== Registry 类 ==========

class WahaRegistry {
  constructor() {
    this.instances = INSTANCES
  }

  /**
   * 获取所有实例
   * @returns {Array} 实例配置数组（副本）
   */
  getAllInstances() {
    return [...this.instances]
  }

  /**
   * 根据端口号获取实例
   * @param {number} port
   * @returns {Object|null}
   */
  getInstanceByPort(port) {
    return this.instances.find(i => i.port === port) || null
  }

  /**
   * 根据 accountId 查询绑定的实例
   * 这是核心方法——所有模块通过此方法获取实例，不再自行解析 config。
   *
   * @param {number} accountId - channel_accounts.id
   * @returns {Promise<{instance: Object, account: Object}|null>}
   */
  async resolveByAccountId(accountId) {
    if (!accountId) {
      console.warn('[WahaRegistry] resolveByAccountId: accountId 为空，无法解析实例')
      return null
    }

    try {
      const account = await ChannelAccount.findByPk(accountId)
      if (!account) {
        console.warn(`[WahaRegistry] 账号 ${accountId} 不存在`)
        return null
      }

      const config = parseWahaAccountConfig(account.config, `accountId=${accountId}`)
      if (!config.port) {
        console.warn(`[WahaRegistry] 账号 ${accountId} config 中无 port 字段`)
        return null
      }

      const instance = this.getInstanceByPort(config.port)
      if (!instance) {
        console.warn(`[WahaRegistry] 账号 ${accountId} 的 port=${config.port} 无对应实例`)
        return null
      }

      return { instance, account }
    } catch (err) {
      console.error(`[WahaRegistry] resolveByAccountId(${accountId}) 失败:`, err.message)
      return null
    }
  }

  /**
   * 根据 session 名查询实例（所有 session 都叫 "default"，需遍历账号匹配）
   * @param {string} sessionName
   * @returns {Promise<{instance: Object, account: Object}|null>}
   */
  async resolveBySessionName(sessionName) {
    if (!sessionName) return null

    try {
      const accounts = await ChannelAccount.findAll({
        where: { channel: 'whatsapp', adapter_type: 'waha', status: 'active' }
      })

      for (const account of accounts) {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
        if (config.sessionName === sessionName) {
          const instance = this.getInstanceByPort(config.port)
          if (instance) {
            return { instance, account }
          }
        }
      }
      return null
    } catch (err) {
      console.error('[WahaRegistry] resolveBySessionName 失败:', err.message)
      return null
    }
  }

  /**
   * 获取未绑定账号的可用实例（用于创建新账号时分配实例）
   * @returns {Promise<Object|null>}
   */
  async getAvailableInstance() {
    try {
      const accounts = await ChannelAccount.findAll({
        where: { channel: 'whatsapp', adapter_type: 'waha', status: 'active' }
      })

      const boundPorts = new Set()
      for (const account of accounts) {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
        if (config.port) {
          boundPorts.add(config.port)
        }
      }

      for (const instance of this.instances) {
        if (!boundPorts.has(instance.port)) {
          return instance
        }
      }
      return null
    } catch (err) {
      console.error('[WahaRegistry] getAvailableInstance 失败:', err.message)
      return null
    }
  }

  /**
   * 根据 accountId 构建 webhook 配置
   * @param {number} accountId
   * @returns {Object|null} { url, events }
   */
  buildWebhookConfig(accountId) {
    if (!accountId) return null
    return {
      url: `${SERVER_HOST}/api/channel/whatsapp/webhook?account_id=${accountId}`,
      events: ['message']
    }
  }

  /**
   * 创建 WAHA API 客户端
   * @param {Object} instance - { host, apiKey }
   * @param {number} timeoutMs
   * @returns {axios.AxiosInstance}
   */
  createClient(instance, timeoutMs = 30000) {
    return axios.create({
      baseURL: instance.host,
      headers: {
        'X-Api-Key': instance.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    })
  }

  /**
   * 自动更新 docker-compose.yml 中指定实例的 WHATSAPP_HOOK_URL
   * 在 channelAccount 创建/绑定时自动调用，确保 env 级 webhook 兜底始终存在。
   * 容器 --force-recreate 后 WAHA 会用此 env 变量恢复 webhook，避免消息断流。
   *
   * @param {number} port - WAHA 实例端口
   * @param {number} accountId - channel_accounts.id
   * @returns {boolean} 是否成功更新
   */
  updateComposeWebhook(port, accountId) {
    const fs = require('fs')
    const path = require('path')

    const composePath = path.join(__dirname, '..', '..', '..', '..', 'docker', 'waha', 'docker-compose.yml')

    if (!fs.existsSync(composePath)) {
      console.warn(`[WahaRegistry] docker-compose.yml 不存在: ${composePath}，跳过 webhook 更新`)
      return false
    }

    const content = fs.readFileSync(composePath, 'utf-8')
    const hookUrl = `${SERVER_HOST}/api/channel/whatsapp/webhook?account_id=${accountId}`

    // 查找匹配端口的 service 块中的 environment 段
    const serviceRegex = new RegExp(
      `(waha-\\d+:[\\s\\S]*?ports:\\s*\\n\\s*-\\s*"${port}:3000"[\\s\\S]*?environment:\\s*\\n)((?:\\s+-\\s+[^\\n]+\\n|\\s+#\\s*[^\\n]+\\n)+)`
    )
    const match = content.match(serviceRegex)
    if (!match) {
      console.warn(`[WahaRegistry] docker-compose.yml 中未找到端口 ${port} 的 environment 块`)
      return false
    }

    const envBlock = match[2]
    let newEnvBlock

    if (envBlock.includes('WHATSAPP_HOOK_URL=')) {
      // 已有 WHATSAPP_HOOK_URL，替换 account_id
      newEnvBlock = envBlock.replace(
        /WHATSAPP_HOOK_URL=[^\n]+/,
        `WHATSAPP_HOOK_URL=${hookUrl}`
      )
    } else if (envBlock.includes('# Webhook')) {
      // 有注释占位行，替换为实际的 webhook URL
      const indentMatch = envBlock.match(/^(\s+)-\s/m)
      const indent = indentMatch ? indentMatch[1] : '      '
      newEnvBlock = envBlock.replace(
        /\s*#\s*Webhook[^\n]*\n/,
        `\n${indent}- WHATSAPP_HOOK_URL=${hookUrl}\n${indent}- WHATSAPP_HOOK_EVENTS=message\n`
      )
    } else {
      // 在环境变量块末尾添加
      const indentMatch = envBlock.match(/^(\s+)-\s/m)
      const indent = indentMatch ? indentMatch[1] : '      '
      newEnvBlock = envBlock.trimEnd() + `\n${indent}- WHATSAPP_HOOK_URL=${hookUrl}\n${indent}- WHATSAPP_HOOK_EVENTS=message\n`
    }

    const newContent = content.replace(match[2], newEnvBlock)
    fs.writeFileSync(composePath, newContent, 'utf-8')
    console.log(`[WahaRegistry] docker-compose.yml 已更新: 端口 ${port} → webhook account_id=${accountId}`)
    return true
  }

  // ========== Session 生命周期管理（统一实现）==========

  /**
   * 清理容器中所有旧 session（免费版只能有一个）
   * @param {axios.AxiosInstance} client
   * @private
   */
  async _cleanupSessions(client) {
    try {
      const response = await client.get('/api/sessions')
      const sessions = response.data || []
      for (const session of sessions) {
        const name = session.name || session.Name
        if (name) {
          try { await client.post(`/api/sessions/${name}/stop`) } catch { /* 忽略 */ }
          try { await client.delete(`/api/sessions/${name}`) } catch { /* 忽略 */ }
          console.log(`[WahaRegistry] 已清理旧 session: ${name}`)
        }
      }
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        throw new Error('WAHA 容器无法访问，请检查 Docker 容器是否正在运行')
      }
      // 其他错误忽略（如 404 表示无 session）
    }
  }

  /**
   * 启动 WAHA Session（统一入口，替代 wahaProxy.js 和 channelAccounts.js 中的重复实现）
   *
   * @param {Object} instance - { host, apiKey, port, containerName }
   * @param {number} accountId - 关联的 channel_accounts.id（用于构建 webhook URL）
   * @param {Object} options - { skipWebhook: boolean }
   * @returns {Promise<{success: boolean, data?: Object, error?: {type: string, message: string}}>}
   */
  async startSession(instance, accountId, options = {}) {
    const { skipWebhook = false } = options
    const client = this.createClient(instance, 15000)

    // 1. 清理旧 session
    try {
      await this._cleanupSessions(client)
    } catch (err) {
      return { success: false, error: { type: 'WAHA_OFFLINE', message: err.message } }
    }

    // 2. 构建 session 启动请求体
    const startBody = { name: DEFAULT_SESSION_NAME }
    if (SESSION_WEBHOOK_ENABLED && !skipWebhook && accountId) {
      const webhookConfig = this.buildWebhookConfig(accountId)
      if (webhookConfig) {
        startBody.config = {
          webhooks: [{
            url: webhookConfig.url,
            events: webhookConfig.events
          }]
        }
      }
    }

    // 3. 尝试 POST /api/sessions/start（新版 WAHA）
    try {
      const response = await client.post('/api/sessions/start', startBody)
      console.log(`[WahaRegistry] Session 已启动: ${instance.containerName} (port=${instance.port})${SESSION_WEBHOOK_ENABLED && !skipWebhook && accountId ? ' + session webhook' : ' + env webhook'}`)
      return { success: true, data: response.data }
    } catch (err) {
      // 422 = session 未就绪
      if (err.response?.status === 422) {
        return { success: false, error: { type: 'SESSION_NOT_READY', message: 'Session 尚未连接，无法执行此操作' } }
      }
      // 401/403 = API Key 错误
      if (err.response?.status === 401 || err.response?.status === 403) {
        return { success: false, error: { type: 'AUTH_ERROR', message: 'WAHA API Key 不匹配，请检查配置' } }
      }
    }

    // 3b. 尝试 POST /api/sessions（旧版 WAHA）
    try {
      const response = await client.post('/api/sessions', startBody)
      console.log(`[WahaRegistry] Session 已启动(旧版API): ${instance.containerName} (port=${instance.port})`)
      return { success: true, data: response.data }
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        return { success: false, error: { type: 'WAHA_OFFLINE', message: 'WAHA 容器无法访问，请检查 Docker 容器是否正在运行' } }
      }
      if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
        return { success: false, error: { type: 'TIMEOUT', message: '请求 WAHA 超时，容器可能正在启动中' } }
      }
      const errMsg = err.response?.data?.message || err.response?.data || err.message
      return {
        success: false,
        error: {
          type: 'WAHA_ERROR',
          message: `WAHA 启动失败 (${err.response?.status || err.code}): ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`
        }
      }
    }
  }

  /**
   * 重启 session。
   * 默认不注入 session webhook，依赖 docker-compose.yml 中持久化的 WHATSAPP_HOOK_URL。
   *
   * @param {number} accountId
   * @returns {Promise<{success: boolean, data?: Object, error?: Object}>}
   */
  async restartSession(accountId) {
    const resolved = await this.resolveByAccountId(accountId)
    if (!resolved) {
      return { success: false, error: { type: 'NOT_FOUND', message: `账号 ${accountId} 未找到对应 WAHA 实例` } }
    }

    const { instance } = resolved
    // 默认依赖 docker-compose 的 WHATSAPP_HOOK_URL，避免 session webhook 与 env webhook 同时生效导致重复推送。
    return this.startSession(instance, accountId)
  }

  // ========== 配置校验 ==========

  /**
   * 校验 .env(WAHA_INSTANCES) 与 DB(channel_accounts) 之间的一致性
   * @returns {Promise<{ok: boolean, issues: Array<string>}>}
   */
  async validate() {
    const issues = []

    try {
      const accounts = await ChannelAccount.findAll({
        where: { channel: 'whatsapp', adapter_type: 'waha', status: 'active' }
      })

      const instancePorts = new Set(this.instances.map(i => i.port))

      for (const account of accounts) {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)

        if (!config.port) {
          issues.push(`账号 ${account.id}(${account.account_name}) config 中无 port 字段`)
          continue
        }

        if (!instancePorts.has(config.port)) {
          issues.push(`账号 ${account.id}(${account.account_name}) port=${config.port} 在 WAHA_INSTANCES 中不存在`)
        }

        if (!config.apiKey) {
          issues.push(`账号 ${account.id}(${account.account_name}) config 中无 apiKey`)
        } else {
          const instance = this.getInstanceByPort(config.port)
          if (instance && instance.apiKey && config.apiKey !== instance.apiKey) {
            issues.push(`账号 ${account.id}(${account.account_name}) apiKey 与实例 port=${config.port} 的 apiKey 不一致`)
          }
        }
      }

      // 检查是否有实例未绑定账号（非错误，但提醒）
      const boundPorts = new Set()
      for (const account of accounts) {
        const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
        if (config.port) boundPorts.add(config.port)
      }
      const unboundInstances = this.instances.filter(i => !boundPorts.has(i.port))
      if (unboundInstances.length > 0) {
        console.log(`[WahaRegistry] 未绑定账号的实例: ${unboundInstances.map(i => i.containerName).join(', ')}（正常，可用于新账号）`)
      }
    } catch (err) {
      issues.push(`校验过程出错: ${err.message}`)
    }

    return {
      ok: issues.length === 0,
      issues
    }
  }
}

// 单例导出
const registry = new WahaRegistry()

module.exports = registry
