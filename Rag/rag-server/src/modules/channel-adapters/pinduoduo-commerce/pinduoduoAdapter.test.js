const test = require('node:test')
const assert = require('node:assert/strict')

function createAdapter(options) {
  let PinduoduoCommerceAdapter
  try {
    PinduoduoCommerceAdapter = require('./pinduoduoAdapter')
  } catch {
    // Keep the RED phase as an assertion failure instead of a module-loader error.
  }

  assert.equal(typeof PinduoduoCommerceAdapter, 'function', 'pinduoduoAdapter must export a constructor')
  return new PinduoduoCommerceAdapter(options)
}

function certifiedProjection() {
  return {
    currency: 'CNY', currencyExponent: 2, status: 'paid',
    lines: [{ id: 'L-1', sku: 'SKU-1', quantity: 1, unitAmount: '10.00', grossAmount: '10.00', discounts: [], taxes: [], totalAmount: '10.00' }],
    shipping: '0.00', shippingDiscounts: [], shippingTaxes: [], total: '10.00'
  }
}

test('uses an explicitly configured certified order projection mapper', () => {
  const adapter = createAdapter({ orderProjectionMapper: payload => {
    assert.equal(payload.order_sn, 'P-certified')
    return certifiedProjection()
  } })
  const event = adapter.normalizeOrder({ order_sn: 'P-certified', updated_at: '2026-07-25 12:00:00' }, { accountId: 4 })

  assert.equal(event.payload.projectionCommand.schemaVersion, 2)
  assert.equal(event.payload.projectionCommand.externalOrderId, 'P-certified')
  assert.equal(event.payload.projection, undefined)
  assert.throws(() => createAdapter({ orderProjectionMapper: true }), TypeError)
})

test('normalizes an order with a stable order and update-time event id', () => {
  const adapter = createAdapter()
  const order = { order_sn: 'P1', updated_at: '2026-07-25 12:00:00' }

  assert.deepEqual(adapter.normalizeOrder(order, { accountId: 4 }), {
    externalEventId: 'order:P1:2026-07-25 12:00:00',
    channel: 'pinduoduo',
    accountId: 4,
    eventType: 'order.updated',
    category: 'order',
    businessKey: 'P1',
    occurredAt: '2026-07-25T04:00:00.000Z',
    payload: order
  })
})

test('uses the update time in the order event id', () => {
  const adapter = createAdapter()
  const first = adapter.normalizeOrder(
    { order_sn: 'P1', updated_at: '2026-07-25 12:00:00' },
    { accountId: 4 }
  )
  const second = adapter.normalizeOrder(
    { order_sn: 'P1', updated_at: '2026-07-25 12:01:00' },
    { accountId: 4 }
  )

  assert.notEqual(first.externalEventId, second.externalEventId)
})

test('normalizes after-sales data with id and updated_time', () => {
  const adapter = createAdapter()
  const refund = {
    id: '9223372036854775807',
    order_sn: 'P9223372036854775808',
    updated_time: '2026-07-25 20:30:45',
    updated_at: '2026-07-25 21:30:45'
  }

  assert.deepEqual(adapter.normalizeAfterSale(refund, { accountId: 9 }), {
    externalEventId: 'after_sales:9223372036854775807:2026-07-25 20:30:45',
    channel: 'pinduoduo',
    accountId: 9,
    eventType: 'after_sales.updated',
    category: 'after_sales',
    businessKey: 'P9223372036854775808',
    occurredAt: '2026-07-25T12:30:45.000Z',
    payload: refund
  })
})

test('falls back to updated_at when after-sales updated_time is absent', () => {
  const adapter = createAdapter()
  const refund = {
    id: 'R2',
    order_sn: 'P2',
    updated_at: '2026-07-25 21:30:45'
  }

  const event = adapter.normalizeAfterSale(refund, { accountId: 9 })

  assert.equal(event.externalEventId, 'after_sales:R2:2026-07-25 21:30:45')
  assert.equal(event.occurredAt, '2026-07-25T13:30:45.000Z')
  assert.deepEqual(event.payload, refund)
})

test('fails closed when after-sales data has neither update timestamp', () => {
  const adapter = createAdapter()

  assert.throws(
    () => adapter.normalizeAfterSale({ id: 'R3' }, { accountId: 9 }),
    error => error.code === 'pinduoduo_event_shape_invalid'
  )
})

test('preserves large integer identifiers as strings throughout the payload', () => {
  const adapter = createAdapter()
  const order = {
    order_sn: '9223372036854775807',
    goods_id: '18446744073709551615',
    updated_at: '2026-07-25 12:00:00',
    items: [{ sku_id: 9223372036854775807n }]
  }

  const event = adapter.normalizeOrder(order, { accountId: 4 })

  assert.equal(event.businessKey, '9223372036854775807')
  assert.equal(event.payload.order_sn, '9223372036854775807')
  assert.equal(event.payload.goods_id, '18446744073709551615')
  assert.equal(event.payload.items[0].sku_id, '9223372036854775807')
})

test('fails closed when stable identifiers or update timestamps are missing', () => {
  const adapter = createAdapter()
  const invalidRecords = [
    () => adapter.normalizeOrder({ updated_at: '2026-07-25 12:00:00' }, { accountId: 4 }),
    () => adapter.normalizeOrder({ order_sn: 'P1' }, { accountId: 4 }),
    () => adapter.normalizeAfterSale({ updated_time: '2026-07-25 12:00:00' }, { accountId: 4 })
  ]

  for (const normalize of invalidRecords) {
    assert.throws(normalize, error => error.code === 'pinduoduo_event_shape_invalid')
  }
})

test('fails closed for invalid China time and already unsafe Number identifiers', () => {
  const adapter = createAdapter()

  assert.throws(
    () => adapter.normalizeOrder({ order_sn: 'P1', updated_at: 'not-a-date' }, { accountId: 4 }),
    error => error.code === 'pinduoduo_event_shape_invalid'
  )
  assert.throws(
    () => adapter.normalizeAfterSale({ id: Number.MAX_SAFE_INTEGER + 1, updated_time: '2026-07-25 12:00:00' }, { accountId: 4 }),
    error => error.code === 'pinduoduo_event_shape_invalid' && /unsafe integer/i.test(error.message)
  )
})

test('does not expose buyer customer-chat sending as a supported capability', async () => {
  const adapter = createAdapter()

  assert.deepEqual(await adapter.sendMessage(), {
    success: false,
    code: 'capability_not_supported',
    error: '拼多多官方商家 API 不提供买家客服聊天消息收发能力'
  })
})

test('registers Pinduoduo without regressing Douyin or WAHA lookup', () => {
  const { initAdapters, getAdapter, getAdapterByChannel } = require('../index')
  initAdapters()

  const registeredAdapter = getAdapter('pinduoduo_commerce')
  const channelAdapter = getAdapterByChannel('pinduoduo')
  assert.ok(registeredAdapter, 'pinduoduo_commerce must be registered')
  assert.ok(channelAdapter, 'pinduoduo channel must resolve to an adapter')
  assert.equal(registeredAdapter.adapterType, 'pinduoduo_commerce')
  assert.equal(channelAdapter.channel, 'pinduoduo')
  assert.equal(getAdapterByChannel('douyin').adapterType, 'douyin_commerce')
  assert.equal(getAdapterByChannel('whatsapp').adapterType, 'waha')
})
