const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')
const WebSocket = require('ws')

const { createGateway } = require('../src')
const ragGatewayRoot = path.resolve(__dirname, '../../Rag/rag-server/src/modules/cloud-gateway')
const { createAck } = require(path.join(ragGatewayRoot, 'gatewayProtocol'))
const GatewayLink = require(path.join(ragGatewayRoot, 'gatewayLink'))
const GatewayInboundHandler = require(path.join(ragGatewayRoot, 'gatewayInbound'))
const GatewayOutboundDispatcher = require(path.join(ragGatewayRoot, 'gatewayOutboundDispatcher'))

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

test('真实 WebSocket：Rag 主动连接、入站 ACK、出站状态闭环', async t => {
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wehook-link-')), 'store.json')
  const gateway = createGateway({
    config: {
      host: '127.0.0.1',
      port: 0,
      authToken: 'local-link-token',
      storePath,
      heartbeatMs: 100,
      ackTimeoutMs: 100,
      maxRetries: 3
    },
    accountResolver: accountId => accountId === 123
  })
  const wss = gateway.server.start()
  await EventEmitter.once(wss, 'listening')
  const port = wss.address().port

  const link = new GatewayLink({
    url: `ws://127.0.0.1:${port}`,
    authToken: 'local-link-token',
    WebSocket,
    heartbeatMs: 100,
    reconnectBaseMs: 20,
    reconnectMaxMs: 100
  })
  t.after(async () => {
    link.stop()
    await gateway.server.stop()
  })

  const inboundCalls = []
  const postProcessCalls = []
  const inbound = new GatewayInboundHandler({
    messagingService: {
      processIncomingMessage: async message => {
        inboundCalls.push(message)
        return { id: 'rag-local-message-1', conversationId: 'rag-conversation-1' }
      }
    },
    inboundPostProcessor: async (message, eventEmitter, context) => {
      postProcessCalls.push({ message: { ...message }, eventEmitter, context })
    },
    eventEmitter: new EventEmitter(),
    accountMapper: { has: accountId => accountId === 123 }
  })
  link.on('inbound', envelope => inbound.handle(envelope).then(ack => link.send(ack)))

  const statuses = []
  link.on('status', envelope => {
    statuses.push(envelope)
    link.send(createAck(envelope.eventId, 'processed', { localMessageId: envelope.payload.localMessageId }))
  })
  const ready = EventEmitter.once(link, 'ready')
  await link.connect()
  await ready

  gateway.server.ingestInbound({
    channel: 'wechat',
    accountId: 123,
    channelAccountId: 'corp-local',
    channelUserId: 'customer-local',
    direction: 'inbound',
    messageType: 'text',
    content: { text: 'local integration message' },
    channelMessageId: 'wx-local-1',
    clientTimestamp: Date.now(),
    serverTimestamp: Date.now()
  }, 'local-inbound-event-1')

  await waitFor(() => gateway.store.getEvent('local-inbound-event-1')?.status === 'processed')
  assert.equal(inboundCalls.length, 1)
  assert.equal(postProcessCalls.length, 1)
  assert.equal(postProcessCalls[0].message.conversationId, 'rag-conversation-1')
  assert.deepEqual(postProcessCalls[0].context, { source: 'cloud_gateway', eventId: 'local-inbound-event-1' })

  const dispatcher = new GatewayOutboundDispatcher({
    cloudLink: link,
    useCloud: () => true,
    gatewayAccountResolver: () => ({ gatewayAccountId: 'corp-local' })
  })
  const result = await dispatcher.dispatch({
    commandId: 'local-command-1',
    conversationId: 'rag-conversation-1',
    localMessageId: 'rag-local-message-2',
    channel: 'wechat',
    accountId: 123,
    targetUserId: 'customer-local',
    messageType: 'text',
    content: { text: 'local outbound message' }
  })
  assert.equal(result.status, 'accepted')
  await waitFor(() => statuses.some(envelope => envelope.type === 'channel.message.status'))
  assert.equal(gateway.provider.calls.length, 1)
  assert.equal(statuses.some(envelope => envelope.payload.status === 'sent'), true)
  await waitFor(() => gateway.store.listPending().length === 0)
})
