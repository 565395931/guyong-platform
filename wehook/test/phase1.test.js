const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')

const { createGateway, createHealthServer } = require('../src')
const { loadConfig } = require('../src/config')
const { createEnvelope } = require('../src/protocol')
const FileEventStore = require('../src/gateway/fileEventStore')
const ragGatewayRoot = path.resolve(__dirname, '../../Rag/rag-server/src/modules/cloud-gateway')
const { createAck, createSendCommand } = require(path.join(ragGatewayRoot, 'gatewayProtocol'))
const GatewayInboundHandler = require(path.join(ragGatewayRoot, 'gatewayInbound'))
const GatewayLink = require(path.join(ragGatewayRoot, 'gatewayLink'))

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = [] }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.emit('close') }
}

function makeGateway(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wehook-phase1-'))
  const config = { authToken: 'test-token', maxRetries: 2, ackTimeoutMs: 10000, storePath: path.join(dir, 'store.json'), ...(options.config || {}) }
  const { config: _ignored, ...rest } = options
  return createGateway({ ...rest, config })
}

test('认证成功后持久化入站事件并使用 ackForEventId 完成确认', async () => {
  const gateway = makeGateway({ accountResolver: accountId => accountId === 123 })
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  socket.emit('message', JSON.stringify(createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-test' })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.authenticated, true)
  assert.equal(socket.sent.at(-1).type, 'gateway.replay.completed')

  const payload = {
    channel: 'qianniu', accountId: 123, channelAccountId: 'gw-1', channelUserId: 'u-1',
    direction: 'inbound', messageType: 'text', content: { text: 'hello' }, channelMessageId: 'm-1'
  }
  const event = gateway.server.ingestInbound(payload, 'event-1')
  assert.equal(event.eventId, 'event-1')
  assert.equal(socket.sent.some(item => item.eventId === 'event-1'), true)
  socket.emit('message', JSON.stringify(createAck('event-1', 'processed', { messageId: 'local-1' })))
  assert.equal(gateway.store.getEvent('event-1').status, 'processed')
  assert.equal(gateway.store.getCursor(), 1)
  const duplicate = gateway.server.ingestInbound(payload, 'event-1')
  assert.equal(duplicate.duplicate, true)
})

test('未知账号进入死信且不投递', () => {
  const gateway = makeGateway({ accountResolver: () => false })
  const event = gateway.server.ingestInbound({ channel: 'qianniu', accountId: 999, channelUserId: 'u', messageType: 'text', content: { text: 'bad' } }, 'bad-1')
  assert.equal(event.status, 'dead_letter')
  assert.equal(gateway.store.listDeadLetters().length, 1)
})

test('认证失败会关闭连接', () => {
  const gateway = makeGateway()
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  socket.emit('message', JSON.stringify(createEnvelope('connection.hello', { authToken: 'wrong-token', clientId: 'rag-test' })))
  assert.equal(client.authenticated, false)
  assert.equal(socket.readyState, 3)
  assert.equal(socket.sent.some(item => item.payload?.code === 'unauthorized'), true)
})

test('Rag 离线期间持久化，认证后按游标重放', async () => {
  const gateway = makeGateway({ accountResolver: () => true })
  gateway.server.ingestInbound({ channel: 'qianniu', accountId: 123, channelUserId: 'u', messageType: 'text', content: { text: 'offline' } }, 'offline-1')
  const socket = new FakeSocket()
  gateway.server.attachSocket(socket)
  socket.emit('message', JSON.stringify(createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-test', lastCursor: 0 })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(socket.sent.some(item => item.eventId === 'offline-1'), true)
})

test('ACK 丢失会重试相同 eventId', async () => {
  const gateway = makeGateway({ config: { authToken: 'test-token', maxRetries: 2, ackTimeoutMs: 15 } , accountResolver: () => true })
  const socket = new FakeSocket()
  socket.emit('noop')
  gateway.server.attachSocket(socket)
  socket.emit('message', JSON.stringify(createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-test' })))
  gateway.server.ingestInbound({ channel: 'qianniu', accountId: 123, channelUserId: 'u', messageType: 'text', content: { text: 'retry' } }, 'retry-1')
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(socket.sent.filter(item => item.eventId === 'retry-1').length >= 2, true)
  assert.equal(gateway.store.getEvent('retry-1').deliveryAttempt >= 2, true)
})

test('重复 commandId 只调用一次 Mock Provider', async () => {
  const gateway = makeGateway()
  const command = createSendCommand({ commandId: 'cmd-1', conversationId: 'c-1', localMessageId: 'm-1', channel: 'qianniu', accountId: 123, targetUserId: 'u-1', messageType: 'text', content: { text: 'reply' } })
  const first = await gateway.server.commandService.handle(command)
  const second = await gateway.server.commandService.handle(command)
  assert.equal(first.status, 'sent')
  assert.deepEqual(second, first)
  assert.equal(gateway.provider.calls.length, 1)
})

test('Rag 入站处理映射 processed/duplicate/retryable_error ACK', async () => {
  const calls = []
  const postProcessCalls = []
  const handler = new GatewayInboundHandler({
    accountMapper: { has: id => id === 123 },
    eventEmitter: new EventEmitter(),
    messagingService: { processIncomingMessage: async message => { calls.push(message); return { id: 'local-1', conversationId: 'conv-1' } } },
    inboundPostProcessor: async (message, eventEmitter, context) => { postProcessCalls.push({ message, eventEmitter, context }) }
  })
  const ack = await handler.handle({ eventId: 'event-2', payload: { accountId: 123, channel: 'qianniu', channelUserId: 'u', messageType: 'text', content: { text: 'x' } } })
  assert.equal(ack.status, 'processed')
  assert.equal(ack.ackForEventId, 'event-2')
  assert.equal(calls.length, 1)
  assert.equal(postProcessCalls.length, 1)
  assert.equal(postProcessCalls[0].message.conversationId, 'conv-1')
  assert.deepEqual(postProcessCalls[0].context, { source: 'cloud_gateway', eventId: 'event-2' })
})

test('心跳超时会关闭 Rag 云网关连接', async () => {
  const socket = new FakeSocket()
  const link = new GatewayLink({ WebSocket: socket, heartbeatMs: 5 })
  link.socket = socket
  link.stopped = false
  link.lastPongAt = Date.now() - 50
  link.startHeartbeat()
  await new Promise(resolve => setTimeout(resolve, 15))
  link.stop()
  assert.equal(socket.readyState, 3)
})

test('游标只推进到连续终态，不跨过未确认事件', () => {
  const gateway = makeGateway({ accountResolver: () => true })
  gateway.server.ingestInbound({ channel: 'wechat', accountId: 123, channelUserId: 'u-1', messageType: 'text', content: { text: 'first' } }, 'cursor-1')
  gateway.server.ingestInbound({ channel: 'wechat', accountId: 123, channelUserId: 'u-1', messageType: 'text', content: { text: 'second' } }, 'cursor-2')
  gateway.store.acknowledge('cursor-2', 'processed')
  assert.equal(gateway.store.getCursor(), 0)
  gateway.store.acknowledge('cursor-1', 'processed')
  assert.equal(gateway.store.getCursor(), 2)
})

test('出站 accepted/status 先持久化，Rag 重连后可重放并 ACK', async () => {
  const firstGateway = makeGateway()
  const command = createSendCommand({ commandId: 'cmd-replay', conversationId: 'c-1', localMessageId: 'm-1', channel: 'wechat', accountId: 123, targetUserId: 'u-1', messageType: 'text', content: { text: 'reply' } })
  await firstGateway.server.commandService.handle(command)
  assert.deepEqual(firstGateway.store.listPending().map(event => event.type), ['channel.message.accepted', 'channel.message.status'])

  const gateway = createGateway({ config: firstGateway.config, accountResolver: () => true })
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  await gateway.server.handleMessage(client, createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-replay', lastCursor: 0 }))
  const replayed = socket.sent.filter(event => ['channel.message.accepted', 'channel.message.status'].includes(event.type))
  assert.equal(replayed.length, 2)
  for (const event of replayed) await gateway.server.handleMessage(client, createAck(event.eventId, 'processed'))
  assert.equal(gateway.store.listPending().length, 0)
  const sentBeforeDuplicate = socket.sent.length
  await gateway.server.handleMessage(client, command)
  assert.equal(gateway.provider.calls.length, 0)
  assert.equal(socket.sent.slice(sentBeforeDuplicate).some(event => event.type === 'channel.message.status' && event.replayed === true), true)
})

test('重复 commandId 的不同 payload 被拒绝且不重复调用 Provider', async () => {
  const gateway = makeGateway()
  const first = createSendCommand({ commandId: 'cmd-conflict', conversationId: 'c-1', localMessageId: 'm-1', channel: 'wechat', accountId: 123, targetUserId: 'u-1', messageType: 'text', content: { text: 'first' } })
  const second = createSendCommand({ commandId: 'cmd-conflict', conversationId: 'c-1', localMessageId: 'm-1', channel: 'wechat', accountId: 123, targetUserId: 'u-1', messageType: 'text', content: { text: 'changed' } })
  await gateway.server.commandService.handle(first)
  await assert.rejects(() => gateway.server.commandService.handle(second), error => error.code === 'command_id_conflict')
  assert.equal(gateway.provider.calls.length, 1)
})

test('未在时限内发送 hello 的连接会被认证超时关闭', async () => {
  const gateway = makeGateway({ config: { authToken: 'test-token', authTimeoutMs: 5, maxRetries: 2, ackTimeoutMs: 20 } })
  const socket = new FakeSocket()
  gateway.server.attachSocket(socket)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(socket.readyState, 3)
  assert.equal(socket.sent.some(item => item.payload?.code === 'authentication_timeout'), true)
})

test('Rag rejected ACK 将坏事件转入死信且不再重试', async () => {
  const gateway = makeGateway({ accountResolver: () => true })
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  await gateway.server.handleMessage(client, createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-reject' }))
  gateway.server.ingestInbound({ channel: 'wechat', accountId: 123, channelUserId: 'u-1', messageType: 'text', content: { text: 'reject me' } }, 'reject-1')
  await gateway.server.handleMessage(client, createAck('reject-1', 'rejected', { reason: 'permanent validation failure' }))
  assert.equal(gateway.store.getEvent('reject-1').status, 'dead_letter')
  assert.equal(gateway.store.listDeadLetters().length, 1)
})

test('Mock Provider failed 状态持久化且重复命令只回放结果', async () => {
  const gateway = makeGateway({ providerOptions: { defaultOutcome: 'failed' } })
  const command = createSendCommand({ commandId: 'cmd-failed', conversationId: 'c-1', localMessageId: 'm-1', channel: 'wechat', accountId: 123, targetUserId: 'u-1', messageType: 'text', content: { text: 'fail' } })
  const first = await gateway.server.commandService.handle(command)
  const second = await gateway.server.commandService.handle(command)
  assert.equal(first.status, 'failed')
  assert.deepEqual(second, first)
  assert.equal(gateway.provider.calls.length, 1)
  assert.equal(gateway.store.listPending().some(event => event.type === 'channel.message.status' && event.payload.status === 'failed'), true)
})

test('相同 eventId 的不同 payload 被拒绝', () => {
  const gateway = makeGateway({ accountResolver: () => true })
  gateway.server.ingestInbound({ channel: 'wechat', accountId: 123, channelUserId: 'u-1', messageType: 'text', content: { text: 'first' } }, 'event-conflict')
  assert.throws(
    () => gateway.server.ingestInbound({ channel: 'wechat', accountId: 123, channelUserId: 'u-1', messageType: 'text', content: { text: 'changed' } }, 'event-conflict'),
    error => error.code === 'event_id_conflict'
  )
})

test('生产配置要求独立服务 token，TLS 证书和私钥必须成对', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /GATEWAY_AUTH_TOKEN/)
  assert.throws(() => loadConfig({ GATEWAY_AUTH_TOKEN: 'token', GATEWAY_TLS_CERT_PATH: './cert.pem' }), /configured together/)
})

test('死信记录在 Rag 重连后按游标回放', async () => {
  const firstGateway = makeGateway({ accountResolver: () => false })
  firstGateway.server.ingestInbound({ channel: 'wechat', accountId: 999, channelUserId: 'u-1', messageType: 'text', content: { text: 'bad' } }, 'dead-replay-1')
  const gateway = createGateway({ config: firstGateway.config, accountResolver: () => true })
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  await gateway.server.handleMessage(client, createEnvelope('connection.hello', { authToken: 'test-token', clientId: 'rag-dead-replay', lastCursor: 0 }))
  assert.equal(socket.sent.some(event => event.type === 'gateway.dead_letter' && event.payload.eventId === 'dead-replay-1'), true)
})

test('开发环境 mock/inbound 接口鉴权后持久化入站事件', async t => {
  const gateway = makeGateway({ accountResolver: () => true })
  gateway.config.nodeEnv = 'development'
  gateway.config.mockInboundEnabled = true
  gateway.config.mockInboundToken = 'mock-test-token'
  const healthServer = createHealthServer(gateway)
  await new Promise((resolve, reject) => {
    healthServer.once('error', reject)
    healthServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => healthServer.close(resolve)))
  const url = `http://127.0.0.1:${healthServer.address().port}/mock/inbound`
  const requestBody = {
    eventId: 'manual-http-1',
    payload: {
      channel: 'wechat',
      accountId: 123,
      channelAccountId: 'mock-account',
      channelUserId: 'mock-user',
      direction: 'inbound',
      messageType: 'text',
      content: { text: 'manual test' },
      channelMessageId: 'mock-message-1'
    }
  }

  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  })
  assert.equal(unauthorized.status, 401)

  const accepted = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer mock-test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })
  assert.equal(accepted.status, 202)
  assert.equal((await accepted.json()).data.eventId, 'manual-http-1')
  assert.equal(gateway.store.getEvent('manual-http-1').status, 'pending')

  const eventStatus = await fetch(url.replace('/mock/inbound', '/mock/events/manual-http-1'), {
    headers: { authorization: 'Bearer mock-test-token' }
  })
  assert.equal(eventStatus.status, 200)
  const eventData = (await eventStatus.json()).data
  assert.equal(eventData.eventId, 'manual-http-1')
  assert.equal(eventData.status, 'pending')
  assert.equal('payload' in eventData, false)

  const conflict = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer mock-test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ...requestBody, payload: { ...requestBody.payload, content: { text: 'changed' } } })
  })
  assert.equal(conflict.status, 409)
})

