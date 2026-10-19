const test = require('node:test')
const assert = require('node:assert/strict')

const { createInboundBridgeService } = require('./inboundBridgeService')

test('头像和消息图片文件名按渠道账号隔离并消除路径穿越', () => {
  const { bridgeMediaFilename } = require('./inboundBridgeService')
  const identity = '../../other-file'
  const first = bridgeMediaFilename('avatar', { channel: 'douyin', accountId: 1, identity })
  assert.match(first, /^bridge-avatar-[a-f0-9]{64}\.png$/)
  assert.notEqual(first, bridgeMediaFilename('avatar', { channel: 'douyin', accountId: 2, identity }))
  assert.notEqual(first, bridgeMediaFilename('avatar', { channel: 'pinduoduo', accountId: 1, identity }))
})

test('桥接消息时间与消息主链路一致保存 UTC 并保持批次顺序', () => {
  const { resolveMessageTime } = service(ACTIVE_BOUND)
  assert.equal(resolveMessageTime({ clientTimestamp: '2026-10-19T16:00:00+08:00', rawData: { batchIndex: 7 } }), '2026-10-19 08:00:00.007')
  assert.equal(resolveMessageTime({ clientTimestamp: 'invalid' }), null)
})

/** 假 sequelize：只回答 resolveAccount 的那条 JOIN 查询。 */
function fakeSequelize(accountRow) {
  return {
    async query() {
      return accountRow ? [accountRow] : []
    }
  }
}

const ACTIVE_BOUND = {
  id: 2,
  channel: 'douyin',
  status: 'active',
  account_name: '孤勇者科隔热材料',
  binding_enabled: 1,
  adapter_id: 'doudian.feige',
  preferred_node_id: null,
  lease_node_id: 2,
  lease_expires_at: '2099-01-01T00:00:00Z'
}

test('无首选节点绑定也必须持有有效租约才能提交入站', async () => {
  for (const row of [
    { ...ACTIVE_BOUND, lease_node_id: 7 },
    { ...ACTIVE_BOUND, lease_expires_at: '2000-01-01T00:00:00Z' }
  ]) {
    const result = await service(row).handle({ nodeId: 2, envelope: { payload: { accountId: 2, channel: 'douyin' } } })
    assert.equal(result.errorCode, 'NO_ACTIVE_LEASE')
  }
})

test('跨渠道伪造入站在消息持久化前被拒绝', async () => {
  const result = await service(ACTIVE_BOUND).handle({ nodeId: 2, envelope: { payload: { accountId: 2, channel: 'pinduoduo' } } })
  assert.equal(result.errorCode, 'CHANNEL_ACCOUNT_MISMATCH')
})

test('桌面同步不能把待人工会话改回 AI 池', async () => {
  let statement = ''
  const bridge = createInboundBridgeService({ sequelize: { query: async sql => { statement = sql; return [{ affectedRows: 0 }] } } })
  assert.equal(await bridge.ensureAiPool('conversation-test'), false)
  assert.match(statement, /pool_type = 'ai_self'[\s\S]*conv_status = 'pending_claim'/)
  assert.match(statement, /claimed_by IS NULL/)
})

function service(accountRow) {
  // processIncomingMessage 不在这些用例里被触发（handle 用无效 payload 提前返回，
  // 或只测纯函数），因此不需要 mock 掉它——它只在真实落库路径上被调用。
  return createInboundBridgeService({ sequelize: fakeSequelize(accountRow), logger: { warn() {}, error() {} } })
}

test('handle 的入参是整个信封，payload 不存在时才判缺负载', async () => {
  // 网关调用签名是 handle({ envelope, nodeId, nodeKey })。
  // 曾经因为这个签名不匹配导致所有消息被静默拒绝（PAYLOAD_REQUIRED）。
  const missing = await service(ACTIVE_BOUND).handle({
    envelope: { type: 'message.inbound', eventId: 'e-1' },
    nodeId: 2,
    nodeKey: 'node-uuid'
  })
  assert.equal(missing.status, 'rejected')
  assert.equal(missing.errorCode, 'PAYLOAD_REQUIRED')
})

test('信封里的 payload 会被真正读到（否则会走到账号校验）', async () => {
  // payload 存在但 accountId 无效 → 说明确实读到了 envelope.payload，
  // 从而进到账号校验分支，而不是在缺负载处就返回。
  const result = await service(ACTIVE_BOUND).handle({
    envelope: { payload: { accountId: undefined } }, nodeId: 2
  })
  assert.equal(result.errorCode, 'ACCOUNT_NOT_FOUND')
})

test('payload 为空对象时不算缺负载（空对象也是对象）', async () => {
  const result = await service(ACTIVE_BOUND).handle({
    envelope: { payload: {} }, nodeId: 2
  })
  assert.equal(result.errorCode, 'ACCOUNT_NOT_FOUND')
})

