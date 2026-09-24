const test = require('node:test')
const assert = require('node:assert/strict')

const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')
const { createBootstrapCallbackServer } = require('../scripts/wecom-bootstrap-callback')

const TOKEN = 'bootstrap-token'
const ENCODING_AES_KEY = Buffer.alloc(32, 7).toString('base64').slice(0, 43)
const RECEIVE_ID = 'ww-bootstrap-corp'
const CALLBACK_KEY = 'one-time-key'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('serves a valid decrypted verification echo only on the one-time path', async t => {
  const server = createBootstrapCallbackServer({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID,
    callbackKey: CALLBACK_KEY
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = await listen(server)

  const callbackCrypto = createCallbackCrypto({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID
  })
  const encrypted = callbackCrypto.encryptForTest('verification-ok')
  const timestamp = '1784900000'
  const nonce = 'nonce-1'
  const signature = callbackCrypto.sign(timestamp, nonce, encrypted)
  const query = new URLSearchParams({
    msg_signature: signature,
    timestamp,
    nonce,
    echostr: encrypted
  })

  const response = await fetch(`http://127.0.0.1:${port}/wecom/bootstrap/${CALLBACK_KEY}?${query}`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'verification-ok')

  const wrongPath = await fetch(`http://127.0.0.1:${port}/wecom/bootstrap/wrong?${query}`)
  assert.equal(wrongPath.status, 404)
})

test('rejects a tampered verification request without returning details', async t => {
  const server = createBootstrapCallbackServer({
    token: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    receiveId: RECEIVE_ID,
    callbackKey: CALLBACK_KEY
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = await listen(server)

  const response = await fetch(
    `http://127.0.0.1:${port}/wecom/bootstrap/${CALLBACK_KEY}` +
    '?msg_signature=invalid&timestamp=1&nonce=2&echostr=invalid'
  )
  assert.equal(response.status, 400)
  assert.equal(await response.text(), 'invalid callback')
})
