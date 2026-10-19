const crypto = require('crypto')

function decodeKey(value) {
  const raw = String(value || '').trim()
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 32) return decoded
  throw new Error('CONTROL_PLANE_DATA_KEY must be a 32-byte Base64 or 64-character hex key')
}

function createSecretCipher(keyValue) {
  const key = decodeKey(keyValue)
  return {
    encrypt(value) {
      if (!value) return null
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
      return `v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
    },
    decrypt(value) {
      if (!value) return ''
      const [version, payload] = String(value).split(':')
      if (version !== 'v1' || !payload) throw new Error('encrypted secret format is invalid')
      const [iv, tag, encrypted] = payload.split('.').map(part => Buffer.from(part, 'base64url'))
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    }
  }
}

module.exports = { createSecretCipher, decodeKey }
