'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyCommerceProjectionMapper,
  attachCommerceProjection,
  buildCommerceProjectionDraft
} = require('./commerceProjectionMapper')

function completeEvent(overrides = {}) {
  return {
    channel: 'taobao',
    accountId: 7,
    externalEventId: 'order:T-1:2026-07-26 12:00:00',
    businessKey: 'T-1',
    occurredAt: '2026-07-26T04:00:00.000Z',
    payload: {
      buyer_open_uid: 'buyer-1',
      projection: {
        currency: 'CNY',
        currencyExponent: 2,
        status: 'paid',
        lines: [{
          id: 'L-1', sku: 'SKU-1', quantity: 2, unitAmount: '10.00',
          grossAmount: '20.00', discounts: [], taxes: [], totalAmount: '20.00'
        }],
        shipping: '5.00',
        shippingDiscounts: [],
        shippingTaxes: [],
        total: '25.00'
      }
    },
    ...overrides
  }
}

test('builds a deterministic protocol v2 draft from explicit commerce fields', () => {
  const first = buildCommerceProjectionDraft(completeEvent())
  const second = buildCommerceProjectionDraft(completeEvent())

  assert.deepEqual(first, second)
  assert.equal(first.schemaVersion, 2)
  assert.equal(first.commandId, 'commerce:taobao:7:T-1:order:T-1:2026-07-26 12:00:00')
  assert.equal(first.externalVersion, '2026-07-26T04:00:00.000Z')
  assert.equal(first.eventInboxId, 0)
  assert.equal(first.rawPayloadRef, 'channel_event_inbox:0')
  assert.equal(first.currency.code, 'CNY')
  assert.deepEqual(first.lines[0].discounts, [])
  assert.deepEqual(first.shippingLines[0], {
    externalShippingLineId: 'shipping',
    methodCode: 'default',
    name: 'Shipping',
    grossAmount: '5.00',
    discounts: [],
    taxes: [],
    totalAmount: '5.00'
  })
  assert.deepEqual(first.amounts, {
    itemGross: '20.00',
    itemDiscount: '0.00',
    shippingGross: '5.00',
    shippingDiscount: '0.00',
    tax: '0.00',
    total: '25.00'
  })
})

test('accepts canonical aliases for line and amount fields', () => {
  const event = completeEvent({ payload: {
    order_id: 'external-2',
    projection: {
      currency: { code: 'USD', exponent: 2 },
      normalizedStatus: 'ready_to_ship',
      items: [{ item_id: 'I-1', sku_id: 'S-1', qty: 1, price: '3.50', amount: '3.50', discounts: [], taxes: [], totalAmount: '3.50' }],
      shippingAmount: '0',
      shippingDiscounts: [],
      shippingTaxes: [],
      orderAmount: '3.50'
    }
  } })
  const draft = buildCommerceProjectionDraft(event)
  assert.equal(draft.externalOrderId, 'external-2')
  assert.equal(draft.normalizedStatus, 'ready_to_ship')
  assert.equal(draft.lines[0].sku, 'S-1')
  assert.equal(draft.amounts.total, '3.50')
})

test('fails closed when monetary or line data is incomplete', () => {
  assert.throws(
    () => buildCommerceProjectionDraft(completeEvent({ payload: {
      projection: { currency: 'CNY', currencyExponent: 2, lines: [], total: '0' }
    } })),
    error => error.code === 'commerce_projection_incomplete'
  )
  assert.throws(
    () => buildCommerceProjectionDraft(completeEvent({ payload: {
      projection: {
        currency: 'CNY', currencyExponent: 2, lines: [{ id: 'L', sku: 'S', quantity: 1, unitAmount: '1.00' }], total: '1.00'
      }
    } })),
    error => error.code === 'commerce_projection_incomplete'
  )
})

test('fails closed when declared total does not reconcile', () => {
  assert.throws(
    () => buildCommerceProjectionDraft(completeEvent({ payload: {
      projection: {
        currency: 'CNY', currencyExponent: 2, status: 'paid',
        lines: [{ id: 'L', sku: 'S', quantity: 1, unitAmount: '1.00', grossAmount: '1.00', discounts: [], taxes: [], totalAmount: '1.00' }],
        shipping: '0.00', shippingDiscounts: [], shippingTaxes: [],
        total: '2.00'
      }
    } })),
    error => error.code === 'commerce_projection_total_mismatch'
  )
})

test('does not infer missing shipping, discount or tax data as zero', () => {
  const missingShipping = completeEvent()
  delete missingShipping.payload.projection.shipping
  assert.throws(() => buildCommerceProjectionDraft(missingShipping), error => error.code === 'commerce_projection_incomplete')

  const missingAllocations = completeEvent()
  delete missingAllocations.payload.projection.lines[0].taxes
  assert.throws(() => buildCommerceProjectionDraft(missingAllocations), error => error.code === 'commerce_projection_incomplete')
})

test('attaches valid commands but leaves sparse events available for raw ingestion', () => {
  const valid = completeEvent()
  const attached = attachCommerceProjection(valid)
  assert.equal(attached.payload.projectionCommand.schemaVersion, 2)
  assert.equal(valid.payload.projectionCommand, undefined)

  const sparse = completeEvent({ payload: { tid: 'T-1' } })
  assert.equal(attachCommerceProjection(sparse), sparse)
})

