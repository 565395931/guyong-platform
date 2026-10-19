const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const { createSecretCipher } = require('../src/saas/secretCipher')
const Messaging = require('../src/saas/cloudMessagingService')
const { ShopGatewayAdapter } = require('../src/saas/shopGatewayAdapter')
const GatewayServer = require('../src/gateway/gatewayServer')
const FileEventStore = require('../src/gateway/fileEventStore')
const Inbound = require('../../Rag/rag-server/src/modules/cloud-gateway/gatewayInbound')
const Mapper = require('../../Rag/rag-server/src/modules/cloud-gateway/gatewayAccount')
const EventEmitter = require('node:events')
const WebSocket = require('ws')
const { initCloudGateway } = require('../../Rag/rag-server/src/modules/cloud-gateway')
const GatewayLink = require('../../Rag/rag-server/src/modules/cloud-gateway/gatewayLink')

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-gateway-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new FileSaasStore(path.join(dir, 'cloud.json'))
  const cipher = createSecretCipher(Buffer.alloc(32, 6).toString('base64'))
  await store.transaction(data => data.shopInstallations.push({ id: 'shop-a', tenantId: 'tenant-a', appId: 'wx-a' }))
  const messaging = new Messaging({ store, cipher })
  const sends = []
  messaging.shopSender = {
    sendText: async input => { sends.push(input); return { channelMessageId: 'platform-reply' } },
    downloadMedia: async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })
  }
  const binding = { tenantId: 'tenant-a', installationId: 'shop-a', accountId: 12 }
  const gateway = new GatewayServer({ config: { host: '127.0.0.1', port: 0, authToken: 'mock-shop-link-token', heartbeatMs: 100, ackTimeoutMs: 100, maxRetries: 5 }, store: new FileEventStore(path.join(dir, 'events.json')), provider: {}, accountResolver: id => id === 12 })
  const exports = []
  const adapter = new ShopGatewayAdapter({ store, messaging, gateway, bindings: [binding], exportImage: async image => { exports.push(image); return { url: '/api/media/private-image' } } })
  gateway.commandService.provider = adapter
  const incoming = { channel: 'wechat_shop', shopInstallationId: 'shop-a', openKfId: 'wx-a', externalUserId: 'buyer-a', channelMessageId: 'incoming-1', text: '请看图片', messageType: 'image', mediaId: 'private-media-token', unionId: 'union-a', shopDetails: { orderId: '12345678901234567890' } }
  const message = await messaging.ingestInbound(incoming)
  return { store, messaging, gateway, adapter, message, sends, exports, binding }
}

test('shop-to-Rag preserves image and stable identity without remote remarks; ACK persists across restart', async t => {
  const f = await fixture(t)
  await f.store.transaction(data => data.customerProfiles.push({ channel: 'wechat_shop', tenantId: f.binding.tenantId, installationId: f.binding.installationId, externalUserId: 'buyer-a', remark: '旧备注', tags: ['新客'], revision: 1 }))
  const event = await f.adapter.ingest(f.message.id)
  const saved = []; const contexts = []
  const handler = new Inbound({ accountMapper: new Mapper([{ accountId: 12, gatewayAccountId: 'shop-a', channel: 'wechat_shop' }]),
    messagingService: { processIncomingMessage: async message => { saved.push(message); return { id: 'local-msg', conversationId: 'local-conversation' } } },
    inboundPostProcessor: async (_message, _emitter, context) => contexts.push(context)
  })
  const ack = await handler.handle(event)
  assert.equal(ack.status, 'processed')
  assert.equal(contexts[0].allowAutoReply, false)
  assert.equal(saved[0].userName, '客户 uyer-a')
  assert.equal(saved[0].channelUserId, 'buyer-a')
  assert.equal(saved[0].content.url, '/api/media/private-image')
  assert.equal(saved[0].content.shopDetails.orderId, '12345678901234567890')
  assert.equal(saved[0].content.shopContext.customerProfile, undefined)
  assert.equal(saved[0].content.shopContext.customerIdentitySource, 'openid')
  assert.equal(JSON.stringify(event).includes('private-media-token'), false)
  assert.equal(JSON.stringify(event).includes('/v1/admin/'), false)
  await f.gateway.store.acknowledge(event.eventId, ack.status, ack.result)
  const restored = new FileEventStore(f.gateway.store.filePath)
  assert.equal(restored.listPending().length, 0)
  await f.store.transaction(data => { data.customerProfiles[0].remark = '新备注' })
  const duplicate = await f.adapter.ingest(f.message.id)
  assert.equal(duplicate.eventId, event.eventId)
  assert.equal(duplicate.duplicate, true)
  assert.equal(f.exports.length, 1)
})

