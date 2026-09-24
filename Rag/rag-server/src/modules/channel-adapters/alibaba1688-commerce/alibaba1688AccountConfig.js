const { decrypt } = require('../../../shared/utils/encrypt')

const ALIBABA1688_COMMERCE_ADAPTER_TYPE = 'alibaba1688_commerce'
const REQUIRED_FIELDS = Object.freeze(['appKey', 'appSecret', 'accessToken', 'sellerMemberId'])

function cleanCredential(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeAlibaba1688AccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return Object.fromEntries(REQUIRED_FIELDS.map(field => [field, cleanCredential(source[field])]))
}

function validateAlibaba1688AccountConfig(config = {}) {
  const normalized = normalizeAlibaba1688AccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`1688 配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'ALIBABA1688_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompleteAlibaba1688AccountConfig(config = {}) {
  const normalized = normalizeAlibaba1688AccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parseAlibaba1688AccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizeAlibaba1688AccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizeAlibaba1688AccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizeAlibaba1688AccountConfig()

  try {
    return normalizeAlibaba1688AccountConfig(JSON.parse(rawConfig))
  } catch {
    // Persisted account configs are normally encrypted.
  }

  try {
    return normalizeAlibaba1688AccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[Alibaba1688AccountConfig] ${source} 配置解密失败，按凭据不完整处理: ${error.message}`)
    return normalizeAlibaba1688AccountConfig()
  }
}

function prepareAlibaba1688AccountCreation(input = {}) {
  return {
    adapterType: ALIBABA1688_COMMERCE_ADAPTER_TYPE,
    config: validateAlibaba1688AccountConfig(input.config)
  }
}

module.exports = {
  ALIBABA1688_COMMERCE_ADAPTER_TYPE,
  normalizeAlibaba1688AccountConfig,
  validateAlibaba1688AccountConfig,
  hasCompleteAlibaba1688AccountConfig,
  parseAlibaba1688AccountConfig,
  prepareAlibaba1688AccountCreation
}
