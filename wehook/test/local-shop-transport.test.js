const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const WebSocket = require('ws')
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const { LocalWorkbenchPairing } = require('../src/saas/localWorkbenchPairing')
const { LocalShopTransport } = require('../src/saas/localShopTransport')
const { createEnvelope } = require('../src/protocol')
const GatewayLink = require('../../Rag/rag-server/src/modules/cloud-gateway/gatewayLink')

async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-shop-transport-'))
  const store = new FileSaasStore(path.join(dir, 'control.json'))
  await store.transaction(data => {
    for (const id of ['a', 'b']) {
      data.tenants.push({ id, status: 'active' })
      data.shopInstallations.push({ id: `shop-${id}`, tenantId: id })
      data.conversations.push({ id: `conversation-${id}`, channel: 'wechat_shop', installationId: `shop-${id}`, tenantId: id, externalUserId: `openid-${id}` })
      data.messages.push({ id: `message-${id}`, channel: 'wechat_shop', channelMessageId: `platform-${id}`, conversationId: `conversation-${id}`, tenantId: id, installationId: `shop-${id}`, direction: 'inbound', messageType: 'text', text: `hello-${id}`, createdAt: new Date().toISOString() })
    }
  })
  const pairing = new LocalWorkbenchPairing({ store })
  const sends = []
  const messaging = { sendReply: async (...args) => { sends.push(args); return { channelMessageId: 'sent-1' } } }
  const server = http.createServer((req, res) => res.end('ok'))
  const transport = new LocalShopTransport({ server, pairing, store, messaging, directory: path.join(dir, 'outbox'), intervalMs: 10 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, pairing, transport, sends, url: `ws://127.0.0.1:${server.address().port}/v1/local-shop/socket` }
}
async function pair(f, tenantId) {
  const issued = await f.pairing.issue({ tenantId, installationIds: [`shop-${tenantId}`] })
  return f.pairing.exchange({ code: issued.code })
}
function link(t, f, credentials, shopId) {
  const connection = new GatewayLink({ url: f.url, authToken: credentials.token, clientId: credentials.client.id,
    accountBindings: [{ accountId: 1, gatewayAccountId: shopId }] })
  t.after(() => connection.stop())
  return connection
}

test('paired WSS isolates equal local account IDs, keeps offline events, replies once and stops on revocation', async t => {
  const f = await fixture(t), a = await pair(f, 'a'), b = await pair(f, 'b')
  const left = link(t, f, a, 'shop-a'), right = link(t, f, b, 'shop-b')
  const receivedA = [], receivedB = [], statuses = []
  left.on('inbound', event => receivedA.push(event)); right.on('inbound', event => receivedB.push(event)); left.on('status', event => statuses.push(event))
  await Promise.all([left.connect(), right.connect()])
  await until(() => receivedA.length && receivedB.length)
  assert.equal(receivedA[0].payload.content.text, 'hello-a')
  assert.equal(receivedB[0].payload.content.text, 'hello-b')
  assert.equal(receivedA.some(event => event.payload.channelUserId === 'openid-b'), false)
  const command = createEnvelope('channel.message.send', { accountId: 1, gatewayAccountId: 'shop-a', channel: 'wechat_shop', targetUserId: 'openid-a', messageType: 'text', content: { text: 'manual reply' }, localMessageId: 'local-1', conversationId: 'local-conversation' }, { commandId: 'command-1' })
  left.send(command); await until(() => statuses.some(event => event.payload.status === 'sent'))
  left.send(command); await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][0], 'conversation-a')
  left.stop(); await new Promise(resolve => setTimeout(resolve, 30))
  const restarted = link(t, f, a, 'shop-a'), replay = []
  restarted.on('inbound', event => replay.push(event)); await restarted.connect(); await until(() => replay.length)
  assert.equal(replay[0].eventId, receivedA[0].eventId)
  const closed = once(restarted, 'authentication_rejected')
  await f.pairing.revoke(a.client.id, 'a', 'operator'); await closed
  assert.equal(restarted.stopped, true)
})

test('binding rejects cross-tenant shops, changed IDs and a second owner; revocation releases ownership', async t => {
  const f = await fixture(t), first = await pair(f, 'a')
  await assert.rejects(f.pairing.bind(first.token, [{ accountId: 1, gatewayAccountId: 'shop-b' }]), { code: 'local_binding_invalid' })
  await f.pairing.bind(first.token, [{ accountId: 1, gatewayAccountId: 'shop-a' }])
  await assert.rejects(f.pairing.bind(first.token, [{ accountId: 2, gatewayAccountId: 'shop-a' }]), { code: 'local_binding_changed' })
  const second = await pair(f, 'a')
  await assert.rejects(f.pairing.bind(second.token, [{ accountId: 1, gatewayAccountId: 'shop-a' }]), { code: 'local_shop_already_owned' })
  await f.pairing.revoke(first.client.id, 'a', 'operator')
  await f.pairing.bind(second.token, [{ accountId: 1, gatewayAccountId: 'shop-a' }])
})

test('browser-origin WebSocket cannot use workstation credentials', async t => {
  const f = await fixture(t)
  const socket = new WebSocket(f.url, { origin: 'https://untrusted.example' })
  const error = await once(socket, 'error'); assert.match(error[0].message, /403/)
})
