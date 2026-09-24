const crypto = require('crypto')

function decodeKey(value) {
  const key = Buffer.from(String(value || '').trim(), 'base64')
  if (key.length !== 32) throw new Error('AI_PROVIDER_CREDENTIAL_KEY must decode to exactly 32 bytes')
  return key
}

function createCredentialCipher({ key = process.env.AI_PROVIDER_CREDENTIAL_KEY || process.env.PLATFORM_CREDENTIAL_KEY } = {}) {
  const decodedKey = decodeKey(key)

  function encrypt(secret) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', decodedKey, iv)
    const body = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
  }

  function decrypt(value) {
    try {
      const [version, iv, tag, body, extra] = String(value || '').split('.')
      if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error('invalid ciphertext')
      const decipher = crypto.createDecipheriv('aes-256-gcm', decodedKey, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('Unable to decrypt AI provider credential')
    }
  }

  return { encrypt, decrypt }
}

module.exports = { createCredentialCipher }
