const test = require('node:test')
const assert = require('node:assert/strict')

const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')
const {
  parseEncryptedEnvelope,
  parseCallbackNotification,
  readXmlTag
} = require('../src/wecom/xmlEnvelope')

const ENCODING_AES_KEY = Buffer.alloc(32, 9).toString('base64').slice(0, 43)
const TOKEN = 'callback-token'
const RECEIVE_ID = 'ww-test-corp'
const TIMESTAMP = '1721800000'
const NONCE = 'nonce-123'

test('verifies the callback signature and decrypts the official AES payload format', () => {
  const callbackCrypto = createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID
  })
  const xml = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token><OpenKfId><![CDATA[wk-test]]></OpenKfId></xml>'
  const encrypted = callbackCrypto.encryptForTest(xml, { random: Buffer.alloc(16, 1) })
  const signature = callbackCrypto.sign(TIMESTAMP, NONCE, encrypted)

  const decrypted = callbackCrypto.decrypt({
    signature,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    encrypted
  })

  assert.equal(decrypted, xml)
  assert.deepEqual(parseCallbackNotification(decrypted), {
    event: 'kf_msg_or_event',
    token: 'sync-token',
    openKfId: 'wk-test'
  })
})

test('rejects signature tampering and an unexpected receive id', () => {
  const callbackCrypto = createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID
  })
  const encrypted = callbackCrypto.encryptForTest('<xml></xml>', { random: Buffer.alloc(16, 2) })

  assert.throws(() => callbackCrypto.decrypt({
    signature: '0'.repeat(40),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    encrypted
  }), /signature/i)

  const wrongReceiverCrypto = createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: 'ww-other-corp'
  })
  assert.throws(() => wrongReceiverCrypto.decrypt({
    signature: callbackCrypto.sign(TIMESTAMP, NONCE, encrypted),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    encrypted
  }), /receive id/i)
})

test('parses a single encrypted XML tag and rejects duplicate or oversized envelopes', () => {
  assert.deepEqual(parseEncryptedEnvelope('<xml><Encrypt><![CDATA[ciphertext]]></Encrypt></xml>'), {
    encrypted: 'ciphertext'
  })
  assert.equal(readXmlTag('<xml><Token>a&amp;b</Token></xml>', 'Token'), 'a&b')
  assert.throws(
    () => parseEncryptedEnvelope('<xml><Encrypt>a</Encrypt><Encrypt>b</Encrypt></xml>'),
    /exactly once/i
  )
  assert.throws(
    () => parseEncryptedEnvelope(`<xml><Encrypt>${'x'.repeat(1024)}</Encrypt></xml>`, { maxBytes: 100 }),
    /too large/i
  )
})

test('rejects malformed encoding keys and corrupted encrypted bodies', () => {
  assert.throws(() => createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: 'bad-key',
    receiveId: RECEIVE_ID
  }), /encodingAesKey/)

  const callbackCrypto = createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID
  })
  const encrypted = callbackCrypto.encryptForTest('<xml></xml>', { random: Buffer.alloc(16, 3) })
  const corrupted = `${encrypted.slice(0, -2)}AA`
  assert.throws(() => callbackCrypto.decrypt({
    signature: callbackCrypto.sign(TIMESTAMP, NONCE, corrupted),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    encrypted: corrupted
  }), /decrypt callback/i)
})

