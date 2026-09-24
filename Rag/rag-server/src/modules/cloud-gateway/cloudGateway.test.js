const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')
const { resolveCloudGatewayCredential } = require('./credentialResolver')
const { normalizeCloudGatewayTestRequest } = require('./testRequest')
const GatewayLink = require('./gatewayLink')
const GatewayInboundHandler = require('./gatewayInbound')
const GatewayAccountMapper = require('./gatewayAccount')
const { buildMockGatewayAccountId } = require('./mockAccount')
const { initCloudGateway } = require('./index')

test('云网关凭据优先使用 Mock 环境变量', () => {
  const credential = resolveCloudGatewayCredential({
    NODE_ENV: 'development',
    CLOUD_GATEWAY_AUTH_TOKEN: 'service-token',
    CLOUD_GATEWAY_MOCK_TOKEN: 'mock-token'
  }, { preferMockToken: true })

  assert.deepEqual(credential, {
    token: 'mock-token',
    configured: true,
    source: 'mock_environment'
  })
})

test('非生产环境可自动读取本地网关 token 文件', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-credential-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const tokenFile = path.join(directory, 'gateway-auth-token.txt')
  fs.writeFileSync(tokenFile, 'local-file-token\n')

  const credential = resolveCloudGatewayCredential(
    { NODE_ENV: 'development' },
    { defaultTokenFile: tokenFile }
  )

  assert.equal(credential.token, 'local-file-token')
  assert.equal(credential.configured, true)
  assert.equal(credential.source, 'local_gateway_file')
})

test('生产环境不会自动读取约定的本地 token 文件', () => {
  const credential = resolveCloudGatewayCredential(
    { NODE_ENV: 'production' },
    { defaultTokenFile: 'should-not-be-read' }
  )

  assert.deepEqual(credential, {
    token: '',
    configured: false,
    source: 'unconfigured'
  })
})

test('GatewayLink 每次连接时从凭据 provider 读取 token', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super()
      this.readyState = 1
      this.messages = []
    }

    send(value) { this.messages.push(JSON.parse(value)) }
    close() { this.readyState = 3; this.emit('close') }
  }

  const socket = new FakeSocket()
  const link = new GatewayLink({
    WebSocket: socket,
    authTokenProvider: () => 'file-token',
    handshakeTimeoutMs: 100
  })
  const connected = link.connect()
  socket.emit('open')
  const hello = socket.messages[0]
  socket.emit('message', JSON.stringify({
    protocolVersion: '0.1',
    type: 'connection.ready',
    payload: { protocolVersion: '0.1' }
  }))
  await connected

  assert.equal(hello.type, 'connection.hello')
  assert.equal(hello.payload.authToken, 'file-token')
  link.stop()
})

test('Mock 网关账号 ID 由 Rag 本地账号 ID 稳定派生', () => {
  assert.equal(buildMockGatewayAccountId(17), 'mock-account-17')
})

test('入站处理可动态加载持久化 Mock 账号映射', async () => {
  const accountMapper = new GatewayAccountMapper()
  let loaderCalls = 0
  let postProcessCall = null
  const inbound = new GatewayInboundHandler({
    accountMapper,
    accountLoader: async accountId => {
      loaderCalls += 1
      return { accountId, gatewayAccountId: buildMockGatewayAccountId(accountId), channel: 'wechat' }
    },
    messagingService: {
      processIncomingMessage: async () => ({ id: 'message-1', conversationId: 'conversation-1' })
    },
    inboundPostProcessor: async (message, eventEmitter, context) => {
      postProcessCall = { message: { ...message }, eventEmitter, context }
    }
  })

  const ack = await inbound.handle({
    eventId: 'event-1',
    payload: { accountId: 17, channel: 'wechat' }
  })

  assert.equal(ack.status, 'processed')
  assert.equal(loaderCalls, 1)
  assert.equal(accountMapper.resolveByAccountId(17).gatewayAccountId, 'mock-account-17')
  assert.equal(postProcessCall.message.conversationId, 'conversation-1')
  assert.deepEqual(postProcessCall.context, { source: 'cloud_gateway', eventId: 'event-1' })
})

test('重复网关入站消息返回 duplicate 且不会重复触发 AI 后处理', async () => {
  const accountMapper = new GatewayAccountMapper([{ accountId: 17, gatewayAccountId: 'mock-account-17', channel: 'wechat' }])
  let postProcessCalls = 0
  const inbound = new GatewayInboundHandler({
    accountMapper,
    messagingService: {
      processIncomingMessage: async () => ({ duplicate: true, id: 'message-1', conversationId: 'conversation-1' })
    },
    inboundPostProcessor: async () => { postProcessCalls += 1 }
  })

  const ack = await inbound.handle({
    eventId: 'event-duplicate',
    payload: { accountId: 17, channel: 'wechat' }
  })

  assert.equal(ack.status, 'duplicate')
  assert.equal(postProcessCalls, 0)
})