test('keeps command identity separate from the sortable external version', () => {
  const event = completeEvent({ externalEventId: 'opaque-event-99' })
  const draft = buildCommerceProjectionDraft(event)

  assert.equal(draft.commandId, 'commerce:taobao:7:T-1:opaque-event-99')
  assert.equal(draft.externalVersion, event.occurredAt)
})

test('reconciles line and shipping discounts and taxes without floating point arithmetic', () => {
  const event = completeEvent({
    externalEventId: `event-${'x'.repeat(600)}`,
    payload: {
      buyer_open_uid: 'buyer-tax',
      projection: {
        currency: { code: 'JPY', exponent: 0 },
        normalizedStatus: 'shipped',
        customerId: 'customer-tax',
        shippingAddress: { countryCode: 'JP', line1: 'redacted' },
        lines: [{
          externalLineId: 'L-tax', skuId: 'S-tax', count: 2,
          unitPrice: '100', lineAmount: '200',
          discountAllocations: [{ code: 'seller-coupon', amount: '20', funding: 'seller', description: 'coupon' }],
          taxAllocations: [{ code: 'vat', rate: '0.1', amount: '18', includedInSourcePrice: false }],
          netAmount: '198'
        }],
        shippingAmount: '10',
        shippingDiscounts: [{ id: 'ship-promo', value: '2', funding: 'platform' }],
        shippingTaxes: [{ type: 'ship-tax', taxRate: '0.1', fee: '1', includedInSourcePrice: true }],
        payAmount: '207'
      }
    }
  })

  const draft = buildCommerceProjectionDraft(event)
  assert.match(draft.commandId, /^commerce:[a-f0-9]{64}$/)
  assert.equal(draft.lines[0].totalAmount, '198')
  assert.equal(draft.shippingLines[0].totalAmount, '9')
  assert.deepEqual(draft.amounts, {
    itemGross: '200', itemDiscount: '20', shippingGross: '10',
    shippingDiscount: '2', tax: '19', total: '207'
  })
  assert.equal(draft.customer.externalCustomerId, 'customer-tax')
  assert.equal(draft.shippingAddress.countryCode, 'JP')
})

test('rejects malformed connector projection boundaries', () => {
  const mutate = operation => {
    const event = completeEvent()
    operation(event.payload.projection)
    return () => buildCommerceProjectionDraft(event)
  }
  const invalid = [
    mutate(value => { value.currency = 'cny' }),
    mutate(value => { value.currencyExponent = 7 }),
    mutate(value => { value.lines[0].quantity = 0 }),
    mutate(value => { value.lines[0].grossAmount = '20.001' }),
    mutate(value => { value.lines[0].grossAmount = '19.00' }),
    mutate(value => { value.lines[0].discounts = {} }),
    mutate(value => { value.lines[0].discounts = [null] }),
    mutate(value => { value.lines[0].discounts = [{ amount: '21.00' }] }),
    mutate(value => { value.status = 'unknown' })
  ]

  for (const operation of invalid) assert.throws(operation)
})

test('propagates reconciliation failures while treating missing projections as raw-only events', () => {
  const mismatch = completeEvent()
  mismatch.payload.projection.total = '99.00'
  assert.throws(
    () => attachCommerceProjection(mismatch),
    error => error.code === 'commerce_projection_total_mismatch'
  )
  assert.deepEqual(attachCommerceProjection({ payload: null }), { payload: null })
})

test('applies a certified connector mapper without storing its intermediate projection draft', () => {
  const event = completeEvent({ payload: { order_sn: 'P-certified', raw: { value: 1 } } })
  let received
  const mapped = applyCommerceProjectionMapper(event, input => {
    received = input
    assert.equal(Object.isFrozen(input), true)
    assert.equal(Object.isFrozen(input.raw), true)
    return completeEvent().payload.projection
  })

  assert.equal(received.order_sn, 'P-certified')
  assert.equal(mapped.payload.projection, undefined)
  assert.equal(mapped.payload.projectionCommand.schemaVersion, 2)
  assert.equal(mapped.payload.projectionCommand.externalOrderId, 'P-certified')
  assert.deepEqual(event.payload, { order_sn: 'P-certified', raw: { value: 1 } })
})

test('certified connector mappers fail closed on mutation, invalid output and contradictory money', () => {
  const event = completeEvent({ payload: { order_sn: 'P-certified', nested: { value: 1 } } })
  assert.equal(applyCommerceProjectionMapper(event, () => null), event)
  assert.throws(() => applyCommerceProjectionMapper(event, 'not-a-function'), TypeError)
  assert.throws(
    () => applyCommerceProjectionMapper(event, () => []),
    error => error.code === 'commerce_projection_incomplete'
  )
  assert.throws(
    () => applyCommerceProjectionMapper(event, () => ({ currency: 'CNY' })),
    error => error.code === 'commerce_projection_incomplete'
  )
  assert.throws(
    () => applyCommerceProjectionMapper(event, () => ({ ...completeEvent().payload.projection, total: '99.00' })),
    error => error.code === 'commerce_projection_total_mismatch'
  )
  assert.throws(
    () => applyCommerceProjectionMapper(event, input => { input.nested.value = 2; return null }),
    TypeError
  )
})
