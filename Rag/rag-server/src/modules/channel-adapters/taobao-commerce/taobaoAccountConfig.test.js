const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { encrypt } = require('../../../shared/utils/encrypt')
const { getChannelCapabilities } = require('../../channel-capabilities/channelCapabilities')
const {
  DEFAULT_CHANNEL_DEFINITIONS,
  seedDefaultChannelDefinitions
} = require('../../channel-capabilities/channelDefinitions.seed')
const {
  presentChannelAccountListItem,
  presentChannelAccountDetail
} = require('../../../routes/channelAccounts.presenter')

function loadTaobaoAccountConfig() {
  let accountConfig
  try {
    accountConfig = require('./taobaoAccountConfig')
  } catch {
    // Keep the RED phase as a behavioral assertion failure.
  }
  assert.ok(accountConfig, 'taobaoAccountConfig module must exist')
  return accountConfig
}

test('exposes Taobao order and refund sync without pretending buyer chat APIs exist', () => {
  assert.deepEqual(getChannelCapabilities('taobao'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '淘宝公开服务端 API 不提供本独立网页系统可用的买家客服聊天收发能力，只同步订单退款并保留 buyer_open_uid/ouid'
  })
})

test('trims all Taobao commerce credentials', () => {
  const { normalizeTaobaoAccountConfig } = loadTaobaoAccountConfig()

  assert.deepEqual(normalizeTaobaoAccountConfig({
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    sessionKey: ' session-key ',
    sellerNick: ' seller-nick '
  }), {
    appKey: 'app-key',
    appSecret: 'app-secret',
    sessionKey: 'session-key',
    sellerNick: 'seller-nick'
  })
})

test('reports every missing, blank or non-string Taobao credential', () => {
  const { validateTaobaoAccountConfig } = loadTaobaoAccountConfig()

  assert.throws(
    () => validateTaobaoAccountConfig({}),
    error => error.code === 'TAOBAO_ACCOUNT_CONFIG_INVALID' &&
      assert.deepEqual(error.fields, ['appKey', 'appSecret', 'sessionKey', 'sellerNick']) === undefined
  )
  assert.throws(
    () => validateTaobaoAccountConfig({
      appKey: 123,
      appSecret: 'secret',
      sessionKey: '   ',
      sellerNick: 'seller'
    }),
    error => assert.deepEqual(error.fields, ['appKey', 'sessionKey']) === undefined
  )
})

test('parses encrypted Taobao credentials without weakening validation', () => {
  const {
    parseTaobaoAccountConfig,
    hasCompleteTaobaoAccountConfig
  } = loadTaobaoAccountConfig()
  const encrypted = encrypt({
    appKey: 'app-key',
    appSecret: 'app-secret',
    sessionKey: 'session-key',
    sellerNick: 'seller-nick'
  })

  const parsed = parseTaobaoAccountConfig(encrypted, 'test')

  assert.equal(hasCompleteTaobaoAccountConfig(parsed), true)
  assert.deepEqual(parsed, {
    appKey: 'app-key',
    appSecret: 'app-secret',
    sessionKey: 'session-key',
    sellerNick: 'seller-nick'
  })
})

test('forces taobao_commerce during account preparation and route creation', () => {
  const { prepareTaobaoAccountCreation } = loadTaobaoAccountConfig()
  assert.deepEqual(prepareTaobaoAccountCreation({
    adapter_type: 'manual',
    config: {
      appKey: ' key ',
      appSecret: ' secret ',
      sessionKey: ' session ',
      sellerNick: ' seller '
    }
  }), {
    adapterType: 'taobao_commerce',
    config: {
      appKey: 'key',
      appSecret: 'secret',
      sessionKey: 'session',
      sellerNick: 'seller'
    }
  })

  const routeSource = readFileSync(require.resolve('../../../routes/channelAccounts'), 'utf8')
  assert.match(routeSource, /prepareTaobaoAccountCreation/)
  assert.match(routeSource, /channelCode\s*===\s*['"]taobao['"]/)
  assert.match(routeSource, /TAOBAO_ACCOUNT_CONFIG_INVALID/)
})

test('seeds Taobao as an active commerce channel and corrects its adapter idempotently', async () => {
  const taobao = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === 'taobao')
  assert.ok(taobao, 'default Taobao channel must exist')
  assert.deepEqual(taobao, {
    code: 'taobao',
    label: '淘宝 / 千牛',
    adapterType: 'taobao_commerce',
    scope: 'domestic',
    sort: 50
  })

  const calls = []
  await seedDefaultChannelDefinitions({
    async query(sql, options = {}) {
      calls.push({ sql, replacements: options.replacements })
    }
  })
  const correction = calls.find(call =>
    /UPDATE channel_definitions/.test(call.sql) && call.replacements?.code === 'taobao'
  )
  assert.ok(correction, 'persisted Taobao adapter type must be corrected')
  assert.match(correction.sql, /adapter_type IS NULL/)
  assert.deepEqual(correction.replacements, {
    code: 'taobao',
    adapterType: 'taobao_commerce'
  })
})

test('presents configured Taobao list data with only credential status and masked seller nick', () => {
  const result = presentChannelAccountListItem({
    id: 41,
    channel: 'taobao',
    adapter_type: 'taobao_commerce',
    config: 'encrypted-taobao-config',
    appKey: 'top-level-key',
    appSecret: 'top-level-secret',
    sessionKey: 'top-level-session',
    sellerNick: 'top-level-seller'
  }, {
    parseTaobaoConfig: () => ({
      appKey: 'app-key',
      appSecret: 'never-return-this-secret',
      sessionKey: 'never-return-this-session',
      sellerNick: 'shop1234'
    })
  })

  assert.equal(result.credentialStatus, 'configured')
  assert.equal(result.sellerNickMask, 's******4')
  assert.equal(result.config, undefined)
  assert.equal(result.appKey, undefined)
  assert.equal(result.appSecret, undefined)
  assert.equal(result.sessionKey, undefined)
  assert.equal(result.sellerNick, undefined)
  assert.equal(JSON.stringify(result).includes('never-return-this'), false)
})

test('presents incomplete Taobao detail without exposing config or credential aliases', () => {
  const result = presentChannelAccountDetail({
    id: 42,
    channel: 'taobao',
    adapter_type: 'taobao_commerce',
    config: 'encrypted-taobao-config',
    app_key: 'top-level-key',
    app_secret: 'top-level-secret',
    session_key: 'top-level-session',
    seller_nick: 'top-level-seller'
  }, {
    parseTaobaoConfig: () => ({
      appKey: 'app-key',
      appSecret: '',
      sessionKey: 'session-key',
      sellerNick: 'ab'
    })
  })

  assert.equal(result.credentialStatus, 'incomplete')
  assert.equal(result.sellerNickMask, '**')
  assert.equal(result.config, undefined)
  assert.equal(result.app_key, undefined)
  assert.equal(result.app_secret, undefined)
  assert.equal(result.session_key, undefined)
  assert.equal(result.seller_nick, undefined)
})
