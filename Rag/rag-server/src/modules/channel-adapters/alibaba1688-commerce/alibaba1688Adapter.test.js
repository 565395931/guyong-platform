const test = require('node:test')
const assert = require('node:assert/strict')

function createAdapter(options) {
  let Alibaba1688CommerceAdapter
  try {
    Alibaba1688CommerceAdapter = require('./alibaba1688Adapter')
  } catch {
    // RED phase: keep a missing module as a readable contract failure.
  }
  assert.equal(typeof Alibaba1688CommerceAdapter, 'function', 'alibaba1688Adapter must export a constructor')
  return new Alibaba1688CommerceAdapter(options)
}

test('uses an explicitly configured certified order projection mapper', () => {
  const adapter = createAdapter({ orderProjectionMapper: payload => {
    assert.equal(payload.baseInfo.idOfStr, 'A-certified')
    return {
      currency: 'CNY', currencyExponent: 2, status: 'ready_to_ship',
      lines: [{ id: 'L-1', sku: 'SKU-1', quantity: 2, unitAmount: '5.00', grossAmount: '10.00', discounts: [], taxes: [], totalAmount: '10.00' }],
      shipping: '0.00', shippingDiscounts: [], shippingTaxes: [], total: '10.00'
    }
  } })
  const event = adapter.normalizeOrder({ baseInfo: { idOfStr: 'A-certified', modifyTime: '2026-07-26 12:30:45' } }, { accountId: 6 })

  assert.equal(event.payload.projectionCommand.externalOrderId, 'A-certified')
  assert.equal(event.payload.projection, undefined)
  assert.throws(() => createAdapter({ orderProjectionMapper: [] }), TypeError)
})

test('normalizes an order from baseInfo.idOfStr and modifyTime', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeOrder({
    baseInfo: {
      id: '900719925474099312345',
      idOfStr: '900719925474099312345',
      modifyTime: '20260726123045000+0800',
      buyerOpenUid: 'buyer-open-uid-1',
      status: 'waitbuyerpay'
    },
    productItems: [{ productID: '9223372036854775807123', quantity: 2 }]
  }, { accountId: 14 })

  assert.equal(event.externalEventId, 'order:900719925474099312345:20260726123045000+0800')
  assert.equal(event.channel, 'alibaba1688')
  assert.equal(event.accountId, 14)
  assert.equal(event.eventType, 'order.updated')
  assert.equal(event.category, 'order')
  assert.equal(event.businessKey, '900719925474099312345')
  assert.equal(event.occurredAt, '2026-07-26T04:30:45.000Z')
  assert.equal(event.payload.baseInfo.buyerOpenUid, 'buyer-open-uid-1')
  assert.equal(event.payload.productItems[0].productID, '9223372036854775807123')
})

test('prefers idOfStr and rejects an unsafe numeric fallback order id', () => {
  const adapter = createAdapter()
  const preferred = adapter.normalizeOrder({
    baseInfo: {
      id: Number.MAX_SAFE_INTEGER + 1,
      idOfStr: '9007199254740993',
      modifyTime: '2026-07-26 12:30:45'
    }
  })
  assert.equal(preferred.businessKey, '9007199254740993')
  assert.equal(Object.hasOwn(preferred.payload.baseInfo, 'id'), false)

  assert.throws(
    () => adapter.normalizeOrder({
      baseInfo: { id: Number.MAX_SAFE_INTEGER + 1, modifyTime: '2026-07-26 12:30:45' }
    }),
    error => error.code === 'alibaba1688_event_shape_invalid' && /unsafe integer/i.test(error.message)
  )
})

test('normalizes a refund from refundId and gmtModified', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeAfterSale({
    refundId: '184467440737095516151',
    orderId: '900719925474099312345',
    gmtModified: '2026-07-26T12:30:45+02:00',
    buyerOpenUid: 'buyer-open-uid-1',
    refundPayment: 88.5
  }, { accountId: 14 })

  assert.equal(event.externalEventId, 'after_sales:184467440737095516151:2026-07-26T12:30:45+02:00')
  assert.equal(event.businessKey, '900719925474099312345')
  assert.equal(event.occurredAt, '2026-07-26T10:30:45.000Z')
  assert.equal(event.payload.refundId, '184467440737095516151')
  assert.equal(event.payload.buyerOpenUid, 'buyer-open-uid-1')
})