test('缺少 envelope.payload 时拒绝并带出 errorCode', async () => {
  const result = await service(ACTIVE_BOUND).handle({ envelope: { eventId: 'e-2' }, nodeId: 2 })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'PAYLOAD_REQUIRED')
})

test('账号不存在时拒绝', async () => {
  const result = await service(null).handle({
    envelope: { payload: { accountId: 999 } }, nodeId: 2
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'ACCOUNT_NOT_FOUND')
})

test('账号没有启用绑定行时拒绝（否则租约永远拿不到）', async () => {
  const result = await service({ ...ACTIVE_BOUND, binding_enabled: 0 }).handle({
    envelope: { payload: { accountId: 2 } }, nodeId: 2
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'ACCOUNT_NOT_BOUND')
})

test('账号非 active 时拒绝', async () => {
  const result = await service({ ...ACTIVE_BOUND, status: 'inactive' }).handle({
    envelope: { payload: { accountId: 2 } }, nodeId: 2
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'ACCOUNT_INACTIVE')
})

test('绑定了首选节点时，只有该节点能上报', async () => {
  const row = { ...ACTIVE_BOUND, preferred_node_id: 7 }
  const wrong = await service(row).handle({ envelope: { payload: { accountId: 2 } }, nodeId: 9 })
  assert.equal(wrong.status, 'rejected')
  assert.equal(wrong.errorCode, 'NODE_NOT_BOUND')
})

test('toPlatformMessage 把 platformCustomerId 映射为会话键的 userId', () => {
  const { toPlatformMessage } = service(ACTIVE_BOUND)
  const mapped = toPlatformMessage({
    channel: 'douyin',
    accountId: 2,
    channelMessageId: 'fp-1',
    platformCustomerId: 'customer-hash',
    platformConversationId: 'conv-hash',
    userName: '某客户',
    messageType: 'text',
    content: '你好',
    clientTimestamp: '2026-09-25T10:24:31+08:00',
    platformPayload: { direction: 'in' }
  })
  // 后端按 (channel, account_id, user_id) 找会话，送错就会串台
  assert.equal(mapped.userId, 'customer-hash')
  assert.equal(mapped.channelUserId, 'customer-hash')
  assert.equal(mapped.accountId, 2)
  assert.equal(mapped.channelMessageId, 'fp-1')
  assert.equal(mapped.direction, 'inbound')
  assert.equal(mapped.content.text, '你好')
  assert.equal(mapped.clientTimestamp, '2026-09-25T10:24:31+08:00')
})

test('只有客户消息映射为 inbound，商家/系统消息为 outbound', () => {
  const { toPlatformMessage } = service(ACTIVE_BOUND)
  const base = { channel: 'douyin', accountId: 2, channelMessageId: 'fp', platformCustomerId: 'c' }

  // 商家自己发的消息若标成 inbound，processIncomingMessage 会走 AI 回复流程，
  // 造成对客户的重复自动回复。
  assert.equal(toPlatformMessage({ ...base, platformPayload: { direction: 'out' } }).direction, 'outbound')
  assert.equal(toPlatformMessage({ ...base, platformPayload: { direction: 'system' } }).direction, 'outbound')
  assert.equal(toPlatformMessage({ ...base, platformPayload: {} }).direction, 'outbound')
  assert.equal(toPlatformMessage({ ...base, platformPayload: { direction: 'in' } }).direction, 'inbound')
})

test('媒体消息用占位文本填充 content（schema 要求 content 或 media 至少有一个）', () => {
  const { toPlatformMessage } = service(ACTIVE_BOUND)
  const mapped = toPlatformMessage({
    channel: 'douyin',
    accountId: 2,
    channelMessageId: 'fp-media',
    platformCustomerId: 'c',
    messageType: 'image',
    media: [{ type: 'image' }],
    platformPayload: { direction: 'in', placeholder: 'sticker' }
  })
  assert.equal(mapped.content.text, '[sticker]')
  assert.deepEqual(mapped.rawData.media, ['image'])
  assert.equal(mapped.rawData.observedDirection, 'in')
})

test('保留排查用字段，便于区分"客户发的"与"商家发的"', () => {
  const { toPlatformMessage } = service(ACTIVE_BOUND)
  const mapped = toPlatformMessage({
    channel: 'douyin',
    accountId: 2,
    channelMessageId: 'fp-2',
    platformCustomerId: 'c',
    platformPayload: {
      direction: 'in',
      directionBasis: 'avatar_left',
      readState: '未读',
      timePrecision: 'second',
      contentDigest: 'abc123'
    }
  })
  assert.equal(mapped.rawData.directionBasis, 'avatar_left')
  assert.equal(mapped.rawData.readState, '未读')
  assert.equal(mapped.rawData.timePrecision, 'second')
  assert.equal(mapped.rawData.source, 'desktop_bridge')
})
