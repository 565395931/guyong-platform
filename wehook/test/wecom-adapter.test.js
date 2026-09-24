const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createHealthServer } = require('../src')
const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')
const { createWecomAdapter } = require('../src/wecom/wecomAdapter')
const WecomProvider = require('../src/wecom/wecomProvider')
const WecomSyncStateStore = require('../src/wecom/syncStateStore')

const ENCODING_AES_KEY = Buffer.alloc(32, 17).toString('base64').slice(0, 43)

function createSnapshot(overrides = {}) {
  return {
    connectionId: 8,
    configVersion: 3,
    callbackKey: 'callback-key-8',
    corpId: 'ww-test',
    secret: 'secret-value',
    callbackToken: 'callback-token',
    encodingAesKey: ENCODING_AES_KEY,
    accounts: [{
      accountId: 12,
      openKfId: 'wk-test',
      name: 'AI测试客服',
      status: 'active',
      protectionLevel: 'test',
      aiEnabled: false,
      allowlistEnabled: true,
      allowlist: ['external-1']
    }],
    ...overrides
  }
}

function encryptedCallback(snapshot, notificationXml) {
  const callbackCrypto = createCallbackCrypto({
    token: snapshot.callbackToken,
    encodingAesKey: snapshot.encodingAesKey,
    receiveId: snapshot.corpId
  })
  const encrypted = callbackCrypto.encryptForTest(notificationXml, { random: Buffer.alloc(16, 4) })
  const timestamp = '1721800000'
  const nonce = 'nonce-8'
  return {
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    query: {
      msg_signature: callbackCrypto.sign(timestamp, nonce, encrypted),
      timestamp,
      nonce
    }
  }
}

test('verifies callback echo and stores pulled customer messages with a durable cursor', async () => {
  const snapshot = createSnapshot()
  const ingested = []
  let cursor = ''
  const syncStateStore = {
    async get() { return { cursor } },
    async markSuccess(_connectionId, state) { cursor = state.cursor },
    async markFailure() {}
  }
  const apiClient = {
    async syncMessages(_config, input) {
      if (input.cursor === 'cursor-done') return { messages: [], nextCursor: 'cursor-done', hasMore: false }
      return {
        messages: [{
          msgid: 'msg-1', open_kfid: 'wk-test', external_userid: 'external-1',
          send_time: 1700000000, origin: 3, msgtype: 'text', text: { content: 'hello' }
        }],
        nextCursor: 'cursor-done',
        hasMore: false
      }
    }
  }
  const adapter = createWecomAdapter({
    runtimeConfigService: { getActiveByCallbackKey: async key => key === snapshot.callbackKey ? snapshot : null },
    apiClient,
    syncStateStore,
    ingestInbound: async (payload, eventId) => { ingested.push({ payload, eventId }) }
  })

  const callbackCrypto = createCallbackCrypto({
    token: snapshot.callbackToken,
    encodingAesKey: snapshot.encodingAesKey,
    receiveId: snapshot.corpId
  })
  const echoEncrypted = callbackCrypto.encryptForTest('verified-echo', { random: Buffer.alloc(16, 3) })
  const echo = await adapter.verifyCallback({
    callbackKey: snapshot.callbackKey,
    query: {
      msg_signature: callbackCrypto.sign('1721800000', 'nonce-echo', echoEncrypted),
      timestamp: '1721800000',
      nonce: 'nonce-echo',
      echostr: echoEncrypted
    }
  })
  assert.equal(echo, 'verified-echo')

  const callback = encryptedCallback(
    snapshot,
    '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token><OpenKfId><![CDATA[wk-test]]></OpenKfId></xml>'
  )
  const result = await adapter.handleCallback({ callbackKey: snapshot.callbackKey, ...callback })
  assert.deepEqual({ status: result.status, body: result.body }, { status: 200, body: 'success' })
  await result.processing
  assert.deepEqual(ingested.map(item => item.eventId), ['wecom:8:msg-1'])
  assert.equal(cursor, 'cursor-done')

  const replay = await adapter.handleCallback({ callbackKey: snapshot.callbackKey, ...callback })
  await replay.processing
  assert.equal(ingested.length, 1)
})

test('does not advance the sync cursor when ingestion fails', async () => {
  const snapshot = createSnapshot()
  let cursor = 'cursor-before'
  let failureCount = 0
  const adapter = createWecomAdapter({
    runtimeConfigService: { getActiveByCallbackKey: async () => snapshot },
    apiClient: {
      async syncMessages() {
        return {
          messages: [{
            msgid: 'msg-2', open_kfid: 'wk-test', external_userid: 'external-1',
            send_time: 1700000000, origin: 3, msgtype: 'text', text: { content: 'fail' }
          }],
          nextCursor: 'cursor-after',
          hasMore: false
        }
      }
    },
    syncStateStore: {
      async get() { return { cursor } },
      async markSuccess(_connectionId, state) { cursor = state.cursor },
      async markFailure() { failureCount += 1 }
    },
    ingestInbound: async () => { throw new Error('store unavailable') }
  })
  const callback = encryptedCallback(
    snapshot,
    '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token></xml>'
  )

  const result = await adapter.handleCallback({ callbackKey: snapshot.callbackKey, ...callback })
  await assert.rejects(result.processing, /store unavailable/)
  assert.equal(cursor, 'cursor-before')
  assert.equal(failureCount, 1)
})

