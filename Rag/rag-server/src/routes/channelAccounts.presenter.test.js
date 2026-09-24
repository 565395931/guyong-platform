const test = require('node:test')
const assert = require('node:assert/strict')

const {
  presentChannelAccountListItem,
  presentChannelAccountDetail
} = require('./channelAccounts.presenter')

test('does not parse WAHA config for an enterprise WeChat account', () => {
  const account = {
    id: 7,
    channel: 'wecom',
    account_name: 'AI\u6d4b\u8bd5\u5ba2\u670d',
    adapter_type: 'wecom-kf',
    config: 'future-wecom-config'
  }
  let parseCalls = 0

  const result = presentChannelAccountListItem(account, {
    parseWahaConfig() {
      parseCalls += 1
      throw new Error('WAHA parser must not receive WeCom config')
    }
  })

  assert.equal(parseCalls, 0)
  assert.equal(result.config, undefined)
  assert.equal(result.sessionName, undefined)
  assert.equal(result.engine, undefined)
})

test('presents a configured WeChat mini program account without exposing app secret', () => {
  const account = {
    id: 8,
    channel: 'wechat',
    account_name: '微信小程序客服',
    adapter_type: 'wechat_mini_program',
    config: 'future-wechat-config'
  }

  const result = presentChannelAccountListItem(account, {
    parseWechatMiniProgramConfig: () => ({
      appId: 'wx123456',
      appSecret: 'never-return-this'
    })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.appId, undefined)
  assert.equal(result.appSecret, undefined)
  assert.equal(result.credentialStatus, 'configured')
  assert.equal(result.appIdMask, 'wx12****')
  assert.equal(JSON.stringify(result).includes('never-return-this'), false)
})

test('keeps WAHA compatibility fields for an existing WhatsApp account', () => {
  const account = {
    id: 3,
    channel: 'whatsapp',
    adapter_type: 'waha',
    config: 'encrypted-config'
  }

  const result = presentChannelAccountListItem(account, {
    defaultWahaEngine: 'gows',
    parseWahaConfig: () => ({ sessionName: 'sales', port: 3001 })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.sessionName, 'sales')
  assert.equal(result.port, 3001)
  assert.equal(result.engine, 'gows')
})

test('returns no legacy config details for a non-WAHA account', () => {
  const result = presentChannelAccountDetail({
    id: 7,
    channel: 'wecom',
    adapter_type: 'wecom-kf',
    config: 'future-wecom-config'
  }, {
    parseWahaConfig() {
      throw new Error('WAHA parser must not receive WeCom config')
    }
  })

  assert.equal(result.config, undefined)
})

test('presents a configured Douyin list item without exposing its config or secret', () => {
  const result = presentChannelAccountListItem({
    id: 21,
    channel: 'douyin',
    adapter_type: 'douyin_commerce',
    config: 'encrypted-douyin-config'
  }, {
    parseDouyinConfig: () => ({
      appKey: 'app-key',
      appSecret: 'never-return-this',
      shopId: 'shop-1001'
    })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.appSecret, undefined)
  assert.equal(JSON.stringify(result).includes('never-return-this'), false)
  assert.equal(result.credentialStatus, 'configured')
  assert.equal(result.callbackPath, '/api/channel/douyin/webhook?account_id=21')
})

test('presents an incomplete Douyin detail without exposing decrypted config', () => {
  const result = presentChannelAccountDetail({
    id: 22,
    channel: 'douyin',
    adapter_type: 'douyin_commerce',
    config: 'encrypted-douyin-config'
  }, {
    parseDouyinConfig: () => ({ appKey: 'app-key', appSecret: '', shopId: 'shop-1001' })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.appKey, undefined)
  assert.equal(result.appSecret, undefined)
  assert.equal(result.shopId, undefined)
  assert.equal(result.credentialStatus, 'incomplete')
  assert.equal(result.callbackPath, '/api/channel/douyin/webhook?account_id=22')
})

test('presents a configured Pinduoduo list item with only a masked mall ID', () => {
  const result = presentChannelAccountListItem({
    id: 31,
    channel: 'pinduoduo',
    adapter_type: 'pinduoduo_commerce',
    config: 'encrypted-pinduoduo-config',
    clientSecret: 'top-level-secret',
    accessToken: 'top-level-token'
  }, {
    parsePinduoduoConfig: () => ({
      clientId: 'client-id',
      clientSecret: 'never-return-this-secret',
      accessToken: 'never-return-this-token',
      mallId: '1234567890'
    })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.clientId, undefined)
  assert.equal(result.clientSecret, undefined)
  assert.equal(result.accessToken, undefined)
  assert.equal(result.mallId, undefined)
  assert.equal(JSON.stringify(result).includes('never-return-this'), false)
  assert.equal(result.credentialStatus, 'configured')
  assert.equal(result.mallIdMask, '******7890')
  assert.equal(result.callbackPath, undefined)
})

test('presents an incomplete Pinduoduo detail without exposing decrypted config', () => {
  const result = presentChannelAccountDetail({
    id: 32,
    channel: 'pinduoduo',
    adapter_type: 'pinduoduo_commerce',
    config: 'encrypted-pinduoduo-config'
  }, {
    parsePinduoduoConfig: () => ({
      clientId: 'client-id',
      clientSecret: '',
      accessToken: 'access-token',
      mallId: '1001'
    })
  })

  assert.equal(result.config, undefined)
  assert.equal(result.clientId, undefined)
  assert.equal(result.clientSecret, undefined)
  assert.equal(result.accessToken, undefined)
  assert.equal(result.mallId, undefined)
  assert.equal(result.credentialStatus, 'incomplete')
  assert.equal(result.mallIdMask, '****')
})

test('presents new commerce accounts without exposing official API secrets', () => {
  const cases = [
    {
      channel: 'xiaohongshu',
      adapter_type: 'xiaohongshu_commerce',
      parser: 'parseXiaohongshuConfig',
      config: { appKey: 'key', appSecret: 'secret', accessToken: 'token', shopId: 'xhs-123456' }
    },
    {
      channel: 'wechat_shop',
      adapter_type: 'wechat_shop_commerce',
      parser: 'parseWechatShopConfig',
      config: { appId: 'wx-app', appSecret: 'secret', shopId: 'wx-123456' }
    },
    {
      channel: 'kuaishou',
      adapter_type: 'kuaishou_commerce',
      parser: 'parseKuaishouConfig',
      config: { appKey: 'key', appSecret: 'secret', accessToken: 'token', shopId: 'ks-123456' }
    }
  ]

  for (const item of cases) {
    const result = presentChannelAccountListItem({
      id: 51,
      channel: item.channel,
      adapter_type: item.adapter_type,
      config: 'encrypted-config',
      appSecret: 'top-level-secret',
      accessToken: 'top-level-token'
    }, { [item.parser]: () => item.config })

    assert.equal(result.credentialStatus, 'configured')
    assert.match(result.shopIdMask, /3456$/)
    assert.equal(result.config, undefined)
    assert.equal(result.appSecret, undefined)
    assert.equal(result.accessToken, undefined)
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(JSON.stringify(result).includes('token'), false)
  }
})
