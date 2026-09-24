import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

let formModule = {}
try {
  formModule = await import('./taobaoAccountForm.js')
} catch {
  // RED phase: the assertions below define the account-form contract.
}
import { getChannelCapabilities } from './channelCapabilities.js'

test('requires every official Taobao credential', () => {
  assert.equal(typeof formModule.validateTaobaoAccountForm, 'function')
  assert.deepEqual(formModule.validateTaobaoAccountForm({}), [
    '账号名称不能为空',
    'App Key 不能为空',
    'App Secret 不能为空',
    'Session Key 不能为空',
    '卖家昵称不能为空'
  ])
})

test('normalizes the Taobao form and builds a forced-adapter create request', () => {
  assert.equal(typeof formModule.buildTaobaoAccountCreateRequest, 'function')
  const form = formModule.normalizeTaobaoAccountForm({
    accountName: ' 淘宝旗舰店 ',
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    sessionKey: ' session-key ',
    sellerNick: ' lonely-brave ',
    maxDailyQuota: '800'
  })

  assert.deepEqual(formModule.buildTaobaoAccountCreateRequest(form), {
    channel: 'taobao',
    account_name: '淘宝旗舰店',
    adapter_type: 'taobao_commerce',
    max_daily_quota: 800,
    config: {
      appKey: 'app-key',
      appSecret: 'app-secret',
      sessionKey: 'session-key',
      sellerNick: 'lonely-brave'
    }
  })
})

test('exposes Taobao order and refund events without public chat controls', () => {
  assert.deepEqual(getChannelCapabilities('taobao'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '淘宝开放平台公开服务端 API 不提供独立网页买家聊天发送能力，本系统只同步订单和退款事件'
  })
})

test('account view uses password inputs, masked seller identity and clears Taobao secrets', () => {
  const viewUrl = new URL('../../views/Settings/AccountManage.vue', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const view = readFileSync(viewUrl, 'utf8')

  assert.match(view, /addForm\.channel === 'taobao'/)
  assert.match(view, /label="Seller Nick" prop="sellerNick"/)
  assert.match(view, /label="App Secret" prop="appSecret"[\s\S]*v-model="addForm\.appSecret"[\s\S]*type="password"/)
  assert.match(view, /label="Session Key" prop="sessionKey"[\s\S]*v-model="addForm\.sessionKey"[\s\S]*type="password"/)
  assert.match(view, /row\.sellerNickMask/)
  assert.match(view, /addForm\.appSecret = ''[\s\S]*addForm\.sessionKey = ''/)
  assert.doesNotMatch(view, /淘宝[\s\S]*发送消息|淘宝[\s\S]*回复买家/)
})
