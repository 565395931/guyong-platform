const { createBridgeCommerceAdapter } = require('../bridgeCommerceAdapter')

module.exports = createBridgeCommerceAdapter({
  channel: 'kuaishou',
  adapterType: 'kuaishou_commerce',
  order: { idPaths: ['oid', 'orderId', 'order_id'], timePaths: ['updateTime', 'update_time', 'updated_at'] },
  afterSales: { idPaths: ['refundId', 'refund_id'], timePaths: ['updateTime', 'update_time', 'updated_at'] },
  product: { idPaths: ['goodsId', 'goods_id'], timePaths: ['updateTime', 'update_time', 'updated_at'] }
})
