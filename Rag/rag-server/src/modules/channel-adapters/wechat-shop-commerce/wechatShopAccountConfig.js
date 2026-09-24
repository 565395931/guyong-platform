const { createCommerceAccountConfig } = require('../commerceAccountConfig')

const config = createCommerceAccountConfig({
  adapterType: 'wechat_shop_commerce',
  errorCode: 'WECHAT_SHOP_ACCOUNT_CONFIG_INVALID',
  requiredFields: ['appId', 'appSecret', 'shopId'],
  logName: 'WechatShop'
})

module.exports = {
  WECHAT_SHOP_COMMERCE_ADAPTER_TYPE: 'wechat_shop_commerce',
  normalizeWechatShopAccountConfig: config.normalize,
  validateWechatShopAccountConfig: config.validate,
  hasCompleteWechatShopAccountConfig: config.hasComplete,
  parseWechatShopAccountConfig: config.parse,
  prepareWechatShopAccountCreation: config.prepare
}
