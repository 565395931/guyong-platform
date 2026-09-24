const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_CHANNEL_DEFINITIONS,
  seedDefaultChannelDefinitions
} = require('./channelDefinitions.seed')

test('uses the commerce adapter for the default Douyin channel', () => {
  const douyin = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === 'douyin')
  assert.equal(douyin.adapterType, 'douyin_commerce')
})

test('uses the mini program adapter for the default WeChat channel', () => {
  const wechat = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === 'wechat')
  assert.equal(wechat.adapterType, 'wechat_mini_program')
  assert.equal(wechat.label, '微信小程序')
})

test('uses the commerce adapter for the default Pinduoduo channel', () => {
  const pinduoduo = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === 'pinduoduo')
  assert.equal(pinduoduo.adapterType, 'pinduoduo_commerce')
})

test('registers Xiaohongshu, WeChat Shop and Kuaishou as domestic commerce channels', () => {
  const expected = {
    xiaohongshu: 'xiaohongshu_commerce',
    wechat_shop: 'wechat_shop_commerce',
    kuaishou: 'kuaishou_commerce'
  }

  for (const [code, adapterType] of Object.entries(expected)) {
    const definition = DEFAULT_CHANNEL_DEFINITIONS.find(item => item.code === code)
    assert.ok(definition, `${code} should be seeded`)
    assert.equal(definition.adapterType, adapterType)
    assert.equal(definition.scope, 'domestic')
  }
})

test('idempotently corrects only the persisted Douyin adapter type', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options = {}) {
      calls.push({ sql, replacements: options.replacements })
    }
  }

  await seedDefaultChannelDefinitions(sequelize)

  const correction = calls.find(call => /UPDATE channel_definitions/.test(call.sql))
  assert.ok(correction)
  assert.match(correction.sql, /WHERE code = :code/)
  assert.match(correction.sql, /adapter_type IS NULL/)
  assert.deepEqual(correction.replacements, {
    code: 'douyin',
    adapterType: 'douyin_commerce'
  })
})

test('idempotently corrects the persisted WeChat label and adapter type', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options = {}) {
      calls.push({ sql, replacements: options.replacements })
    }
  }

  await seedDefaultChannelDefinitions(sequelize)

  const correction = calls.find(call =>
    /UPDATE channel_definitions/.test(call.sql) &&
    call.replacements?.code === 'wechat'
  )
  assert.ok(correction)
  assert.match(correction.sql, /WHERE code = :code/)
  assert.match(correction.sql, /adapter_type IS NULL/)
  assert.match(correction.sql, /label = :label/)
  assert.deepEqual(correction.replacements, {
    code: 'wechat',
    label: '微信小程序',
    adapterType: 'wechat_mini_program'
  })
})

test('idempotently corrects the persisted Pinduoduo adapter type', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options = {}) {
      calls.push({ sql, replacements: options.replacements })
    }
  }

  await seedDefaultChannelDefinitions(sequelize)

  const correction = calls.find(call =>
    /UPDATE channel_definitions/.test(call.sql) &&
    call.replacements?.code === 'pinduoduo'
  )
  assert.ok(correction)
  assert.match(correction.sql, /WHERE code = :code/)
  assert.match(correction.sql, /adapter_type IS NULL/)
  assert.deepEqual(correction.replacements, {
    code: 'pinduoduo',
    adapterType: 'pinduoduo_commerce'
  })
})
