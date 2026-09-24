const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizePinduoduoAccountConfig,
  validatePinduoduoAccountConfig,
  preparePinduoduoAccountCreation
} = require('./pinduoduoAccountConfig')

test('trims all Pinduoduo commerce credentials', () => {
  assert.deepEqual(normalizePinduoduoAccountConfig({
    clientId: ' client-id ',
    clientSecret: ' client-secret ',
    accessToken: ' access-token ',
    mallId: ' 1001 '
  }), {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accessToken: 'access-token',
    mallId: '1001'
  })
})

test('reports every missing Pinduoduo credential in the validation error', () => {
  assert.throws(
    () => validatePinduoduoAccountConfig({}),
    error => error.code === 'PINDUODUO_ACCOUNT_CONFIG_INVALID' &&
      assert.deepEqual(error.fields, ['clientId', 'clientSecret', 'accessToken', 'mallId']) === undefined &&
      /clientId, clientSecret, accessToken, mallId/.test(error.message)
  )
})

test('rejects blank and non-string Pinduoduo credentials', () => {
  assert.throws(
    () => validatePinduoduoAccountConfig({
      clientId: 123,
      clientSecret: 'secret',
      accessToken: 'token',
      mallId: '1001'
    }),
    error => error.fields.includes('clientId')
  )
  assert.throws(
    () => validatePinduoduoAccountConfig({
      clientId: 'id',
      clientSecret: '   ',
      accessToken: 'token',
      mallId: '1001'
    }),
    error => error.fields.includes('clientSecret')
  )
})

test('forces the Pinduoduo commerce adapter during account creation', () => {
  assert.deepEqual(preparePinduoduoAccountCreation({
    adapter_type: 'manual',
    config: {
      clientId: ' id ',
      clientSecret: ' secret ',
      accessToken: ' token ',
      mallId: ' 1001 '
    }
  }), {
    adapterType: 'pinduoduo_commerce',
    config: {
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'token',
      mallId: '1001'
    }
  })
})
