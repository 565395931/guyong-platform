const { createCredentialCipher } = require('./credentialCipher')
const { createProviderRegistry, maskCredential } = require('./providerRegistry')

const CREDENTIAL_KEY = 'ai_provider_credential_ciphertext'
const PROVIDER_KEY = 'ai_provider_id'

function createProviderService({
  getConfig, updateConfig, cipher, registry = createProviderRegistry(), env = process.env
}) {
  const environmentFallback = env.DASHSCOPE_API_KEY || ''
  let cachedModels = []
  let modelsSyncedAt = null
  const provider = registry.get('dashscope')
  async function endpoint(overrides = {}) {
    const connection = await getConfig('ai_connection_config')
    if (connection?.disabled && !overrides.baseUrl) return { baseURL: '', model: '', selected: registry.get('openai-compatible') }
    const configured = overrides.baseUrl || connection?.baseUrl || await getConfig('ai_chat_base_url') || env.DASHSCOPE_BASE_URL
    const baseURL = configured ? require('./openAiEndpoint').normalizeOpenAiBaseUrl(configured) : provider.baseURL
    const model = overrides.model || connection?.model || await getConfig('ai_chat_model') || env.DASHSCOPE_MODEL || 'deepseek-chat'
    const selected = configured ? registry.get('openai-compatible') : provider
    return { baseURL, model, selected }
  }

  async function saveConnection(input, updatedBy) {
    const baseURL = require('./openAiEndpoint').normalizeOpenAiBaseUrl(input.baseUrl)
    const model = String(input.model || '').trim()
    if (!model || model.length > 160) throw new Error('请填写模型名称')
    if (!String(input.apiKey || '').trim() && !(await getCredential()).secret) throw new Error('首次配置请填写 API Key')
    const secret = String(input.apiKey || '').trim() || (await getCredential()).secret
    if (secret.length < 8 || secret.length > 500) throw new Error('API key must be between 8 and 500 characters')
    const previous = await getReplySettings()
    const contextMessageCount = input.contextMessageCount ?? previous.contextMessageCount
    const systemPrompt = input.systemPrompt ?? previous.systemPrompt
    if (!Number.isInteger(contextMessageCount) || contextMessageCount < 0 || contextMessageCount > 100) throw new Error('上下文条数必须为 0–100 的整数')
    if (typeof systemPrompt !== 'string' || systemPrompt.length > 20000) throw new Error('系统提示词最长 20000 字')
    const result = await updateConfig('ai_connection_config', { baseUrl: baseURL, model, credentialCiphertext: cipher.encrypt(secret), contextMessageCount, systemPrompt }, updatedBy)
    if (!result.success) throw new Error('保存模型配置失败')
    cachedModels = []; modelsSyncedAt = null
    if (env === process.env) { env.DASHSCOPE_BASE_URL = baseURL; env.DASHSCOPE_MODEL = model; env.DASHSCOPE_API_KEY = secret }
    return getStatus()
  }

  async function getCredential() {
    const connection = await getConfig('ai_connection_config')
    if (connection?.disabled) return { secret: '', source: 'none' }
    if (connection?.credentialCiphertext) return { secret: cipher.decrypt(connection.credentialCiphertext), source: 'database' }
    const encrypted = await getConfig(CREDENTIAL_KEY)
    if (encrypted) return { secret: cipher.decrypt(encrypted), source: 'database' }
    return { secret: env.DASHSCOPE_API_KEY || '', source: env.DASHSCOPE_API_KEY ? 'environment' : 'none' }
  }

  async function getStatus() {
    const credential = await getCredential()
    const { selected, baseURL, model } = await endpoint()
    return {
      enabled: await getConfig('ai_model_service_enabled') !== false,
      defaultPromptTemplate: await getDefaultPromptTemplate(),
      channelPrompts: await getChannelPrompts(),
      builtinDefaultPromptTemplate: require('./replyProtocol').DEFAULT_REPLY_TEMPLATE,
      provider: { id: selected.id, label: selected.label, baseURL, model, capabilities: selected.capabilities },
      providers: registry.list().map(({ id, label, baseURL, capabilities }) => ({ id, label, baseURL, capabilities })),
      credential: maskCredential(credential.secret, credential.source),
      models: [...cachedModels], modelsSyncedAt, replySettings: await getReplySettings()
    }
  }

  async function getDefaultPromptTemplate() {
    return await getConfig('ai_default_reply_template') || require('./replyProtocol').DEFAULT_REPLY_TEMPLATE
  }
  async function saveDefaultPromptTemplate(template, updatedBy) {
    if (typeof template !== 'string' || !template.trim() || template.length > 20000) throw new Error('请填写1–20000字的默认提示词模板')
    const result = await updateConfig('ai_default_reply_template',template.trim(),updatedBy)
    if (!result.success) throw new Error('保存默认提示词模板失败')
    return getStatus()
  }

  async function getChannelPrompts() {
    const value = await getConfig('ai_channel_prompts')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  async function getChannelPrompt(channel) {
    const prompts = await getChannelPrompts()
    return Object.hasOwn(prompts,channel || '') ? prompts[channel] : ''
  }
  async function saveChannelPrompts(prompts, updatedBy) {
    if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts) || Object.keys(prompts).length > 50) throw new Error('渠道提示词格式不正确')
    const validated = {}
    for (const [channel,prompt] of Object.entries(prompts)) {
      if (!/^[a-z][a-z0-9_-]{1,29}$/.test(channel) || ['constructor','prototype'].includes(channel)) throw new Error('渠道标识不正确')
      if (typeof prompt !== 'string' || prompt.length > 20000) throw new Error('每个渠道提示词最长20000字')
      validated[channel] = prompt.trim()
    }
    if (JSON.stringify(validated).length > 200000) throw new Error('渠道提示词总长度过长')
    const result = await updateConfig('ai_channel_prompts',validated,updatedBy)
    if (!result.success) throw new Error('保存渠道提示词失败')
    return getStatus()
  }

  async function getReplySettings() {
    const connection = await getConfig('ai_connection_config')
    const count = Number(connection?.contextMessageCount ?? await getConfig('llm_context_message_count') ?? 20)
    return { contextMessageCount: Number.isInteger(count) ? Math.max(0, Math.min(100, count)) : 20, systemPrompt: connection?.systemPrompt || '' }
  }
  async function resetConnection(updatedBy) {
    const settings = await getReplySettings()
    const result = await updateConfig('ai_connection_config', { disabled: true, baseUrl: '', model: '', credentialCiphertext: null, contextMessageCount: settings.contextMessageCount, systemPrompt: '' }, updatedBy)
    if (!result.success) throw new Error('清空连接失败')
    const cleared = await updateConfig(CREDENTIAL_KEY, null, updatedBy)
    if (!cleared.success) throw new Error('清空旧凭据失败')
    cachedModels = []; modelsSyncedAt = null
    if (env === process.env) { env.DASHSCOPE_API_KEY = ''; env.DASHSCOPE_BASE_URL = ''; env.DASHSCOPE_MODEL = '' }
    return getStatus()
  }
  async function saveCredential(secret, updatedBy) {
    const normalized = String(secret || '').trim()
    if (normalized.length < 8 || normalized.length > 500) throw new Error('API key must be between 8 and 500 characters')
    const connection = await getConfig('ai_connection_config')
    const result = connection ? await updateConfig('ai_connection_config', { ...connection, credentialCiphertext: cipher.encrypt(normalized) }, updatedBy) : await updateConfig(CREDENTIAL_KEY, cipher.encrypt(normalized), updatedBy)
    if (result.success && env === process.env) process.env.DASHSCOPE_API_KEY = normalized
    return result
  }

  async function clearCredential(updatedBy) {
    const connection = await getConfig('ai_connection_config')
    if (connection) {
      const cleared = await updateConfig('ai_connection_config', { ...connection, credentialCiphertext: null }, updatedBy)
      if (!cleared.success) return cleared
    }
    const result = await updateConfig(CREDENTIAL_KEY, null, updatedBy)
    if (result.success && env === process.env) process.env.DASHSCOPE_API_KEY = environmentFallback
    return result
  }

  async function testConnection(candidate) {
    const current = await getCredential()
    const overrides = typeof candidate === 'object' && candidate ? candidate : { apiKey: candidate }
    const apiKey = String(overrides.apiKey || '').trim() || current.secret
    if (!apiKey) throw new Error('AI provider API key is not configured')
    const { selected, baseURL, model } = await endpoint(overrides)
    return selected.testConnection({ apiKey, baseURL, model })
  }

  async function syncModels(candidate = {}) {
    const { secret } = await getCredential()
    const apiKey = String(candidate.apiKey || '').trim() || secret
    if (!apiKey) throw new Error('AI provider API key is not configured')
    const { selected, baseURL } = await endpoint(candidate)
    const models = await selected.listModels({ apiKey, baseURL })
    cachedModels = models
    modelsSyncedAt = new Date().toISOString()
    return { models: [...cachedModels], syncedAt: modelsSyncedAt }
  }

  async function getBalance() {
    const { selected, baseURL } = await endpoint()
    if (!require('./serviceMonitor').isManaged(baseURL)) return { supported: false, managed: false, reason: '自有模型密钥不统计余额' }
    const { secret } = await getCredential()
    if (!secret) return { supported: false, managed: true, reason: '请先配置服务凭证' }
    return selected.getBalance({ apiKey: secret, baseURL })
  }

  async function setEnabled(enabled, updatedBy) {
    if (typeof enabled !== 'boolean') throw new Error('启用状态必须为布尔值')
    const result = await updateConfig('ai_model_service_enabled',enabled,updatedBy)
    if (!result.success) throw new Error('保存模型启用状态失败')
    return getStatus()
  }

  async function getRuntimeConfig() {
    if (await getConfig('ai_model_service_enabled') === false) throw new Error('第三方模型服务已关闭，请在AI配置中开启')
    const { secret } = await getCredential()
    if (!secret) throw new Error('AI provider API key is not configured')
    const { selected, baseURL, model } = await endpoint()
    return { provider: selected.id, apiKey: secret, baseURL, model, defaultPromptTemplate:await getDefaultPromptTemplate(),channelPrompts:await getChannelPrompts(),...await getReplySettings() }
  }

  async function applyRuntimeCredential() {
    const { secret } = await getCredential()
    if (env === process.env && secret) process.env.DASHSCOPE_API_KEY = secret
    return Boolean(secret)
  }

  return { getStatus, getChannelPrompts, getChannelPrompt, saveChannelPrompts, getDefaultPromptTemplate, saveDefaultPromptTemplate, setEnabled, getReplySettings, resetConnection, saveConnection, saveCredential, clearCredential, testConnection, syncModels, getBalance, getRuntimeConfig, applyRuntimeCredential, _provider: provider }
}

let singleton
function getProviderService() {
  if (!singleton) {
    const configService = require('../../services/configService')
    const encryptionKey = process.env.AI_PROVIDER_CREDENTIAL_KEY || process.env.PLATFORM_CREDENTIAL_KEY
    const cipher = encryptionKey ? createCredentialCipher({ key: encryptionKey }) : {
      encrypt() { throw new Error('AI_PROVIDER_CREDENTIAL_KEY is required to save API keys') },
      decrypt() { throw new Error('AI_PROVIDER_CREDENTIAL_KEY is required to read saved API keys') }
    }
    singleton = createProviderService({
      getConfig: configService.getConfig,
      updateConfig: configService.updateConfig,
      cipher
    })
  }
  return singleton
}

module.exports = { createProviderService, getProviderService, CREDENTIAL_KEY, PROVIDER_KEY }
