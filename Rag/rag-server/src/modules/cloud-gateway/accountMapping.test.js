const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudGatewayAccountLoader } = require('./accountMapping')

test('loads an active WeCom account as a cloud-gateway mapping from channel_accounts', async () => {
  const calls = []
  const loader = createCloudGatewayAccountLoader({
    sequelize: {
      query: async (sql, options) => {
        calls.push({ sql, options })
        return [[{
          id: 17,
          channel: 'wecom_kf',
          account_name: 'AI测试客服',
          adapter_type: 'wecom_official',
          external_account_id: 'wk-test'
        }]]
      }
    }
  })

  const mapping = await loader(17)

  assert.equal(mapping.accountId, 17)
  assert.equal(mapping.gatewayAccountId, 'wk-test')
  assert.equal(mapping.channel, 'wecom_kf')
  assert.equal(mapping.adapterType, 'wecom_official')
  assert.equal(calls[0].options.replacements.accountId, 17)
  assert.match(calls[0].sql, /adapter_type IN/)
})

test('loads cloud-gateway mock accounts with their stable mock gateway id', async () => {
  const loader = createCloudGatewayAccountLoader({
    sequelize: {
      query: async () => [[{
        id: 23,
        channel: 'wechat',
        account_name: '微信 Mock',
        adapter_type: 'cloud_gateway_mock',
        external_account_id: null
      }]]
    }
  })

  const mapping = await loader(23)

  assert.equal(mapping.gatewayAccountId, 'mock-account-23')
  assert.equal(mapping.isMock, true)
})

test('returns null when no active cloud-gateway account exists', async () => {
  const loader = createCloudGatewayAccountLoader({
    sequelize: { query: async () => [[]] }
  })

  assert.equal(await loader(99), null)
})
