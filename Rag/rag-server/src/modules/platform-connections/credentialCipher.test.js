const test = require('node:test')
const assert = require('node:assert/strict')

const { createCredentialCipher } = require('./credentialCipher')

test('encrypts credentials with a random nonce and restores the payload', () => {
  const cipher = createCredentialCipher({ key: Buffer.alloc(32, 7).toString('base64') })
  const payload = { secret: 'test-secret', callbackToken: 'callback-token' }

  const first = cipher.encrypt(payload)
  const second = cipher.encrypt(payload)

  assert.match(first, /^v1\.[^.]+\.[^.]+\.[^.]+$/)
  assert.notEqual(first, second)
  assert.deepEqual(cipher.decrypt(first), payload)
})

test('requires an explicit 32-byte base64 key', () => {
  assert.throws(() => createCredentialCipher({ key: '' }), /PLATFORM_CREDENTIAL_KEY/)
  assert.throws(
    () => createCredentialCipher({ key: Buffer.alloc(16).toString('base64') }),
    /32 bytes/
  )
})

test('rejects tampered ciphertext', () => {
  const cipher = createCredentialCipher({ key: Buffer.alloc(32, 3).toString('base64') })
  const encrypted = cipher.encrypt({ secret: 'test-secret' })
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`

  assert.throws(() => cipher.decrypt(tampered), /decrypt platform credential/i)
})
