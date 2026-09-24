const test = require('node:test')
const assert = require('node:assert/strict')

let configModule = {}
try {
  configModule = require('./wechatAccountConfig')
} catch {
  // RED phase: the assertions below define the mini program account contract.
}

test('requires App ID and App Secret for a WeChat mini program account', () => {
  assert.equal(typeof configModule.validateWechatMiniProgramAccountConfig, 'function')
  assert.throws(
    () => configModule.validateWechatMiniProgramAccountConfig({}),
    error => error.code === 'WECHAT_MINI_PROGRAM_ACCOUNT_CONFIG_INVALID' &&
      Array.isArray(error.fields) &&
      error.fields.join(',') === 'appId,appSecret'
  )
})

test('normalizes and forces the WeChat mini program adapter type', () => {
  assert.equal(typeof configModule.prepareWechatMiniProgramAccountCreation, 'function')
  const prepared = configModule.prepareWechatMiniProgramAccountCreation({
    config: {
      appId: ' wx123456 ',
      appSecret: ' secret-123 '
    }
  })

  assert.deepEqual(prepared, {
    adapterType: 'wechat_mini_program',
    config: {
      appId: 'wx123456',
      appSecret: 'secret-123'
    }
  })
})
