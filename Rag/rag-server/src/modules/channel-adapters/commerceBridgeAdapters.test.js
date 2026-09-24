const test = require('node:test')
const assert = require('node:assert/strict')

const XiaohongshuCommerceAdapter = require('./xiaohongshu-commerce/xiaohongshuAdapter')
const WechatShopCommerceAdapter = require('./wechat-shop-commerce/wechatShopAdapter')
const KuaishouCommerceAdapter = require('./kuaishou-commerce/kuaishouAdapter')

const cases = [
  [XiaohongshuCommerceAdapter, 'xiaohongshu', 'xiaohongshu_commerce', { package_id: 'xhs-1', update_time: 1722470400 }],
  [WechatShopCommerceAdapter, 'wechat_shop', 'wechat_shop_commerce', { order_id: 'wx-1', update_time: 1722470400 }],
  [KuaishouCommerceAdapter, 'kuaishou', 'kuaishou_commerce', { oid: 'ks-1', updateTime: 1722470400000 }]
]

const completeProjection = {
  currency: 'CNY',
  currencyExponent: 2,
  status: 'paid',
  lines: [{ id: 'line-1', sku: 'sku-1', quantity: 1, unitAmount: '12.00', grossAmount: '12.00', discounts: [], taxes: [], totalAmount: '12.00' }],
  shipping: '0.00',
  shippingDiscounts: [],
  shippingTaxes: [],
  total: '12.00'
}

for (const [Adapter, channel, adapterType, order] of cases) {
  test(`${channel} normalizes official order events and routes chat to desktop bridge`, async () => {
    const adapter = new Adapter()
    assert.equal(adapter.channel, channel)
    assert.equal(adapter.adapterType, adapterType)

    const event = adapter.normalizeOrder(order, { accountId: 42 })
    assert.equal(event.channel, channel)
    assert.equal(event.accountId, 42)
    assert.equal(event.eventType, 'order.updated')
    assert.equal(event.category, 'order')
    assert.match(event.externalEventId, /^order:/)
    assert.match(event.occurredAt, /^2024-/)

    assert.deepEqual(await adapter.sendMessage(), {
      success: false,
      status: 'bridge_required',
      code: 'desktop_bridge_required',
      transport: 'desktop_bridge',
      error: `${channel} customer-service chat requires an active desktop bridge binding.`
    })
  })
}

test('bridge channels attach the shared projection command when their connector supplies complete fields', () => {
  const adapter = new WechatShopCommerceAdapter()
  const event = adapter.normalizeOrder({
    order_id: 'wx-2',
    update_time: 1722470400,
    projection: completeProjection
  }, { accountId: 42 })

  assert.equal(event.payload.projectionCommand.schemaVersion, 2)
  assert.equal(event.payload.projectionCommand.channel, 'wechat_shop')
  assert.equal(event.payload.projectionCommand.externalOrderId, 'wx-2')
})
