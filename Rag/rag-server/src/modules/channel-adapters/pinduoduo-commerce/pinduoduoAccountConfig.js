const { decrypt } = require('../../../shared/utils/encrypt')

const PINDUODUO_COMMERCE_ADAPTER_TYPE = 'pinduoduo_commerce'
const REQUIRED_FIELDS = Object.freeze(['clientId', 'clientSecret', 'accessToken', 'mallId'])

function cleanCredential(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePinduoduoAccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return Object.fromEntries(REQUIRED_FIELDS.map(field => [field, cleanCredential(source[field])]))
}

function validatePinduoduoAccountConfig(config = {}) {
  const normalized = normalizePinduoduoAccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`拼多多配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'PINDUODUO_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompletePinduoduoAccountConfig(config = {}) {
  const normalized = normalizePinduoduoAccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parsePinduoduoAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizePinduoduoAccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizePinduoduoAccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizePinduoduoAccountConfig()

  try {
    return normalizePinduoduoAccountConfig(JSON.parse(rawConfig))
  } catch {
    // Persisted account configs are normally encrypted.
  }

  try {
    return normalizePinduoduoAccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[PinduoduoAccountConfig] ${source} 配置解密失败，按凭据不完整处理: ${error.message}`)
    return normalizePinduoduoAccountConfig()
  }
}

function preparePinduoduoAccountCreation(input = {}) {
  return {
    adapterType: PINDUODUO_COMMERCE_ADAPTER_TYPE,
    config: validatePinduoduoAccountConfig(input.config)
  }
}

module.exports = {
  PINDUODUO_COMMERCE_ADAPTER_TYPE,
  normalizePinduoduoAccountConfig,
  validatePinduoduoAccountConfig,
  hasCompletePinduoduoAccountConfig,
  parsePinduoduoAccountConfig,
  preparePinduoduoAccountCreation
}
