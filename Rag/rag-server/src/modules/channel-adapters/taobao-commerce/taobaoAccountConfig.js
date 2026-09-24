const { decrypt } = require('../../../shared/utils/encrypt')

const TAOBAO_COMMERCE_ADAPTER_TYPE = 'taobao_commerce'
const REQUIRED_FIELDS = Object.freeze(['appKey', 'appSecret', 'sessionKey', 'sellerNick'])

function cleanCredential(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTaobaoAccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return Object.fromEntries(REQUIRED_FIELDS.map(field => [field, cleanCredential(source[field])]))
}

function validateTaobaoAccountConfig(config = {}) {
  const normalized = normalizeTaobaoAccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`淘宝配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'TAOBAO_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompleteTaobaoAccountConfig(config = {}) {
  const normalized = normalizeTaobaoAccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parseTaobaoAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizeTaobaoAccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizeTaobaoAccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizeTaobaoAccountConfig()

  try {
    return normalizeTaobaoAccountConfig(JSON.parse(rawConfig))
  } catch {
    // Persisted account configs are normally encrypted.
  }

  try {
    return normalizeTaobaoAccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[TaobaoAccountConfig] ${source} 配置解密失败，按凭据不完整处理: ${error.message}`)
    return normalizeTaobaoAccountConfig()
  }
}

function prepareTaobaoAccountCreation(input = {}) {
  return {
    adapterType: TAOBAO_COMMERCE_ADAPTER_TYPE,
    config: validateTaobaoAccountConfig(input.config)
  }
}

module.exports = {
  TAOBAO_COMMERCE_ADAPTER_TYPE,
  normalizeTaobaoAccountConfig,
  validateTaobaoAccountConfig,
  hasCompleteTaobaoAccountConfig,
  parseTaobaoAccountConfig,
  prepareTaobaoAccountCreation
}
