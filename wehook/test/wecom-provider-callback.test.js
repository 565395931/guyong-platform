const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')
const { createControlPlaneProxy, createProviderCallbackServer } = require('../src/wecom/providerCallbackServer')

const TOKEN = 'provider-callback-token'
const AES_KEY = Buffer.alloc(32, 19).toString('base64').slice(0, 43)
const SUITE_ID = 'ww-provider-suite'
const PROVIDER_CORP_ID = 'ww-provider-corp'
const CORP_ID = 'ww-authorized-corp'
const STORAGE_KEY = Buffer.alloc(32, 23).toString('base64')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function signedQuery(callbackCrypto, encrypted, timestamp = '1784900000', nonce = 'provider-nonce') {
  return new URLSearchParams({
    msg_signature: callbackCrypto.sign(timestamp, nonce, encrypted),
    timestamp,
    nonce
  })
}

test('validates data and command callback URLs with their correct receive ids', async t => {
  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-provider-'))
  const { server } = createProviderCallbackServer({ token: TOKEN, encodingAesKey: AES_KEY, suiteId: SUITE_ID, providerCorpId: PROVIDER_CORP_ID, storageKey: STORAGE_KEY, storeDirectory })
  t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => fs.rmSync(storeDirectory, { recursive: true, force: true }))
  const port = await listen(server)

  for (const item of [
    { route: `/wecom/suite/data-callback?corpid=${CORP_ID}`, receiveId: CORP_ID },
    { route: '/wecom/suite/command-callback?', receiveId: PROVIDER_CORP_ID }
  ]) {
    const callbackCrypto = createCallbackCrypto({ token: TOKEN, encodingAesKey: AES_KEY, receiveId: item.receiveId })
    const encrypted = callbackCrypto.encryptForTest(`${item.receiveId}-ok`)
    const query = signedQuery(callbackCrypto, encrypted)
    query.set('echostr', encrypted)
    const separator = item.route.endsWith('?') ? '' : '&'
    const response = await fetch(`http://127.0.0.1:${port}${item.route}${separator}${query}`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), `${item.receiveId}-ok`)
  }
})

test('persists encrypted callbacks and current suite ticket without logging the clear message', async t => {
  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-provider-'))
  const { server } = createProviderCallbackServer({
    token: TOKEN,
    encodingAesKey: AES_KEY,
    suiteId: SUITE_ID,
    providerCorpId: PROVIDER_CORP_ID,
    storageKey: STORAGE_KEY,
    storeDirectory,
    now: () => '2026-09-29T00:00:00.000Z'
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => fs.rmSync(storeDirectory, { recursive: true, force: true }))
  const port = await listen(server)
  const callbackCrypto = createCallbackCrypto({ token: TOKEN, encodingAesKey: AES_KEY, receiveId: SUITE_ID })
  const cleartext = '<xml><SuiteId><![CDATA[ww-provider-suite]]></SuiteId><InfoType><![CDATA[suite_ticket]]></InfoType><TimeStamp>1784900000</TimeStamp><SuiteTicket><![CDATA[secret-ticket-value]]></SuiteTicket></xml>'
  const encrypted = callbackCrypto.encryptForTest(cleartext)
  const query = signedQuery(callbackCrypto, encrypted)
  const envelope = `<xml><ToUserName><![CDATA[${SUITE_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`
  const response = await fetch(`http://127.0.0.1:${port}/wecom/suite/command-callback?${query}`, { method: 'POST', body: envelope })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'success')
  const events = fs.readFileSync(path.join(storeDirectory, 'callback-events.ndjson'), 'utf8')
  assert.match(events, /"kind":"command"/)
  assert.doesNotMatch(events, /secret-ticket-value/)
  const state = JSON.parse(fs.readFileSync(path.join(storeDirectory, 'command-state.json'), 'utf8'))
  assert.match(state.suiteTicketEncrypted, /^v1:/)
  assert.doesNotMatch(JSON.stringify(state), /secret-ticket-value/)
  assert.equal(state.lastInfoType, 'suite_ticket')
})

