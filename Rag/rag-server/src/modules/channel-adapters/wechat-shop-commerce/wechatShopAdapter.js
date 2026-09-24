const { createBridgeCommerceAdapter } = require('../bridgeCommerceAdapter')

module.exports = createBridgeCommerceAdapter({
  channel: 'wechat_shop',
  adapterType: 'wechat_shop_commerce',
  order: { idPaths: ['order_id', 'orderId'], timePaths: ['update_time', 'updated_at'] },
  afterSales: { idPaths: ['after_sale_order_id', 'refund_id'], timePaths: ['update_time', 'updated_at'] },
  product: { idPaths: ['product_id', 'productId'], timePaths: ['update_time', 'updated_at'] }
})
