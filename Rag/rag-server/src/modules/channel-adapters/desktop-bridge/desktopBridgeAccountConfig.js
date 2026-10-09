const { decrypt } = require('../../../shared/utils/encrypt')

// 桌面桥接接入：账号的凭据不是 App Key，而是"本机检测到的客户端身份"。
// 因此 config 里存的是店铺名、机器指纹与窗口句柄等检测结果，不存任何密钥。
const DESKTOP_BRIDGE_ADAPTER_TYPE = 'desktop_bridge'
const DESKTOP_BRIDGE_ADAPTER_ID = 'doudian.feige'
const REQUIRED_FIELDS = Object.freeze(['shopName', 'machineFingerprint'])

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanInteger(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null
}

function normalizeDesktopBridgeAccountConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return {
    shopName: cleanString(source.shopName),
    machineFingerprint: cleanString(source.machineFingerprint),
    adapterId: cleanString(source.adapterId) || DESKTOP_BRIDGE_ADAPTER_ID,
    hostName: cleanString(source.hostName),
    agentStatus: cleanString(source.agentStatus),
    clientProcess: cleanString(source.clientProcess),
    detectedAt: cleanString(source.detectedAt),
    windowHandle: cleanInteger(source.windowHandle),
    renderHostHandle: cleanInteger(source.renderHostHandle)
  }
}

function validateDesktopBridgeAccountConfig(config = {}) {
  const normalized = normalizeDesktopBridgeAccountConfig(config)
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`桌面桥接检测信息不完整: ${missing.join(', ')}`)
    error.code = 'DESKTOP_BRIDGE_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}

function hasCompleteDesktopBridgeAccountConfig(config = {}) {
  const normalized = normalizeDesktopBridgeAccountConfig(config)
  return REQUIRED_FIELDS.every(field => Boolean(normalized[field]))
}

function parseDesktopBridgeAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return normalizeDesktopBridgeAccountConfig()
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    return normalizeDesktopBridgeAccountConfig(rawConfig)
  }
  if (typeof rawConfig !== 'string') return normalizeDesktopBridgeAccountConfig()

  try {
    return normalizeDesktopBridgeAccountConfig(JSON.parse(rawConfig))
  } catch {
    // 加密后的账号配置是正常的持久化形态
  }

  try {
    return normalizeDesktopBridgeAccountConfig(decrypt(rawConfig))
  } catch (error) {
    console.error(`[DesktopBridgeAccountConfig] ${source} 配置解密失败，按检测信息不完整处理: ${error.message}`)
    return normalizeDesktopBridgeAccountConfig()
  }
}

/**
 * 与 douyin 等渠道一致：强制 adapterType，并返回校验后的 config。
 * 额外的 adapterId 供 desktop_bridge_bindings 使用（绑定表要求 adapter_id 非空）。
 */
function prepareDesktopBridgeAccountCreation(input = {}) {
  const config = validateDesktopBridgeAccountConfig(input.config)
  return {
    adapterType: DESKTOP_BRIDGE_ADAPTER_TYPE,
    adapterId: config.adapterId,
    config
  }
}

module.exports = {
  DESKTOP_BRIDGE_ADAPTER_TYPE,
  DESKTOP_BRIDGE_ADAPTER_ID,
  normalizeDesktopBridgeAccountConfig,
  validateDesktopBridgeAccountConfig,
  hasCompleteDesktopBridgeAccountConfig,
  parseDesktopBridgeAccountConfig,
  prepareDesktopBridgeAccountCreation
}
