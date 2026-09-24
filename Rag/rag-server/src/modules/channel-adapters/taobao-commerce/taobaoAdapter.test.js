const test = require('node:test')
const assert = require('node:assert/strict')

function createAdapter(options) {
  let TaobaoCommerceAdapter
  try {
    TaobaoCommerceAdapter = require('./taobaoAdapter')
  } catch {
    // RED phase: keep a missing module as a readable contract failure.
  }
  assert.equal(typeof TaobaoCommerceAdapter, 'function', 'taobaoAdapter must export a constructor')
  return new TaobaoCommerceAdapter(options)
}

test('uses an explicitly configured certified order projection mapper', () => {
  const adapter = createAdapter({ orderProjectionMapper: payload => {
    assert.equal(payload.tid, 'T-certified')
    return {
      currency: 'CNY', currencyExponent: 2, status: 'paid',
      lines: [{ id: 'L-1', sku: 'SKU-1', quantity: 1, unitAmount: '8.00', grossAmount: '8.00', discounts: [], taxes: [], totalAmount: '8.00' }],
      shipping: '2.00', shippingDiscounts: [], shippingTaxes: [], total: '10.00'
    }
  } })
  const event = adapter.normalizeOrder({ tid: 'T-certified', modified: '2026-07-26 12:30:45' }, { accountId: 5 })

  assert.equal(event.payload.projectionCommand.externalOrderId, 'T-certified')
  assert.equal(event.payload.projection, undefined)
  assert.throws(() => createAdapter({ orderProjectionMapper: {} }), TypeError)
})

test('normalizes an order from tid and modified with a stable event id', () => {
  const adapter = createAdapter()
  const order = {
    tid: '9223372036854775807',
    modified: '2026-07-26 12:30:45',
    buyer_open_uid: 'AAHd5d-EAAeGwJedwX2b2M4l',
    ouid: 'ouid-value'
  }

  assert.deepEqual(adapter.normalizeOrder(order, { accountId: 4 }), {
    externalEventId: 'order:9223372036854775807:2026-07-26 12:30:45',
    channel: 'taobao',
    accountId: 4,
    eventType: 'order.updated',
    category: 'order',
    businessKey: '9223372036854775807',
    occurredAt: '2026-07-26T04:30:45.000Z',
    payload: order
  })
})

test('uses modified in the order event identity', () => {
  const adapter = createAdapter()
  const first = adapter.normalizeOrder(
    { tid: 'T1', modified: '2026-07-26 12:30:45' },
    { accountId: 4 }
  )
  const second = adapter.normalizeOrder(
    { tid: 'T1', modified: '2026-07-26 12:31:45' },
    { accountId: 4 }
  )

  assert.notEqual(first.externalEventId, second.externalEventId)
})

test('normalizes a refund from refund_id and modified', () => {
  const adapter = createAdapter()
  const refund = {
    refund_id: '18446744073709551615',
    tid: '9223372036854775807',
    modified: '2026-07-26 20:30:45'
  }

  assert.deepEqual(adapter.normalizeRefund(refund, { accountId: 9 }), {
    externalEventId: 'after_sales:18446744073709551615:2026-07-26 20:30:45',
    channel: 'taobao',
    accountId: 9,
    eventType: 'after_sales.updated',
    category: 'after_sales',
    businessKey: '9223372036854775807',
    occurredAt: '2026-07-26T12:30:45.000Z',
    payload: refund
  })
})

test('falls back to the refund id as the after-sales business key', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeRefund({
    refund_id: 'R1',
    modified: '2026-07-26 20:30:45'
  }, { accountId: 9 })

  assert.equal(event.businessKey, 'R1')
})

test('exposes refund normalization through the shared after-sales adapter contract', () => {
  const adapter = createAdapter()
  const refund = {
    refund_id: 'R1',
    tid: 'T1',
    modified: '2026-07-26 20:30:45'
  }

  assert.deepEqual(
    adapter.normalizeAfterSale(refund, { accountId: 9 }),
    adapter.normalizeRefund(refund, { accountId: 9 })
  )
})

test('parses explicit timezone timestamps without reinterpreting them as China time', () => {
  const adapter = createAdapter()

  assert.equal(
    adapter.normalizeOrder({ tid: 'T1', modified: '2026-07-26T12:30:45+02:00' }).occurredAt,
    '2026-07-26T10:30:45.000Z'
  )
  assert.equal(
    adapter.normalizeRefund({ refund_id: 'R1', modified: '2026-07-26T12:30:45.125Z' }).occurredAt,
    '2026-07-26T12:30:45.125Z'
  )
})

