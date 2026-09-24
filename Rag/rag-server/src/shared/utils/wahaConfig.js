const { decrypt } = require('./encrypt')

/**
 * 解析 WAHA 账号配置（兼容明文 JSON、对象、加密字符串）
 *
 * @param {string|Object|null} rawConfig - 原始配置
 * @param {string} source - 来源标识（用于日志，如 "accountId=4"）
 * @returns {Object} 解析后的配置对象
 */
function parseWahaAccountConfig(rawConfig, source = 'unknown') {
  if (!rawConfig) return {}

  if (typeof rawConfig === 'object') {
    return rawConfig
  }

  if (typeof rawConfig !== 'string') {
    return {}
  }

  try {
    return JSON.parse(rawConfig)
  } catch {
    // 不是明文 JSON，继续尝试解密
  }

  try {
    return decrypt(rawConfig)
  } catch (err) {
    // 解密失败：这是一个严重问题，可能导致实例解析错误。
    // 使用 error 级别日志（不 throw，避免单个坏配置导致整个列表接口崩溃），
    // WahaRegistry.validate() 会在启动时检测并报告此类问题。
    console.error(`[WahaConfig] ${source} 配置解密失败，返回空配置。请检查 ENCRYPTION_KEY 或重新绑定该账号。错误: ${err.message}`)
    return {}
  }
}

module.exports = { parseWahaAccountConfig }
