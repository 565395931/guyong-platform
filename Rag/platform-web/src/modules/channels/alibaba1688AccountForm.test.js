import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

let formModule = {}
try {
  formModule = await import('./alibaba1688AccountForm.js')
} catch {
  // RED phase: the assertions below define the account-form contract.
}
import { getChannelCapabilities } from './channelCapabilities.js'
import { channelEventEmptyState } from './channelEvents.js'

test('requires every official 1688 credential', () => {
  assert.equal(typeof formModule.validateAlibaba1688AccountForm, 'function')
  assert.deepEqual(formModule.validateAlibaba1688AccountForm({}), [
    '账号名称不能为空',
    'App Key 不能为空',
    'App Secret 不能为空',
    'Access Token 不能为空',
    'Seller Member ID 不能为空'
  ])
})

test('normalizes the 1688 form and builds a forced-adapter create request', () => {
  assert.equal(typeof formModule.buildAlibaba1688AccountCreateRequest, 'function')
  const form = formModule.normalizeAlibaba1688AccountForm({
    accountName: ' 1688 华东店 ',
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    accessToken: ' access-token ',
    sellerMemberId: ' seller-member-id ',
    maxDailyQuota: '800'
  })

  assert.deepEqual(formModule.buildAlibaba1688AccountCreateRequest(form), {
    channel: 'alibaba1688',
    account_name: '1688 华东店',
    adapter_type: 'alibaba1688_commerce',
    max_daily_quota: 800,
    config: {
      appKey: 'app-key',
      appSecret: 'app-secret',
      accessToken: 'access-token',
      sellerMemberId: 'seller-member-id'
    }
  })
})

test('exposes 1688 order and refund events without public chat controls', () => {
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

test('uses 1688-specific account and event empty copy', () => {
  assert.deepEqual(channelEventEmptyState(0, 'alibaba1688'), {
    title: '尚未配置 1688 账号',
    description: '请联系管理员先完成 1688 开放平台账号接入。'
  })
  assert.deepEqual(channelEventEmptyState(1, 'alibaba1688'), {
    title: '暂无业务事件',
    description: '当前筛选条件下没有订单或退款事件。'
  })
})

test('account view uses password inputs, masked member identity and clears 1688 secrets', () => {
  const viewUrl = new URL('../../views/Settings/AccountManage.vue', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const view = readFileSync(viewUrl, 'utf8')

  assert.match(view, /addForm\.channel === 'alibaba1688'/)
  assert.match(view, /label="Seller Member ID" prop="sellerMemberId"/)
  assert.match(view, /label="App Secret" prop="appSecret"[\s\S]*v-model="addForm\.appSecret"[\s\S]*type="password"/)
  assert.match(view, /label="Access Token" prop="accessToken"[\s\S]*v-model="addForm\.accessToken"[\s\S]*type="password"/)
  assert.match(view, /row\.sellerMemberIdMask/)
  assert.match(view, /addForm\.appSecret = ''[\s\S]*addForm\.accessToken = ''/)
  assert.doesNotMatch(view, /1688[\s\S]*发送消息|1688[\s\S]*回复买家/)
})
