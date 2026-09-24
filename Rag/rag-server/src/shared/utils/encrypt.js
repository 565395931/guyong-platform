/**
 * 配置加密/解密工具
 *
 * 使用 Node 内置 crypto 模块的 AES-256-CBC 算法，
 * 加密渠道账号的敏感配置（API Key、session 等）。
 *
 * 环境变量：
 *   ENCRYPTION_KEY - 32 字节密钥（utf8 字符串，正好 32 字符）
 */

const crypto = require('crypto')

// 密钥：优先环境变量，默认值仅开发环境
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'rag_platform_32byte_default_key!!'
// 固定 IV（16 字节，AES-CBC 需要）
const IV = Buffer.from('rag_platform_iv!', 'utf8')

/**
 * 加密对象为 Base64 字符串
 * @param {Object} obj
 * @returns {string}
 */
function encrypt(obj) {
  try {
    const jsonStr = JSON.stringify(obj)
    const key = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, IV)
    let encrypted = cipher.update(jsonStr, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    return encrypted
  } catch (err) {
    console.error('[Encrypt] 加密失败:', err.message)
    throw err
  }
}

/**
 * 解密 Base64 字符串为对象
 * @param {string} encryptedStr
 * @returns {Object}
 */
function decrypt(encryptedStr) {
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32)
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, IV)
    let decrypted = decipher.update(encryptedStr, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return JSON.parse(decrypted)
  } catch (err) {
    console.error('[Encrypt] 解密失败:', err.message)
    throw err
  }
}

module.exports = { encrypt, decrypt }
