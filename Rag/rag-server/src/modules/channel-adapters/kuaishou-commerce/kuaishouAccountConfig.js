const { createCommerceAccountConfig } = require('../commerceAccountConfig')

const config = createCommerceAccountConfig({
  adapterType: 'kuaishou_commerce',
  errorCode: 'KUAISHOU_ACCOUNT_CONFIG_INVALID',
  requiredFields: ['appKey', 'appSecret', 'accessToken', 'shopId'],
  logName: 'Kuaishou'
})

module.exports = {
  KUAISHOU_COMMERCE_ADAPTER_TYPE: 'kuaishou_commerce',
  normalizeKuaishouAccountConfig: config.normalize,
  validateKuaishouAccountConfig: config.validate,
  hasCompleteKuaishouAccountConfig: config.hasComplete,
  parseKuaishouAccountConfig: config.parse,
  prepareKuaishouAccountCreation: config.prepare
}
