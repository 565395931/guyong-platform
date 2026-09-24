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

  async function getCredential() {
    const encrypted = await getConfig(CREDENTIAL_KEY)
    if (encrypted) return { secret: cipher.decrypt(encrypted), source: 'database' }
    return { secret: env.DASHSCOPE_API_KEY || '', source: env.DASHSCOPE_API_KEY ? 'environment' : 'none' }
  }

  async function getStatus() {
    const credential = await getCredential()
    return {
      provider: { id: provider.id, label: provider.label, baseURL: provider.baseURL, capabilities: provider.capabilities },
      providers: registry.list().map(({ id, label, baseURL, capabilities }) => ({ id, label, baseURL, capabilities })),
      credential: maskCredential(credential.secret, credential.source),
      models: [...cachedModels], modelsSyncedAt
    }
  }

  async function saveCredential(secret, updatedBy) {
    const normalized = String(secret || '').trim()
    if (normalized.length < 8 || normalized.length > 500) throw new Error('API key must be between 8 and 500 characters')
    const result = await updateConfig(CREDENTIAL_KEY, cipher.encrypt(normalized), updatedBy)
    if (result.success && env === process.env) process.env.DASHSCOPE_API_KEY = normalized
    return result
  }

  async function clearCredential(updatedBy) {
    const result = await updateConfig(CREDENTIAL_KEY, null, updatedBy)
    if (result.success && env === process.env) process.env.DASHSCOPE_API_KEY = environmentFallback
    return result
  }

  async function testConnection(candidate) {
    const current = await getCredential()
    const apiKey = String(candidate || '').trim() || current.secret
    if (!apiKey) throw new Error('AI provider API key is not configured')
    return provider.testConnection({ apiKey })
  }

  async function syncModels() {
    const { secret } = await getCredential()
    if (!secret) throw new Error('AI provider API key is not configured')
    const models = await provider.listModels({ apiKey: secret })
    cachedModels = models
    modelsSyncedAt = new Date().toISOString()
    return { models: [...cachedModels], syncedAt: modelsSyncedAt }
  }

  async function getBalance() {
    const { secret } = await getCredential()
    if (!secret) throw new Error('AI provider API key is not configured')
    return provider.getBalance({ apiKey: secret })
  }

  async function getRuntimeConfig() {
    const { secret } = await getCredential()
    if (!secret) throw new Error('AI provider API key is not configured')
    return { provider: provider.id, apiKey: secret, baseURL: provider.baseURL }
  }

  async function applyRuntimeCredential() {
    const { secret } = await getCredential()
    if (env === process.env && secret) process.env.DASHSCOPE_API_KEY = secret
    return Boolean(secret)
  }

  return { getStatus, saveCredential, clearCredential, testConnection, syncModels, getBalance, getRuntimeConfig, applyRuntimeCredential, _provider: provider }
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
