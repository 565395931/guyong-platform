const crypto = require('crypto')

function decodeEncodingAesKey(value) {
  const text = String(value || '').trim()
  if (text.length !== 43) throw new Error('encodingAesKey must contain 43 Base64 characters')
  const key = Buffer.from(`${text}=`, 'base64')
  if (key.length !== 32) throw new Error('encodingAesKey must decode to exactly 32 bytes')
  return key
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function addPkcs7Padding(value, blockSize = 32) {
  const paddingLength = blockSize - (value.length % blockSize)
  return Buffer.concat([value, Buffer.alloc(paddingLength, paddingLength)])
}

function removePkcs7Padding(value, blockSize = 32) {
  if (!value.length) throw new Error('callback padding is empty')
  const paddingLength = value[value.length - 1]
  if (paddingLength < 1 || paddingLength > blockSize || paddingLength > value.length) {
    throw new Error('callback padding is invalid')
  }
  for (let index = value.length - paddingLength; index < value.length; index += 1) {
    if (value[index] !== paddingLength) throw new Error('callback padding is invalid')
  }
  return value.subarray(0, value.length - paddingLength)
}

function createCallbackCrypto({ token, encodingAesKey, receiveId }) {
  const callbackToken = String(token || '').trim()
  const expectedReceiveId = String(receiveId || '').trim()
  if (!callbackToken) throw new Error('callback token is required')
  if (!expectedReceiveId) throw new Error('callback receive id is required')
  const key = decodeEncodingAesKey(encodingAesKey)
  const iv = key.subarray(0, 16)

  function sign(timestamp, nonce, encrypted) {
    return crypto.createHash('sha1')
      .update([callbackToken, String(timestamp || ''), String(nonce || ''), String(encrypted || '')].sort().join(''))
      .digest('hex')
  }

  function decrypt({ signature, timestamp, nonce, encrypted }) {
    const expectedSignature = sign(timestamp, nonce, encrypted)
    if (!safeEqual(signature, expectedSignature)) throw new Error('callback signature is invalid')
    try {
      const encryptedText = String(encrypted || '').trim()
      if (!encryptedText || !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedText)) {
        throw new Error('encrypted callback body is invalid')
      }
      const encryptedBody = Buffer.from(encryptedText, 'base64')
      if (!encryptedBody.length || encryptedBody.length % 16 !== 0) {
        throw new Error('encrypted callback body is invalid')
      }
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      decipher.setAutoPadding(false)
      const padded = Buffer.concat([decipher.update(encryptedBody), decipher.final()])
      const cleartext = removePkcs7Padding(padded)
      if (cleartext.length < 20) throw new Error('callback payload is truncated')
      const messageLength = cleartext.readUInt32BE(16)
      const messageEnd = 20 + messageLength
      if (messageLength < 0 || messageEnd > cleartext.length) throw new Error('callback message length is invalid')
      const message = cleartext.subarray(20, messageEnd).toString('utf8')
      const actualReceiveId = cleartext.subarray(messageEnd).toString('utf8')
      if (!safeEqual(actualReceiveId, expectedReceiveId)) {
        const error = new Error('callback receive id does not match')
        error.code = 'callback_receive_id_mismatch'
        throw error
      }
      return message
    } catch (error) {
      if (error.code === 'callback_receive_id_mismatch') throw error
      throw new Error('Unable to decrypt callback')
    }
  }

  function encryptForTest(message, { random = crypto.randomBytes(16) } = {}) {
    const randomBytes = Buffer.isBuffer(random) ? random : Buffer.from(random)
    if (randomBytes.length !== 16) throw new Error('callback random prefix must contain 16 bytes')
    const messageBuffer = Buffer.from(String(message), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(messageBuffer.length, 0)
    const cleartext = addPkcs7Padding(Buffer.concat([
      randomBytes,
      length,
      messageBuffer,
      Buffer.from(expectedReceiveId, 'utf8')
    ]))
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(cleartext), cipher.final()]).toString('base64')
  }

  return { sign, decrypt, encryptForTest }
}

module.exports = {
  addPkcs7Padding,
  createCallbackCrypto,
  decodeEncodingAesKey,
  removePkcs7Padding
}