test('企业微信入站处理成功后更新连接和账号健康状态', async () => {
  const accountMapper = new GatewayAccountMapper([{ accountId: 17, gatewayAccountId: 'wk-test', channel: 'wecom_kf' }])
  const updates = []
  const inbound = new GatewayInboundHandler({
    accountMapper,
    messagingService: {
      processIncomingMessage: async () => ({ id: 'message-1', conversationId: 'conversation-1' })
    },
    inboundPostProcessor: async () => {},
    afterProcessed: async ({ envelope, message, mapping, result }) => {
      updates.push({ envelope, message: { ...message }, mapping, result })
    }
  })

  const ack = await inbound.handle({
    eventId: 'wecom-event-1',
    payload: {
      accountId: 17,
      channel: 'wecom_kf',
      channelMessageId: 'msg-1',
      metadata: { connectionId: 8 }
    }
  })

  assert.equal(ack.status, 'processed')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].message.conversationId, 'conversation-1')
  assert.equal(updates[0].mapping.gatewayAccountId, 'wk-test')
  assert.equal(updates[0].result.id, 'message-1')
})

test('网关入站公共后处理失败时返回 retryable_error ACK', async () => {
  const accountMapper = new GatewayAccountMapper([{ accountId: 17, gatewayAccountId: 'mock-account-17', channel: 'wechat' }])
  const inbound = new GatewayInboundHandler({
    accountMapper,
    messagingService: {
      processIncomingMessage: async () => ({ id: 'message-1', conversationId: 'conversation-1' })
    },
    inboundPostProcessor: async () => { throw new Error('queue unavailable') }
  })

  const ack = await inbound.handle({
    eventId: 'event-retry',
    payload: { accountId: 17, channel: 'wechat' }
  })

  assert.equal(ack.status, 'retryable_error')
  assert.equal(ack.ackForEventId, 'event-retry')
  assert.equal(ack.payload.result.error, 'queue unavailable')
})

test('结构化 Mock 入站请求保留可配置消息内容和稳定 ID', () => {
  const result = normalizeCloudGatewayTestRequest({
    operation: 'mock.inbound',
    accountId: 123,
    target: { channelUserId: 'customer-1' },
    message: {
      type: 'image',
      content: { mediaId: 'media-1', mimeType: 'image/png', caption: 'test' }
    },
    overrides: {
      eventId: 'event-1',
      channelMessageId: 'message-1',
      clientTimestamp: 1700000000000
    }
  })

  assert.deepEqual(result, {
    operation: 'mock.inbound',
    accountId: 123,
    target: { channelUserId: 'customer-1' },
    message: {
      type: 'image',
      content: { mediaId: 'media-1', mimeType: 'image/png', caption: 'test' }
    },
    overrides: {
      eventId: 'event-1',
      channelMessageId: 'message-1',
      clientTimestamp: 1700000000000
    }
  })
})

test('旧版文本请求仍可规范化为结构化请求', () => {
  const result = normalizeCloudGatewayTestRequest({
    accountId: 123,
    channelUserId: 'customer-1',
    text: ' hello '
  })

  assert.equal(result.operation, 'mock.inbound')
  assert.equal(result.message.type, 'text')
  assert.deepEqual(result.message.content, { text: 'hello' })
})

test('拒绝未协商的消息类型和空媒体 content', () => {
  assert.throws(() => normalizeCloudGatewayTestRequest({
    accountId: 123,
    channelUserId: 'customer-1',
    message: { type: 'custom', content: { value: 1 } }
  }), /消息类型仅支持/)

  assert.throws(() => normalizeCloudGatewayTestRequest({
    accountId: 123,
    channelUserId: 'customer-1',
    message: { type: 'image', content: {} }
  }), /必须填写 content/)
})

test('企业微信出站 sent 状态更新账号最近出站时间', async () => {
  const sent = []
  const fakeLink = new EventEmitter()
  fakeLink.start = () => {}
  fakeLink.send = envelope => { sent.push(envelope) }
  const statusUpdates = []
  const repository = {
    markWecomOutbound: async payload => { statusUpdates.push(payload) }
  }
  const gateway = initCloudGateway({
    eventEmitter: new EventEmitter(),
    accountEntries: [{ accountId: 17, gatewayAccountId: 'wk-test', channel: 'wecom_kf' }],
    options: {
      link: fakeLink,
      enabled: false,
      platformConnectionsRepository: repository,
      updateMessageStatus: async () => 1
    }
  })

  fakeLink.emit('status', {
    eventId: 'status-event-1',
    payload: {
      status: 'sent',
      channel: 'wecom_kf',
      accountId: 17,
      localMessageId: 'local-1',
      conversationId: 'conversation-1',
      commandId: 'cmd-1',
      channelMessageId: 'msg-1'
    }
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(statusUpdates.length, 1)
  assert.equal(statusUpdates[0].accountId, 17)
  assert.equal(sent.some(item => item.type === 'gateway.event.ack' && item.ackForEventId === 'status-event-1'), true)
  assert.equal(gateway.accountMapper.resolveByAccountId(17).channel, 'wecom_kf')
})
