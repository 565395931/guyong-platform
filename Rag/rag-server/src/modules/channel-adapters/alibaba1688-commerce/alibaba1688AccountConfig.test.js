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

function loadAccountConfig() {
  let accountConfig
  try {
    accountConfig = require('./alibaba1688AccountConfig')
  } catch {
    // RED phase: the assertions below define the account contract.
  }
  assert.ok(accountConfig, 'alibaba1688AccountConfig module must exist')
  return accountConfig
}

test('exposes encrypted order and refund events without buyer chat capabilities', () => {
  assert.deepEqual(getChannelCapabilities('alibaba1688'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '1688 公开服务端 API 不提供独立网页买家聊天发送能力，本系统只同步加密场景订单和退款事件'
  })
})

test('normalizes and validates every 1688 credential', () => {
  const {
    normalizeAlibaba1688AccountConfig,
    validateAlibaba1688AccountConfig
  } = loadAccountConfig()
  assert.deepEqual(normalizeAlibaba1688AccountConfig({
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    accessToken: ' access-token ',
    sellerMemberId: ' seller-member-id '
  }), {
    appKey: 'app-key',
    appSecret: 'app-secret',
    accessToken: 'access-token',
    sellerMemberId: 'seller-member-id'
  })
  assert.throws(
    () => validateAlibaba1688AccountConfig({ appKey: 123, appSecret: 'secret', accessToken: ' ', sellerMemberId: '' }),
    error => error.code === 'ALIBABA1688_ACCOUNT_CONFIG_INVALID' &&
      assert.deepEqual(error.fields, ['appKey', 'accessToken', 'sellerMemberId']) === undefined
  )
})

test('parses encrypted credentials and forces alibaba1688_commerce', () => {
  const {
    parseAlibaba1688AccountConfig,
    prepareAlibaba1688AccountCreation
  } = loadAccountConfig()
  const encrypted = encrypt({
    appKey: 'app-key',
    appSecret: 'app-secret',
    accessToken: 'access-token',
    sellerMemberId: 'seller-member-id'
  })

  assert.deepEqual(parseAlibaba1688AccountConfig(encrypted, 'test'), {
    appKey: 'app-key',
    appSecret: 'app-secret',
    accessToken: 'access-token',
    sellerMemberId: 'seller-member-id'
  })
  assert.deepEqual(prepareAlibaba1688AccountCreation({
    adapter_type: 'manual',
    config: {
      appKey: ' key ',
      appSecret: ' secret ',
      accessToken: ' token ',
      sellerMemberId: ' member '
    }
  }), {
    adapterType: 'alibaba1688_commerce',
    config: {
      appKey: 'key',
      appSecret: 'secret',
      accessToken: 'token',
      sellerMemberId: 'member'
    }
  })

  const routeSource = readFileSync(require.resolve('../../../routes/channelAccounts'), 'utf8')
  assert.match(routeSource, /prepareAlibaba1688AccountCreation/)
  assert.match(routeSource, /channelCode\s*===\s*['"]alibaba1688['"]/)
  assert.match(routeSource, /ALIBABA1688_ACCOUNT_CONFIG_INVALID/)
})

test('seeds active 1688 commerce and corrects its adapter idempotently', async () => {
  const definition = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === 'alibaba1688')
  assert.deepEqual(definition, {
    code: 'alibaba1688',
    label: '1688',
    adapterType: 'alibaba1688_commerce',
    scope: 'domestic',
    sort: 60
  })

  const calls = []
  await seedDefaultChannelDefinitions({
    async query(sql, options = {}) {
      calls.push({ sql, replacements: options.replacements })
    }
  })
  const correction = calls.find(call =>
    /UPDATE channel_definitions/.test(call.sql) && call.replacements?.code === 'alibaba1688'
  )
  assert.ok(correction)
  assert.match(correction.sql, /adapter_type IS NULL/)
  assert.deepEqual(correction.replacements, {
    code: 'alibaba1688',
    adapterType: 'alibaba1688_commerce'
  })
})

test('presents only credential status and masked seller member id', () => {
  const configured = presentChannelAccountListItem({
    id: 51,
    channel: 'alibaba1688',
    adapter_type: 'alibaba1688_commerce',
    config: 'encrypted-config',
    appKey: 'top-level-key',
    appSecret: 'top-level-secret',
    accessToken: 'top-level-token',
    sellerMemberId: 'top-level-member'
  }, {
    parseAlibaba1688Config: () => ({
      appKey: 'app-key',
      appSecret: 'never-return-secret',
      accessToken: 'never-return-token',
      sellerMemberId: 'b2b-1234567890'
    })
  })
  assert.equal(configured.credentialStatus, 'configured')
  assert.equal(configured.sellerMemberIdMask, 'b2b-******7890')
  assert.equal(configured.config, undefined)
  assert.equal(configured.appKey, undefined)
  assert.equal(configured.appSecret, undefined)
  assert.equal(configured.accessToken, undefined)
  assert.equal(configured.sellerMemberId, undefined)
  assert.equal(JSON.stringify(configured).includes('never-return'), false)

  const incomplete = presentChannelAccountDetail({
    id: 52,
    channel: 'alibaba1688',
    adapter_type: 'alibaba1688_commerce',
    config: 'encrypted-config',
    app_key: 'top-level-key',
    app_secret: 'top-level-secret',
    access_token: 'top-level-token',
    seller_member_id: 'top-level-member'
  }, {
    parseAlibaba1688Config: () => ({
      appKey: 'app-key',
      appSecret: '',
      accessToken: 'access-token',
      sellerMemberId: '1688'
    })
  })
  assert.equal(incomplete.credentialStatus, 'incomplete')
  assert.equal(incomplete.sellerMemberIdMask, '****')
  assert.equal(incomplete.config, undefined)
  assert.equal(incomplete.app_key, undefined)
  assert.equal(incomplete.app_secret, undefined)
  assert.equal(incomplete.access_token, undefined)
  assert.equal(incomplete.seller_member_id, undefined)

  const shortId = presentChannelAccountListItem({
    id: 53,
    channel: 'alibaba1688',
    config: 'encrypted-config'
  }, {
    parseAlibaba1688Config: () => ({
      appKey: 'app-key',
      appSecret: 'app-secret',
      accessToken: 'access-token',
      sellerMemberId: 'abcde'
    })
  })
  assert.equal(shortId.sellerMemberIdMask, '*****')
})