test('bridges decrypted command metadata without delaying the callback response', async t => {
  const bridged = []
  const instance = createProviderCallbackServer({
    token: TOKEN,
    encodingAesKey: AES_KEY,
    suiteId: SUITE_ID,
    providerCorpId: PROVIDER_CORP_ID,
    store: { appendEnvelope() {}, updateCommandState() {} },
    eventBridge: { async enqueue(payload) { bridged.push(payload) } },
    logger: { info() {}, warn() {} }
  })
  const port = await listen(instance.server)
  t.after(() => new Promise(resolve => instance.server.close(resolve)))
  const cleartext = `<xml><SuiteId><![CDATA[${SUITE_ID}]]></SuiteId><InfoType><![CDATA[suite_ticket]]></InfoType><SuiteTicket><![CDATA[ticket-clear]]></SuiteTicket></xml>`
  const callbackCrypto = createCallbackCrypto({ token: TOKEN, encodingAesKey: AES_KEY, receiveId: SUITE_ID })
  const encrypted = callbackCrypto.encryptForTest(cleartext, { random: Buffer.alloc(16, 6) })
  const timestamp = '1721800000', nonce = 'bridge-nonce'
  const response = await fetch(`http://127.0.0.1:${port}/wecom/suite/command-callback?msg_signature=${callbackCrypto.sign(timestamp, nonce, encrypted)}&timestamp=${timestamp}&nonce=${nonce}`, { method: 'POST', body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` })
  assert.equal(await response.text(), 'success')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bridged[0].kind, 'command')
  assert.equal(bridged[0].metadata.suiteTicket, 'ticket-clear')
})

test('does not validate a command callback until the provider CorpID is configured', async t => {
  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-provider-'))
  const { server } = createProviderCallbackServer({ token: TOKEN, encodingAesKey: AES_KEY, suiteId: SUITE_ID, storageKey: STORAGE_KEY, storeDirectory })
  t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => fs.rmSync(storeDirectory, { recursive: true, force: true }))
  const port = await listen(server)
  const response = await fetch(`http://127.0.0.1:${port}/wecom/suite/command-callback?msg_signature=x&timestamp=1&nonce=2&echostr=x`)
  assert.equal(response.status, 503)
})

test('serves only well-formed WeCom domain verification files from the dedicated directory', async t => {
  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-provider-'))
  const verificationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-verification-'))
  fs.writeFileSync(path.join(verificationDirectory, 'WW_verify_example123.txt'), 'example-verification')
  const { server } = createProviderCallbackServer({
    token: TOKEN,
    encodingAesKey: AES_KEY,
    suiteId: SUITE_ID,
    providerCorpId: PROVIDER_CORP_ID,
    storageKey: STORAGE_KEY,
    storeDirectory,
    verificationDirectory
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  t.after(() => fs.rmSync(storeDirectory, { recursive: true, force: true }))
  t.after(() => fs.rmSync(verificationDirectory, { recursive: true, force: true }))
  const port = await listen(server)

  const valid = await fetch(`http://127.0.0.1:${port}/WW_verify_example123.txt`)
  assert.equal(valid.status, 200)
  assert.equal(await valid.text(), 'example-verification')
  const invalid = await fetch(`http://127.0.0.1:${port}/WW_verify_../provider.env`)
  assert.equal(invalid.status, 404)
})

test('proxies the isolated console and API to a local control plane', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, forwardedHost: req.headers['x-forwarded-host'] }))
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const instance = createProviderCallbackServer({
    token: TOKEN,
    encodingAesKey: AES_KEY,
    suiteId: SUITE_ID,
    providerCorpId: PROVIDER_CORP_ID,
    store: { appendEnvelope() {}, updateCommandState() {} },
    controlPlaneProxy: createControlPlaneProxy(`http://127.0.0.1:${upstreamPort}`),
    logger: { info() {}, warn() {} }
  })
  const port = await listen(instance.server)
  t.after(() => new Promise(resolve => instance.server.close(resolve)))

  const consoleResponse = await fetch(`http://127.0.0.1:${port}/console`, { headers: { host: 'provider.example.test' } })
  const consolePayload = await consoleResponse.json()
  assert.equal(consolePayload.path, '/?surface=admin')
  assert.match(consolePayload.forwardedHost, /^127\.0\.0\.1:/)
  const apiResponse = await fetch(`http://127.0.0.1:${port}/v1/session?fresh=1`)
  assert.equal((await apiResponse.json()).path, '/v1/session?fresh=1')
})