test('falls back to refundId for the after-sales business key', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeAfterSale({
    refundId: 'R-1',
    gmtModified: '2026-07-26 12:30:45'
  })
  assert.equal(event.businessKey, 'R-1')
})

test('recursively removes contact information, identity fields, memo and feedback', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeOrder({
    baseInfo: {
      idOfStr: 'O-1',
      modifyTime: '2026-07-26 12:30:45',
      buyerOpenUid: 'keep-this-open-uid',
      buyerLoginId: 'remove-login',
      buyerMemo: 'remove-memo',
      sellerRemark: 'remove-remark'
    },
    receiverInfo: {
      receiverName: 'remove-name',
      mobile: 'remove-mobile',
      fullAddress: 'remove-address'
    },
    nested: [{
      contactPhone: 'remove-phone',
      alipayAccount: 'remove-account',
      realName: 'remove-real-name',
      feedback: 'remove-feedback',
      productName: 'keep-product-name'
    }]
  })

  const serialized = JSON.stringify(event.payload)
  for (const secret of [
    'remove-login',
    'remove-memo',
    'remove-remark',
    'remove-name',
    'remove-mobile',
    'remove-address',
    'remove-phone',
    'remove-account',
    'remove-real-name',
    'remove-feedback'
  ]) assert.equal(serialized.includes(secret), false, `payload leaked ${secret}`)
  assert.equal(event.payload.baseInfo.buyerOpenUid, 'keep-this-open-uid')
  assert.equal(event.payload.nested[0].productName, 'keep-product-name')
})

test('supports bigint values but fails closed for non-finite payload numbers', () => {
  const adapter = createAdapter()
  const event = adapter.normalizeAfterSale({
    refundId: 18446744073709551615n,
    orderId: 9223372036854775807n,
    gmtModified: '2026-07-26 12:30:45'
  })
  assert.equal(event.payload.refundId, '18446744073709551615')
  assert.equal(event.businessKey, '9223372036854775807')

  assert.throws(
    () => adapter.normalizeOrder({
      baseInfo: { idOfStr: 'O-1', modifyTime: '2026-07-26 12:30:45' },
      amount: Number.NaN
    }),
    error => error.code === 'alibaba1688_event_shape_invalid' && /non-finite/i.test(error.message)
  )
})

test('fails closed when identifiers or timestamps are missing or invalid', () => {
  const adapter = createAdapter()
  const invalid = [
    () => adapter.normalizeOrder({ baseInfo: { modifyTime: '2026-07-26 12:30:45' } }),
    () => adapter.normalizeOrder({ baseInfo: { idOfStr: 'O-1' } }),
    () => adapter.normalizeOrder({ baseInfo: { idOfStr: 'O-1', modifyTime: '2026-02-30 12:30:45' } }),
    () => adapter.normalizeAfterSale({ gmtModified: '2026-07-26 12:30:45' }),
    () => adapter.normalizeAfterSale({ refundId: 'R-1' }),
    () => adapter.normalizeAfterSale({ refundId: 'R-1', gmtModified: 'not-a-time' })
  ]
  for (const operation of invalid) {
    assert.throws(operation, error => error.code === 'alibaba1688_event_shape_invalid')
  }
})

test('does not expose buyer chat sending as a supported capability', async () => {
  const adapter = createAdapter()
  assert.deepEqual(await adapter.sendMessage(), {
    success: false,
    code: 'capability_not_supported',
    error: '1688 Open Platform does not expose a public server-side API for sending buyer customer-service chat messages.'
  })
})

test('registers 1688 without regressing existing adapter lookups', () => {
  const { initAdapters, getAdapter, getAdapterByChannel } = require('../index')
  initAdapters()

  assert.equal(getAdapter('alibaba1688_commerce')?.adapterType, 'alibaba1688_commerce')
  assert.equal(getAdapterByChannel('alibaba1688')?.channel, 'alibaba1688')
  assert.equal(getAdapterByChannel('taobao')?.adapterType, 'taobao_commerce')
  assert.equal(getAdapterByChannel('pinduoduo')?.adapterType, 'pinduoduo_commerce')
  assert.equal(getAdapterByChannel('douyin')?.adapterType, 'douyin_commerce')
  assert.equal(getAdapterByChannel('whatsapp')?.adapterType, 'waha')
})
