const test = require('node:test')
const assert = require('node:assert/strict')

const { ensureChannelEventInboxSchema } = require('./channelEventInbox.schema')
const {
  createChannelEventInboxRepository,
  normalizeChannelEventQuery,
  presentChannelEventSummaryRow,
  presentChannelEventDetailRow,
  MAX_EVENT_PAYLOAD_BYTES
} = require('./channelEventInbox.repository')

const ADMIN_SCOPE = { mode: 'all' }
const AGENT_SCOPE = { mode: 'bound', seatId: 42 }

test('creates an idempotent inbox keyed by channel, account and external event id', async () => {
  const statements = []
  await ensureChannelEventInboxSchema({ query: async sql => statements.push(sql) })

  assert.equal(statements.length, 1)
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS channel_event_inbox/i)
  assert.match(statements[0], /UNIQUE KEY uk_channel_event_identity \(channel, account_id, external_event_id\)/i)
  assert.match(statements[0], /payload_json JSON NOT NULL/i)
})

test('stores a new event and reports a repeated platform event as duplicate', async () => {
  const calls = []
  const affectedRows = [1, 0]
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => {
      calls.push({ sql, options })
      return [null, { affectedRows: affectedRows.shift() }]
    }
  })
  const event = {
    externalEventId: 'event-1', channel: 'douyin', accountId: 7,
    eventType: 'tag:100', category: 'order', businessKey: 'order-9',
    occurredAt: '2026-07-25T00:00:00.000Z', payload: { p_id: 'order-9' }
  }

  assert.deepEqual(await repository.store(event), { stored: true, duplicate: false })
  assert.deepEqual(await repository.store(event), { stored: false, duplicate: true })
  assert.equal(calls[0].options.replacements.externalEventId, 'event-1')
  assert.equal(calls[0].options.replacements.payloadJson, JSON.stringify({ p_id: 'order-9' }))
})

test('normalizes valid event filters with strict bounded pagination', () => {
  assert.deepEqual(normalizeChannelEventQuery({
    channel: ' DouYin ',
    account_id: '7',
    category: 'after_sales',
    status: 'processed',
    limit: '100',
    offset: '100000'
  }), {
    channel: 'douyin',
    accountId: 7,
    category: 'after_sales',
    status: 'processed',
    limit: 100,
    offset: 100000
  })

  assert.deepEqual(normalizeChannelEventQuery({}), {
    channel: 'douyin', accountId: null, category: null, status: null, limit: 20, offset: 0
  })
})

test('rejects malformed and out-of-range pagination instead of partially parsing it', () => {
  for (const limit of ['20junk', '1.5', '-1', '0', '101', '9007199254740992']) {
    assert.throws(() => normalizeChannelEventQuery({ limit }), /limit/i, limit)
  }
  for (const offset of ['20junk', '1.5', '-1', '100001', '9007199254740992']) {
    assert.throws(() => normalizeChannelEventQuery({ offset }), /offset/i, offset)
  }
  assert.throws(() => normalizeChannelEventQuery({ category: "order' OR 1=1" }), /category/i)
})

test('agent list and count require an active channel-matched seat binding', async () => {
  const calls = []
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => {
      calls.push({ sql, options })
      return /COUNT\(\*\)/i.test(sql) ? [[{ total: 2 }]] : [[{ id: 1 }, { id: 2 }]]
    }
  })
  const filters = {
    channel: 'douyin', accountId: 7, category: 'order', status: 'received', limit: 20, offset: 40
  }

  assert.deepEqual(await repository.list(filters, AGENT_SCOPE), [{ id: 1 }, { id: 2 }])
  assert.equal(await repository.count(filters, AGENT_SCOPE), 2)
  for (const call of calls) {
    assert.match(call.sql, /EXISTS\s*\([\s\S]*seat_account_bindings/i)
    assert.match(call.sql, /access_binding\.account_id\s*=\s*events\.account_id/i)
    assert.match(call.sql, /access_binding\.seat_id\s*=\s*:seatId/i)
    assert.match(call.sql, /access_binding\.status\s*=\s*'active'/i)
    assert.match(call.sql, /access_binding\.channel\s*=\s*events\.channel/i)
    assert.equal(call.options.replacements.seatId, 42)
    assert.equal(call.options.replacements.accountId, 7)
    assert.equal(call.options.replacements.channel, 'douyin')
  }
})

