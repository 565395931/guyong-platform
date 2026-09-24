import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

let formModule = {}
try {
  formModule = await import('./wechatAccountForm.js')
} catch {
  // RED phase: the assertions below define the mini program account contract.
}

test('requires App ID and App Secret for a WeChat mini program account', () => {
  assert.equal(typeof formModule.validateWechatAccountForm, 'function')
  assert.deepEqual(formModule.validateWechatAccountForm({}), [
    '账号名称不能为空',
    'App ID 不能为空',
    'App Secret 不能为空'
  ])
})

test('normalizes the WeChat mini program form and builds the create request', () => {
  assert.equal(typeof formModule.buildWechatAccountCreateRequest, 'function')
  const form = formModule.normalizeWechatAccountForm({
    accountName: ' 微信小程序客服 ',
    appId: ' wx123456 ',
    appSecret: ' secret-123 ',
    maxDailyQuota: '500'
  })

  assert.deepEqual(formModule.buildWechatAccountCreateRequest(form), {
    channel: 'wechat',
    account_name: '微信小程序客服',
    adapter_type: 'wechat_mini_program',
    max_daily_quota: 500,
    config: {
      appId: 'wx123456',
      appSecret: 'secret-123'
    }
  })
})

test('account view renders a dedicated WeChat mini program form', () => {
  const viewUrl = new URL('../../views/Settings/AccountManage.vue', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const view = readFileSync(viewUrl, 'utf8')

  assert.match(view, /addForm\.channel === 'wechat'/)
  assert.match(view, /label="App ID" prop="appId"/)
  assert.match(view, /label="App Secret" prop="appSecret"[\s\S]*v-model="addForm\.appSecret"[\s\S]*type="password"/)
  assert.match(view, /addForm\.appId = ''[\s\S]*addForm\.appSecret = ''/)
})
