const test = require('node:test')
const assert = require('node:assert/strict')

const { createRuntimeConfigCipher } = require('./runtimeConfigCipher')
const {
  createRuntimeConfigApply,
  validateEnvelope
} = require('../cloud-gateway/gatewayProtocol')

const KEY = Buffer.alloc(32, 7).toString('base64')

test('encrypts a runtime snapshot without exposing credential text', () => {
  const cipher = createRuntimeConfigCipher({
    key: KEY,
    randomBytes: size => Buffer.alloc(size, 3)
  })
  const snapshot = {
    connectionId: 8,
    configVersion: 3,
    corpId: 'ww-test',
    secret: 'secret-value'
  }

  const ciphertext = cipher.encrypt(snapshot)

  assert.deepEqual(cipher.decrypt(ciphertext), snapshot)
  assert.equal(ciphertext.includes('ww-test'), false)
  assert.equal(ciphertext.includes('secret-value'), false)
})

test('rejects invalid runtime keys and tampered ciphertext', () => {
  assert.throws(() => createRuntimeConfigCipher({ key: 'bad-key' }), /32 bytes/)
  const cipher = createRuntimeConfigCipher({ key: KEY })
  const ciphertext = cipher.encrypt({ connectionId: 8 })
  const parts = ciphertext.split('.')
  parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => cipher.decrypt(parts.join('.')), /decrypt runtime config/)
})

test('creates a valid versioned runtime config apply envelope', () => {
  const envelope = createRuntimeConfigApply({
    requestId: 'cfg-8-3',
    connectionId: 8,
    configVersion: 3,
    channel: 'wecom_kf',
    status: 'active',
    ciphertext: 'v1.iv.tag.body'
  })

  assert.equal(envelope.type, 'gateway.config.apply')
  assert.equal(validateEnvelope(envelope).valid, true)
})