test('admin list omits payload and does not add a seat binding predicate', async () => {
  let call
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => { call = { sql, options }; return [[]] }
  })

  await repository.list({
    channel: 'douyin', accountId: null, category: null, status: null, limit: 20, offset: 0
  }, ADMIN_SCOPE)

  assert.doesNotMatch(call.sql, /received_at\s*,\s*events\.payload_json/i)
  assert.match(call.sql, /JSON_EXTRACT\(events\.payload_json, '\$\.projectionCommand\.schemaVersion'\)/i)
  assert.doesNotMatch(call.sql, /seat_account_bindings/i)
  assert.deepEqual(call.options.replacements, { channel: 'douyin', limit: 20, offset: 0 })
})

test('account options apply the same agent access scope without selecting credentials', async () => {
  let call
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => {
      call = { sql, options }
      return [[{ id: 7, account_name: '旗舰店' }]]
    }
  })

  assert.deepEqual(await repository.listAccountOptions('douyin', AGENT_SCOPE), [{ id: 7, name: '旗舰店' }])
  assert.match(call.sql, /SELECT\s+accounts\.id,\s*accounts\.account_name/i)
  assert.doesNotMatch(call.sql, /config|secret|credential/i)
  assert.match(call.sql, /EXISTS\s*\([\s\S]*seat_account_bindings/i)
  assert.match(call.sql, /access_binding\.account_id\s*=\s*accounts\.id/i)
  assert.doesNotMatch(call.sql, /accounts\.account_id/i)
  assert.match(call.sql, /access_binding\.channel\s*=\s*accounts\.channel/i)
  assert.deepEqual(call.options.replacements, { channel: 'douyin', seatId: 42 })
})