test('manual reply resolves cloud conversation by shop/OpenID, replay sends only once', async t => {
  const f = await fixture(t)
  const command = { commandId: 'send-1', payload: { channel: 'wechat_shop', accountId: 12, gatewayAccountId: 'shop-a', targetUserId: 'buyer-a', conversationId: 'local-uuid-not-cloud-uuid', localMessageId: 'local-reply', messageType: 'text', content: { text: '收到，帮您看看' } } }
  const result = await f.gateway.commandService.handle(command)
  assert.equal(result.status, 'sent')
  assert.equal(result.channelMessageId, 'platform-reply')
  await f.gateway.commandService.handle(command)
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].conversation.id, f.message.conversationId)
  assert.equal(f.sends[0].requestId, command.commandId)
  const changed = structuredClone(command); changed.payload.content.text = '另一个回复'
  await assert.rejects(f.gateway.commandService.handle(changed), { code: 'command_id_conflict' })
})

test('crossed tenant/account/OpenID and unsupported reply fail closed', async t => {
  const f = await fixture(t)
  const command = { commandId: 'send-2', payload: { channel: 'wechat_shop', accountId: 12, gatewayAccountId: 'shop-a', targetUserId: 'buyer-a', messageType: 'text', content: { text: 'hello' } } }
  for (const change of [{ accountId: 13 }, { gatewayAccountId: 'shop-b' }, { targetUserId: 'another-buyer' }, { messageType: 'image' }]) {
    await assert.rejects(f.adapter.send({ ...command, payload: { ...command.payload, ...change } }))
  }
  assert.equal(f.sends.length, 0)
  const other = new ShopGatewayAdapter({ store: f.store, messaging: f.messaging, gateway: f.gateway, bindings: [{ ...f.binding, tenantId: 'other-tenant' }] })
  await assert.rejects(other.ingest(f.message.id), { code: 'shop_binding_missing' })
})

test('image exporter failure does not enqueue a broken media event', async t => {
  const f = await fixture(t)
  f.adapter.exportImage = null
  await assert.rejects(f.adapter.ingest(f.message.id), { code: 'shop_media_export_required' })
  assert.equal(f.gateway.store.listPending().length, 0)
})

function waitFor(check) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('mock link timeout')) }
    }, 10)
  })
}

test('real local WebSocket replays offline shop image, persists Rag ACK and delivers manual reply status', async t => {
  const f = await fixture(t)
  const event = await f.adapter.ingest(f.message.id) // durable before Rag connects
  const wss = f.gateway.start()
  await EventEmitter.once(wss, 'listening')
  const link = new GatewayLink({ url: `ws://127.0.0.1:${wss.address().port}`, authToken: 'mock-shop-link-token', WebSocket, heartbeatMs: 100 })
  t.after(async () => { link.stop(); await f.gateway.stop() })
  const inbound = []; const statuses = []; const contexts = []
  const local = initCloudGateway({ accountEntries: [{ accountId: 12, gatewayAccountId: 'shop-a', channel: 'wechat_shop' }], options: {
    enabled: false, link,
    messagingService: { processIncomingMessage: async message => { inbound.push(message); return { id: 'local-image', conversationId: 'local-conv' } } },
    inboundPostProcessor: async (_message, _emitter, context) => contexts.push(context),
    updateMessageStatus: async payload => { statuses.push(payload); return 1 }
  } })
  await link.connect()
  await waitFor(() => f.gateway.store.getEvent(event.eventId)?.status === 'processed')
  assert.equal(inbound.length, 1)
  assert.equal(contexts[0].allowAutoReply, false)
  // Explicit test-only cloud routing; no production account is enabled.
  local.dispatcher.useCloud = () => true
  const accepted = await local.dispatcher.dispatch({ commandId: 'ws-reply', localMessageId: 'local-reply', conversationId: 'local-conv', channel: 'wechat_shop', accountId: 12, targetUserId: 'buyer-a', messageType: 'text', content: { text: '测试人工回复' } })
  assert.equal(accepted.status, 'accepted')
  await waitFor(() => statuses.some(row => row.sendStatus === 'sent'))
  assert.equal(f.sends.length, 1)
  await waitFor(() => f.gateway.store.listPending().length === 0)
})