test('preserves bigint identifiers and buyer identity fields through recursive cloning', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeOrder({
    tid: 9223372036854775807n,
    modified: '2026-07-26 12:30:45',
    buyer_open_uid: 'open-uid',
    ouid: 'ouid',
    orders: [{ oid: 18446744073709551615n }]
  }, { accountId: 4 })

  assert.equal(event.businessKey, '9223372036854775807')
  assert.equal(event.payload.tid, '9223372036854775807')
  assert.equal(event.payload.orders[0].oid, '18446744073709551615')
  assert.equal(event.payload.buyer_open_uid, 'open-uid')
  assert.equal(event.payload.ouid, 'ouid')
})

test('fails closed for unsafe Number identifiers', () => {
  const adapter = createAdapter()

  assert.throws(
    () => adapter.normalizeOrder({
      tid: Number.MAX_SAFE_INTEGER + 1,
      modified: '2026-07-26 12:30:45'
    }),
    error => error.code === 'taobao_event_shape_invalid' && /unsafe integer/i.test(error.message)
  )
  assert.throws(
    () => adapter.normalizeRefund({
      refund_id: Number.MAX_SAFE_INTEGER + 1,
      modified: '2026-07-26 12:30:45'
    }),
    error => error.code === 'taobao_event_shape_invalid' && /unsafe integer/i.test(error.message)
  )
})

test('recursively rejects non-finite numbers in payloads', () => {
  const adapter = createAdapter()
  const payloads = [
    { tid: 'T1', modified: '2026-07-26 12:30:45', price: Number.NaN },
    { tid: 'T1', modified: '2026-07-26 12:30:45', nested: { amount: Infinity } },
    { refund_id: 'R1', modified: '2026-07-26 12:30:45', rows: [-Infinity] }
  ]

  assert.throws(
    () => adapter.normalizeOrder(payloads[0]),
    error => error.code === 'taobao_event_shape_invalid' && /non-finite/i.test(error.message)
  )
  assert.throws(
    () => adapter.normalizeOrder(payloads[1]),
    error => error.code === 'taobao_event_shape_invalid' && /non-finite/i.test(error.message)
  )
  assert.throws(
    () => adapter.normalizeRefund(payloads[2]),
    error => error.code === 'taobao_event_shape_invalid' && /non-finite/i.test(error.message)
  )
})

test('fails closed when stable identifiers, modified or valid timestamps are missing', () => {
  const adapter = createAdapter()
  const invalid = [
    () => adapter.normalizeOrder({ modified: '2026-07-26 12:30:45' }),
    () => adapter.normalizeOrder({ tid: 'T1' }),
    () => adapter.normalizeOrder({ tid: 'T1', modified: '2026-02-30 12:30:45' }),
    () => adapter.normalizeRefund({ modified: '2026-07-26 12:30:45' }),
    () => adapter.normalizeRefund({ refund_id: 'R1' }),
    () => adapter.normalizeRefund({ refund_id: 'R1', modified: 'not-a-time' })
  ]

  for (const operation of invalid) {
    assert.throws(operation, error => error.code === 'taobao_event_shape_invalid')
  }
})

test('does not expose buyer customer chat sending as a supported capability', async () => {
  const adapter = createAdapter()

  assert.deepEqual(await adapter.sendMessage(), {
    success: false,
    code: 'capability_not_supported',
    error: 'Taobao Open Platform does not expose a public server-side API for sending buyer customer-service chat messages.'
  })
})

test('registers Taobao without regressing existing adapter lookups', () => {
  const { initAdapters, getAdapter, getAdapterByChannel } = require('../index')
  initAdapters()

  assert.equal(getAdapter('taobao_commerce')?.adapterType, 'taobao_commerce')
  assert.equal(getAdapterByChannel('taobao')?.channel, 'taobao')
  assert.equal(getAdapterByChannel('pinduoduo')?.adapterType, 'pinduoduo_commerce')
  assert.equal(getAdapterByChannel('douyin')?.adapterType, 'douyin_commerce')
  assert.equal(getAdapterByChannel('whatsapp')?.adapterType, 'waha')
})