test('projection summary counts ready and raw-only orders within the same access scope', async () => {
  let call
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => {
      call = { sql, options }
      return [[{ total: '12', ready: '5', raw_only: '7' }]]
    }
  })

  assert.deepEqual(await repository.projectionSummary('pinduoduo', AGENT_SCOPE), {
    total: 12, ready: 5, rawOnly: 7
  })
  assert.match(call.sql, /SUM\(CASE WHEN JSON_UNQUOTE\(JSON_EXTRACT\(events\.payload_json/i)
  assert.match(call.sql, /events\.category='order'/i)
  assert.match(call.sql, /seat_account_bindings/i)
  assert.deepEqual(call.options.replacements, { channel: 'pinduoduo', seatId: 42 })
})

test('event detail applies the same scope and is the only read query selecting payload', async () => {
  let call
  const row = { id: 9, payload_json: '{"ok":true}' }
  const repository = createChannelEventInboxRepository({
    query: async (sql, options) => { call = { sql, options }; return [[row]] }
  })

  assert.deepEqual(await repository.detail(9, AGENT_SCOPE), row)
  assert.match(call.sql, /events\.payload_json/i)
  assert.match(call.sql, /events\.id\s*=\s*:eventId/i)
  assert.match(call.sql, /EXISTS\s*\([\s\S]*seat_account_bindings/i)
  assert.deepEqual(call.options.replacements, { eventId: 9, seatId: 42 })
})

test('summary presenter never exposes payload', () => {
  const summary = presentChannelEventSummaryRow({
    id: 9, channel: 'douyin', account_id: 7, account_name: '旗舰店',
    external_event_id: 'event-9', event_type: 'order_status_update', category: 'order',
    business_key: 'order-9', status: 'received', occurred_at: null,
    received_at: '2026-07-25T00:00:01.000Z', payload_json: '{"secret":"leak"}'
  })

  assert.equal(Object.hasOwn(summary, 'payload'), false)
  assert.equal(Object.hasOwn(summary, 'payloadJson'), false)
  assert.equal(summary.projectionState, 'raw_only')
})

test('summary presenter exposes projection readiness without exposing command data', () => {
  const base = {
    id: 9, channel: 'taobao', account_id: 7, external_event_id: 'event-9',
    event_type: 'order.updated', business_key: 'order-9', status: 'received'
  }
  assert.equal(presentChannelEventSummaryRow({ ...base, category: 'order', projection_ready: 1 }).projectionState, 'ready')
  assert.equal(presentChannelEventSummaryRow({ ...base, category: 'product', projection_ready: 0 }).projectionState, 'not_applicable')
})

test('detail presenter parses invalid JSON safely and recursively redacts sensitive keys', () => {
  const base = {
    id: 9, channel: 'douyin', account_id: 7, account_name: '旗舰店',
    external_event_id: 'event-9', event_type: 'order_status_update', category: 'order',
    business_key: 'order-9', status: 'received', occurred_at: null,
    received_at: '2026-07-25T00:00:01.000Z'
  }

  assert.deepEqual(presentChannelEventDetailRow({ ...base, payload_json: '{invalid' }).payload, {})
  assert.deepEqual(presentChannelEventDetailRow({
    ...base,
    payload_json: JSON.stringify({
      orderId: 'safe',
      access_token: 'token',
      nested: { password: 'password', value: 2 },
      list: [{ Authorization: 'Bearer x', cookie: 'session=x', keep: true }]
    })
  }).payload, {
    orderId: 'safe',
    access_token: '[REDACTED]',
    nested: { password: '[REDACTED]', value: 2 },
    list: [{ Authorization: '[REDACTED]', cookie: '[REDACTED]', keep: true }]
  })
})

test('detail presenter recursively masks PII without masking product or shop names', () => {
  const detail = presentChannelEventDetailRow({
    id: 10,
    payload_json: JSON.stringify({
      phone: '13800138000',
      mobile: '13900139000',
      email: 'alice@example.com',
      address: '上海市浦东新区世纪大道100号',
      id_card: '310101199001011234',
      receiver_name: '张三',
      receiver_mobile: '13700137000',
      receiver_phone: '13600136000',
      buyer_email: 'buyer@example.com',
      receiver: '李四',
      mobile_status: 'verified',
      product_name: '张三同款商品',
      shop_name: '李四百货',
      nested: {
        telephone: '021-12345678',
        receiver_address: '北京市朝阳区建国路88号',
        certificate_no: 'ABC1234567890',
        recipient: { contact_name: '王小明', tel: '01087654321' }
      },
      rows: [{ buyer_name: 'Alice', authorization: 'Bearer secret' }]
    })
  })

  assert.deepEqual(detail.payload, {
    phone: '***8000',
    mobile: '***9000',
    email: 'a***@example.com',
    address: '上海市浦东新***',
    id_card: '310***1234',
    receiver_name: '张*',
    receiver_mobile: '***7000',
    receiver_phone: '***6000',
    buyer_email: 'b***@example.com',
    receiver: '李*',
    mobile_status: 'verified',
    product_name: '张三同款商品',
    shop_name: '李四百货',
    nested: {
      telephone: '***5678',
      receiver_address: '北京市朝阳区***',
      certificate_no: 'ABC***7890',
      recipient: { contact_name: '王**', tel: '***4321' }
    },
    rows: [{ buyer_name: 'A****', authorization: '[REDACTED]' }]
  })
})

test('detail presenter returns a recognizable safe object for oversized payloads', () => {
  assert.equal(MAX_EVENT_PAYLOAD_BYTES, 128 * 1024)
  const detail = presentChannelEventDetailRow({
    id: 9,
    payload_json: JSON.stringify({ value: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) })
  })

  assert.deepEqual(detail.payload, {
    truncated: true,
    reason: 'payload_too_large',
    maxBytes: MAX_EVENT_PAYLOAD_BYTES
  })
})
