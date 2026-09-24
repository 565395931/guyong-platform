const { decrypt } = require('../../../shared/utils/encrypt')

const DOUYIN_COMMERCE_ADAPTER_TYPE = 'douyin_commerce'
const REQUIRED_FIELDS = Object.freeze(['appKey', 'appSecret', 'shopId'])

function cleanCredential(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeDouyinAccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return {
    appKey: cleanCredential(source.appKey),
    appSecret: cleanCredential(source.appSecret),
    shopId: cleanCredential(source.shopId)
  }
}

function validateDouyinAccountConfig(config = {}) {
  const normalized = normalizeDouyinAccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`抖店配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'DOUYIN_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompleteDouyinAccountConfig(config = {}) {
  const normalized = normalizeDouyinAccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parseDouyinAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizeDouyinAccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizeDouyinAccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizeDouyinAccountConfig()

  try {
    return normalizeDouyinAccountConfig(JSON.parse(rawConfig))
  } catch {
    // Encrypted account configs are the normal persisted representation.
  }

  try {
    return normalizeDouyinAccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[DouyinAccountConfig] ${source} 配置解密失败，按凭据不完整处理: ${error.message}`)
    return normalizeDouyinAccountConfig()
  }
}

function prepareDouyinAccountCreation(input = {}) {
  return {
    adapterType: DOUYIN_COMMERCE_ADAPTER_TYPE,
    config: validateDouyinAccountConfig(input.config)
  }
}

module.exports = {
  DOUYIN_COMMERCE_ADAPTER_TYPE,
  normalizeDouyinAccountConfig,
  validateDouyinAccountConfig,
  hasCompleteDouyinAccountConfig,
  parseDouyinAccountConfig,
  prepareDouyinAccountCreation
}
