const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')

const { createGateway, createHealthServer } = require('../src')
const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')

const ragModulesRoot = path.resolve(__dirname, '../../Rag/rag-server/src/modules')
const GatewayLink = require(path.join(ragModulesRoot, 'cloud-gateway/gatewayLink'))
const GatewayInboundHandler = require(path.join(ragModulesRoot, 'cloud-gateway/gatewayInbound'))
const GatewayAccountMapper = require(path.join(ragModulesRoot, 'cloud-gateway/gatewayAccount'))
const { createRuntimeConfigCipher } = require(path.join(ragModulesRoot, 'platform-connections/runtimeConfigCipher'))
const { createRuntimeConfigPublisher } = require(path.join(ragModulesRoot, 'platform-connections/runtimeConfigPublisher'))

function waitFor(check, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error('condition timed out'))
      }
    }, 10)
  })
}

test('offline WeCom callback reaches Rag once through encrypted config and real WebSocket', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-offline-link-'))
  const runtimeKey = Buffer.alloc(32, 23).toString('base64')
  const encodingAesKey = Buffer.alloc(32, 29).toString('base64').slice(0, 43)
  let syncCalls = 0
  const gateway = createGateway({
    config: {
      host: '127.0.0.1',
      port: 0,
      authToken: 'offline-link-token',
      storePath: path.join(directory, 'events.json'),
      wecomRuntimeConfigKey: runtimeKey,
      wecomRuntimeConfigStorePath: path.join(directory, 'runtime-configs.json'),
      wecomSyncStateStorePath: path.join(directory, 'sync-state.json'),
      heartbeatMs: 100,
      ackTimeoutMs: 100,
      retryBaseMs: 10,
      retryMaxMs: 100,
      maxRetries: 3
    },
    accountResolver: accountId => Number(accountId) === 12,
    wecomApiClient: {
      async syncMessages(_config, { cursor }) {
        syncCalls += 1
        if (cursor === 'cursor-done') return { messages: [], nextCursor: 'cursor-done', hasMore: false }
        return {
          messages: [{
            msgid: 'msg-1',
            open_kfid: 'wk-test',
            external_userid: 'external-1',
            send_time: 1700000000,
            origin: 3,
            msgtype: 'text',
            text: { content: 'offline hello' }
          }],
          nextCursor: 'cursor-done',
          hasMore: false
        }
      },
      async sendTextMessage() {
        throw new Error('offline integration must not send platform messages')
      }
    }
  })
  const wss = gateway.server.start()
  await new Promise(resolve => wss.once('listening', resolve))
  const healthServer = createHealthServer(gateway)
  await new Promise((resolve, reject) => {
    healthServer.once('error', reject)
    healthServer.listen(0, '127.0.0.1', resolve)
  })

  const link = new GatewayLink({
    url: `ws://127.0.0.1:${wss.address().port}`,
    authToken: 'offline-link-token',
    WebSocket,
    heartbeatMs: 100,
    reconnectBaseMs: 20,
    reconnectMaxMs: 100
  })
  t.after(async () => {
    link.stop()
    await new Promise(resolve => healthServer.close(resolve))
    await gateway.server.stop()
  })

  const inboundMessages = []
  const inbound = new GatewayInboundHandler({
    accountMapper: new GatewayAccountMapper([
      { accountId: 12, gatewayAccountId: 'wk-test', channel: 'wecom_kf' }
    ]),
    messagingService: {
      async processIncomingMessage(message) {
        inboundMessages.push({ ...message })
        return { id: 'local-message-1', conversationId: 'conversation-1' }
      }
    },
    inboundPostProcessor: async () => {}
  })
  link.on('inbound', envelope => {
    inbound.handle(envelope).then(ack => link.send(ack)).catch(error => link.emit('error', error))
  })
  await link.connect()

  const publisher = createRuntimeConfigPublisher({
    getLink: () => link,
    cipher: createRuntimeConfigCipher({ key: runtimeKey }),
    randomUUID: () => 'offline-config-request',
    timeoutMs: 1000
  })
  await publisher.publish({
    connectionId: 8,
    configVersion: 1,
    callbackKey: 'callback-key-8',
    corpId: 'ww-offline',
    secret: 'offline-secret',
    callbackToken: 'offline-callback-token',
    encodingAesKey,
    accounts: [{
      accountId: 12,
      openKfId: 'wk-test',
      name: 'AI测试客服',
      status: 'active',
      protectionLevel: 'test',
      aiEnabled: false,
      allowlistEnabled: true,
      allowlist: ['external-1']
    }]
  })

  const callbackCrypto = createCallbackCrypto({
    token: 'offline-callback-token',
    encodingAesKey,
    receiveId: 'ww-offline'
  })
  const notification = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token><OpenKfId><![CDATA[wk-test]]></OpenKfId></xml>'
  const encrypted = callbackCrypto.encryptForTest(notification, { random: Buffer.alloc(16, 7) })
  const timestamp = '1721800000'
  const nonce = 'offline-nonce'
  const signature = callbackCrypto.sign(timestamp, nonce, encrypted)
  const callbackUrl = `http://127.0.0.1:${healthServer.address().port}/webhooks/wecom/callback-key-8?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`
  const callbackBody = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`

  const firstResponse = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: callbackBody
  })
  assert.equal(firstResponse.status, 200)
  assert.equal(await firstResponse.text(), 'success')
  await waitFor(() => gateway.store.getEvent('wecom:8:msg-1')?.status === 'processed')
  assert.equal(inboundMessages.length, 1)
  assert.equal(inboundMessages[0].channel, 'wecom_kf')
  assert.equal(inboundMessages[0].accountId, 12)

  const replayResponse = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: callbackBody
  })
  assert.equal(replayResponse.status, 200)
  await waitFor(() => syncCalls === 2)
  assert.equal(inboundMessages.length, 1)
})

