const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeDouyinAccountConfig,
  validateDouyinAccountConfig,
  prepareDouyinAccountCreation
} = require('./douyinAccountConfig')

test('normalizes all Douyin commerce credentials', () => {
  assert.deepEqual(normalizeDouyinAccountConfig({
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    shopId: ' shop-1001 '
  }), {
    appKey: 'app-key',
    appSecret: 'app-secret',
    shopId: 'shop-1001'
  })
})

test('rejects every missing or non-string Douyin credential', () => {
  assert.throws(
    () => validateDouyinAccountConfig({ appKey: '', appSecret: 'secret', shopId: 'shop' }),
    /appKey/
  )
  assert.throws(
    () => validateDouyinAccountConfig({ appKey: 'key', appSecret: 123, shopId: 'shop' }),
    /appSecret/
  )
  assert.throws(
    () => validateDouyinAccountConfig({ appKey: 'key', appSecret: 'secret', shopId: '   ' }),
    /shopId/
  )
})

test('treats a null config as missing credentials instead of an internal error', () => {
  assert.throws(
    () => validateDouyinAccountConfig(null),
    error => error.code === 'DOUYIN_ACCOUNT_CONFIG_INVALID' &&
      assert.deepEqual(error.fields, ['appKey', 'appSecret', 'shopId']) === undefined
  )
})

test('forces the Douyin commerce adapter during account creation', () => {
  assert.deepEqual(prepareDouyinAccountCreation({
    adapter_type: 'manual',
    config: { appKey: ' key ', appSecret: ' secret ', shopId: ' shop ' }
  }), {
    adapterType: 'douyin_commerce',
    config: { appKey: 'key', appSecret: 'secret', shopId: 'shop' }
  })
})
