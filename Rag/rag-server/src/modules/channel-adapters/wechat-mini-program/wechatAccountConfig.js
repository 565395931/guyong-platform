const { decrypt } = require('../../../shared/utils/encrypt')

const WECHAT_MINI_PROGRAM_ADAPTER_TYPE = 'wechat_mini_program'
const REQUIRED_FIELDS = Object.freeze(['appId', 'appSecret'])

function cleanCredential(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeWechatMiniProgramAccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return {
    appId: cleanCredential(source.appId ?? source.app_id),
    appSecret: cleanCredential(source.appSecret ?? source.app_secret)
  }
}

function validateWechatMiniProgramAccountConfig(config = {}) {
  const normalized = normalizeWechatMiniProgramAccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`微信小程序配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'WECHAT_MINI_PROGRAM_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompleteWechatMiniProgramAccountConfig(config = {}) {
  const normalized = normalizeWechatMiniProgramAccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parseWechatMiniProgramAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizeWechatMiniProgramAccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizeWechatMiniProgramAccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizeWechatMiniProgramAccountConfig()

  try {
    return normalizeWechatMiniProgramAccountConfig(JSON.parse(rawConfig))
  } catch {
    // Persisted account configs are normally encrypted.
  }

  try {
    return normalizeWechatMiniProgramAccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[WechatMiniProgramAccountConfig] ${source} 配置解密失败，按空配置处理: ${error.message}`)
    return normalizeWechatMiniProgramAccountConfig()
  }
}

function prepareWechatMiniProgramAccountCreation(input = {}) {
  return {
    adapterType: WECHAT_MINI_PROGRAM_ADAPTER_TYPE,
    config: validateWechatMiniProgramAccountConfig(input.config)
  }
}

module.exports = {
  WECHAT_MINI_PROGRAM_ADAPTER_TYPE,
  normalizeWechatMiniProgramAccountConfig,
  validateWechatMiniProgramAccountConfig,
  hasCompleteWechatMiniProgramAccountConfig,
  parseWechatMiniProgramAccountConfig,
  prepareWechatMiniProgramAccountCreation
}
