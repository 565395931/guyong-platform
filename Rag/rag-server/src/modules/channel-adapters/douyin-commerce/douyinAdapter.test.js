const test = require('node:test')
const assert = require('node:assert/strict')

const DouyinCommerceAdapter = require('./douyinAdapter')
const { createEventSignature, verifyEventSignature } = require('./douyinSignature')

const appId = 'app-123'
const appSecret = 'secret-456'
const probeBody = '[{"tag":"0","msg_id":"0","data":"probe"}]'

test('creates the official Douyin HMAC-SHA256 event signature', () => {
  assert.equal(
    createEventSignature({ appId, appSecret, rawBody: probeBody }),
    '7e0bd8b248471435f5a09b27cbc1a07f2cb00f625810bde9f3cc5b0ba7bc4a11'
  )
})

test('rejects a wrong app id and a tampered body', () => {
  const signature = createEventSignature({ appId, appSecret, rawBody: probeBody })

  assert.throws(
    () => verifyEventSignature({ appId: 'other-app', expectedAppId: appId, appSecret, rawBody: probeBody, signature }),
    error => error.code === 'douyin_app_id_mismatch'
  )
  assert.throws(
    () => verifyEventSignature({ appId, expectedAppId: appId, appSecret, rawBody: `${probeBody} `, signature }),
    error => error.code === 'douyin_signature_invalid'
  )
})

test('normalizes probe and order events without creating customer messages', async () => {
  const adapter = new DouyinCommerceAdapter()
  const events = adapter.receiveBusinessEvents([
    { tag: '0', msg_id: '0', data: 'probe' },
    {
      tag: '100',
      msg_id: 'event-100',
      data: JSON.stringify({ p_id: 'order-1', s_ids: ['sku-order-1'], shop_id: 'shop-7', create_time: 1720000000 })
    }
  ], { accountId: 17 })

  assert.deepEqual(events[0], {
    externalEventId: '0',
    channel: 'douyin',
    accountId: 17,
    eventType: 'probe',
    category: 'probe',
    businessKey: null,
    occurredAt: null,
    payload: { value: 'probe' }
  })
  assert.equal(events[1].externalEventId, 'event-100')
  assert.equal(events[1].eventType, 'tag:100')
  assert.equal(events[1].category, 'order')
  assert.equal(events[1].businessKey, 'order-1')
  assert.equal(events[1].payload.shop_id, 'shop-7')
  assert.deepEqual(await adapter.receiveEvent([]), [])
})

test('preserves official Douyin order identifiers beyond the JavaScript safe integer range', () => {
  const adapter = new DouyinCommerceAdapter()
  const [event] = adapter.receiveBusinessEvents([{
    tag: '100',
    msg_id: 'event-large-order-id',
    data: '{"p_id":4712345680779753833,"s_ids":[4712345680779753833],"shop_id":3123451}'
  }], { accountId: 17 })

  assert.equal(event.businessKey, '4712345680779753833')
  assert.equal(event.payload.p_id, '4712345680779753833')
  assert.deepEqual(event.payload.s_ids, ['4712345680779753833'])
})

test('attaches a projection command only when a Douyin order event contains complete normalized fields', () => {
  const adapter = new DouyinCommerceAdapter()
  const [event] = adapter.receiveBusinessEvents([{
    tag: '100',
    msg_id: 'event-projection',
    data: JSON.stringify({
      p_id: 'order-projection',
      create_time: 1720000000,
      projection: {
        currency: 'CNY', currencyExponent: 2, status: 'paid',
        lines: [{ id: 'line-1', sku: 'sku-1', quantity: 1, unitAmount: '8.00', grossAmount: '8.00', discounts: [], taxes: [], totalAmount: '8.00' }],
        shipping: '0.00', shippingDiscounts: [], shippingTaxes: [], total: '8.00'
      }
    })
  }], { accountId: 17 })

  assert.equal(event.payload.projectionCommand.schemaVersion, 2)
  assert.equal(event.payload.projectionCommand.externalOrderId, 'order-projection')
})

test('fails closed when asked to send a Feige customer message', async () => {
  const adapter = new DouyinCommerceAdapter()
  assert.deepEqual(await adapter.sendMessage(), {
    success: false,
    error: '抖店开放平台暂未提供飞鸽客服消息发送 API',
    code: 'capability_not_supported'
  })
})
