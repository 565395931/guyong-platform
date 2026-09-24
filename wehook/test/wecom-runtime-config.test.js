const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { createRuntimeConfigCipher: createGatewayRuntimeCipher } = require('../src/wecom/runtimeConfigCipher')
const ragModulesRoot = path.resolve(__dirname, '../../Rag/rag-server/src/modules')
const { createRuntimeConfigCipher: createRagRuntimeCipher } = require(
  path.join(ragModulesRoot, 'platform-connections/runtimeConfigCipher')
)
const { createRuntimeConfigApply } = require(
  path.join(ragModulesRoot, 'cloud-gateway/gatewayProtocol')
)
const { validateEnvelope } = require('../src/protocol')

const KEY = Buffer.alloc(32, 11).toString('base64')

test('decrypts Rag runtime ciphertext in the gateway', () => {
  const snapshot = {
    connectionId: 8,
    configVersion: 3,
    corpId: 'ww-test',
    secret: 'secret-value',
    callbackToken: 'callback-token',
    encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  }
  const ciphertext = createRagRuntimeCipher({ key: KEY }).encrypt(snapshot)

  assert.deepEqual(createGatewayRuntimeCipher({ key: KEY }).decrypt(ciphertext), snapshot)
  assert.equal(ciphertext.includes(snapshot.secret), false)
})

test('validates the shared config apply protocol contract', () => {
  const envelope = createRuntimeConfigApply({
    requestId: 'cfg-8-3',
    connectionId: 8,
    configVersion: 3,
    channel: 'wecom_kf',
    status: 'active',
    ciphertext: 'v1.iv.tag.body'
  })

  assert.equal(validateEnvelope(envelope).valid, true)
  assert.equal(validateEnvelope({
    ...envelope,
    payload: { ...envelope.payload, configVersion: 0 }
  }).valid, false)
})