test('生产环境不暴露 mock/inbound 接口', async t => {
  const gateway = makeGateway()
  gateway.config.nodeEnv = 'production'
  gateway.config.mockInboundEnabled = true
  const healthServer = createHealthServer(gateway)
  await new Promise((resolve, reject) => {
    healthServer.once('error', reject)
    healthServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => healthServer.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${healthServer.address().port}/mock/inbound`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ payload: {} })
  })
  assert.equal(response.status, 404)
})

test('GatewayServer 支持 MySQLStore 形式的异步存储接口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wehook-async-store-'))
  const fileStore = new FileEventStore(path.join(dir, 'store.json'))
  const methodNames = [
    'appendEvent', 'listPending', 'getEvent', 'markAttempt', 'acknowledge',
    'deadLetter', 'putCommand', 'updateCommand', 'getCommand',
    'listDeadLetters', 'getCursor', 'stats'
  ]
  const asyncStore = Object.fromEntries(methodNames.map(name => [
    name,
    async (...args) => fileStore[name](...args)
  ]))
  const gateway = createGateway({
    config: {
      nodeEnv: 'development',
      authToken: 'async-token',
      maxRetries: 2,
      ackTimeoutMs: 1000,
      retryBaseMs: 10,
      retryMaxMs: 1000
    },
    store: asyncStore,
    accountResolver: () => true
  })
  const event = await gateway.server.ingestInbound({
    channel: 'wechat',
    accountId: 123,
    channelUserId: 'async-user',
    messageType: 'text',
    content: { text: 'async store' }
  }, 'async-event-1')
  assert.equal(event.status, 'pending')
  await asyncStore.acknowledge('async-event-1', 'processed')
  assert.equal((await gateway.server.health()).cursor, 1)
})
