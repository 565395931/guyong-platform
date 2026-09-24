const { createCommerceAccountConfig } = require('../commerceAccountConfig')

const config = createCommerceAccountConfig({
  adapterType: 'xiaohongshu_commerce',
  errorCode: 'XIAOHONGSHU_ACCOUNT_CONFIG_INVALID',
  requiredFields: ['appKey', 'appSecret', 'accessToken', 'shopId'],
  logName: 'Xiaohongshu'
})

module.exports = {
  XIAOHONGSHU_COMMERCE_ADAPTER_TYPE: 'xiaohongshu_commerce',
  normalizeXiaohongshuAccountConfig: config.normalize,
  validateXiaohongshuAccountConfig: config.validate,
  hasCompleteXiaohongshuAccountConfig: config.hasComplete,
  parseXiaohongshuAccountConfig: config.parse,
  prepareXiaohongshuAccountCreation: config.prepare
}
