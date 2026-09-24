const crypto = require('crypto')

function decodeKey(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('PLATFORM_CREDENTIAL_KEY is required')
  const key = Buffer.from(text, 'base64')
  if (key.length !== 32) throw new Error('PLATFORM_CREDENTIAL_KEY must decode to exactly 32 bytes')
  return key
}

function createCredentialCipher({ key = process.env.PLATFORM_CREDENTIAL_KEY } = {}) {
  const decodedKey = decodeKey(key)

  function encrypt(payload) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', decodedKey, iv)
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final()
    ])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.')
  }

  function decrypt(value) {
    try {
      const [version, ivText, tagText, bodyText, extra] = String(value || '').split('.')
      if (version !== 'v1' || !ivText || !tagText || !bodyText || extra) throw new Error('invalid ciphertext')
      const decipher = crypto.createDecipheriv('aes-256-gcm', decodedKey, Buffer.from(ivText, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64url')),
        decipher.final()
      ])
      return JSON.parse(cleartext.toString('utf8'))
    } catch {
      throw new Error('Unable to decrypt platform credential')
    }
  }

  return { encrypt, decrypt }
}

module.exports = { createCredentialCipher }
