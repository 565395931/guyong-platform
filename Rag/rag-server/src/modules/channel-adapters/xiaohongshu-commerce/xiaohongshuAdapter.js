const { createBridgeCommerceAdapter } = require('../bridgeCommerceAdapter')

module.exports = createBridgeCommerceAdapter({
  channel: 'xiaohongshu',
  adapterType: 'xiaohongshu_commerce',
  order: { idPaths: ['package_id', 'order_id'], timePaths: ['update_time', 'updated_at'] },
  afterSales: { idPaths: ['after_sale_id', 'refund_id'], timePaths: ['update_time', 'updated_at'] },
  product: { idPaths: ['item_id', 'product_id'], timePaths: ['update_time', 'updated_at'] }
})
