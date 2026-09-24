const test = require('node:test')
const assert = require('node:assert/strict')

const {
  validateXiaohongshuAccountConfig,
  prepareXiaohongshuAccountCreation
} = require('./xiaohongshu-commerce/xiaohongshuAccountConfig')
const {
  validateWechatShopAccountConfig,
  prepareWechatShopAccountCreation
} = require('./wechat-shop-commerce/wechatShopAccountConfig')
const {
  validateKuaishouAccountConfig,
  prepareKuaishouAccountCreation
} = require('./kuaishou-commerce/kuaishouAccountConfig')

test('validates and prepares Xiaohongshu official API credentials', () => {
  assert.throws(
    () => validateXiaohongshuAccountConfig({ appKey: 'key' }),
    error => error.code === 'XIAOHONGSHU_ACCOUNT_CONFIG_INVALID' &&
      error.fields.join(',') === 'appSecret,accessToken,shopId'
  )
  assert.deepEqual(prepareXiaohongshuAccountCreation({ config: {
    appKey: ' key ', appSecret: ' secret ', accessToken: ' token ', shopId: ' shop '
  } }), {
    adapterType: 'xiaohongshu_commerce',
    config: { appKey: 'key', appSecret: 'secret', accessToken: 'token', shopId: 'shop' }
  })
})

test('validates and prepares WeChat Shop official API credentials', () => {
  assert.throws(
    () => validateWechatShopAccountConfig({ appId: 'wx-app' }),
    error => error.code === 'WECHAT_SHOP_ACCOUNT_CONFIG_INVALID' &&
      error.fields.join(',') === 'appSecret,shopId'
  )
  assert.deepEqual(prepareWechatShopAccountCreation({ config: {
    appId: ' wx-app ', appSecret: ' secret ', shopId: ' shop '
  } }), {
    adapterType: 'wechat_shop_commerce',
    config: { appId: 'wx-app', appSecret: 'secret', shopId: 'shop' }
  })
})

test('validates and prepares Kuaishou official API credentials', () => {
  assert.throws(
    () => validateKuaishouAccountConfig({ appKey: 'key' }),
    error => error.code === 'KUAISHOU_ACCOUNT_CONFIG_INVALID' &&
      error.fields.join(',') === 'appSecret,accessToken,shopId'
  )
  assert.deepEqual(prepareKuaishouAccountCreation({ config: {
    appKey: ' key ', appSecret: ' secret ', accessToken: ' token ', shopId: ' shop '
  } }), {
    adapterType: 'kuaishou_commerce',
    config: { appKey: 'key', appSecret: 'secret', accessToken: 'token', shopId: 'shop' }
  })
})