test('provider blocks locked and non-allowlisted accounts before official API calls', async () => {
  const calls = []
  let snapshot = createSnapshot({
    accounts: [{
      accountId: 12, openKfId: 'wk-test', status: 'active', protectionLevel: 'locked',
      allowlistEnabled: true, allowlist: ['external-1']
    }]
  })
  const provider = new WecomProvider({
    runtimeConfigService: {
      async getActiveByAccountId() {
        return { runtimeConfig: snapshot, account: snapshot.accounts[0] }
      }
    },
    apiClient: { async sendTextMessage(...args) { calls.push(args); return { channelMessageId: 'platform-1' } } }
  })
  const command = {
    commandId: 'command-1',
    payload: {
      channel: 'wecom_kf', accountId: 12, targetUserId: 'external-1',
      messageType: 'text', content: { text: 'reply' }
    }
  }

  await assert.rejects(() => provider.send(command), error => error.code === 'WECOM_SEND_BLOCKED')
  snapshot = createSnapshot({
    accounts: [{
      accountId: 12, openKfId: 'wk-test', status: 'active', protectionLevel: 'test',
      allowlistEnabled: true, allowlist: ['external-allowed']
    }]
  })
  await assert.rejects(() => provider.send(command), error => error.code === 'WECOM_SEND_BLOCKED')
  assert.equal(calls.length, 0)
})

test('provider sends allowlisted text and rejects unsupported media', async () => {
  const snapshot = createSnapshot()
  const calls = []
  const provider = new WecomProvider({
    runtimeConfigService: {
      async getActiveByAccountId() {
        return { runtimeConfig: snapshot, account: snapshot.accounts[0] }
      }
    },
    apiClient: {
      async sendTextMessage(config, input) {
        calls.push({ config, input })
        return { channelMessageId: 'platform-1' }
      }
    }
  })
  const basePayload = {
    channel: 'wecom_kf', accountId: 12, targetUserId: 'external-1', content: { text: 'reply' }
  }

  const result = await provider.send({ commandId: 'command-1', payload: { ...basePayload, messageType: 'text' } })
  assert.deepEqual(result, { success: true, status: 'sent', channelMessageId: 'platform-1' })
  assert.equal(calls[0].input.openKfId, 'wk-test')
  await assert.rejects(
    () => provider.send({ commandId: 'command-2', payload: { ...basePayload, messageType: 'image' } }),
    error => error.code === 'WECOM_UNSUPPORTED_MESSAGE_TYPE'
  )
})

test('persists sync success and failure state without message content', async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-sync-state-')), 'state.json')
  const store = new WecomSyncStateStore(filePath)
  await store.markSuccess(8, { cursor: 'cursor-2' })
  await store.markFailure(8, new Error('temporary failure'))

  const reloaded = new WecomSyncStateStore(filePath)
  const state = await reloaded.get(8)
  assert.equal(state.cursor, 'cursor-2')
  assert.match(state.lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(state.lastError, 'temporary failure')
  assert.equal(state.retryCount, 1)
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('hello'), false)
})

test('routes WeCom verification and callback requests without exposing other gateway endpoints', async t => {
  const calls = []
  const gateway = {
    wecomAdapter: {
      async verifyCallback(input) {
        calls.push({ type: 'verify', input })
        return 'verified-echo'
      },
      async handleCallback(input) {
        calls.push({ type: 'callback', input })
        return { status: 200, body: 'success', processing: Promise.resolve() }
      }
    },
    server: { async health() { return { status: 'ok', metrics: {} } } },
    config: { nodeEnv: 'development', mockInboundEnabled: false }
  }
  const server = createHealthServer(gateway)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/webhooks/wecom/callback-key-8`

  const verifyResponse = await fetch(`${base}?msg_signature=sig&timestamp=1&nonce=2&echostr=echo`)
  assert.equal(verifyResponse.status, 200)
  assert.equal(await verifyResponse.text(), 'verified-echo')
  const callbackResponse = await fetch(`${base}?msg_signature=sig&timestamp=1&nonce=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: '<xml><Encrypt>ciphertext</Encrypt></xml>'
  })
  assert.equal(callbackResponse.status, 200)
  assert.equal(await callbackResponse.text(), 'success')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input.body.includes('ciphertext'), true)
})
