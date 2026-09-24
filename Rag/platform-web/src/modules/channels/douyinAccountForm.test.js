import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDouyinAccountCreateRequest,
  buildDouyinCallbackUrl,
  normalizeDouyinAccountForm,
  validateDouyinAccountForm
} from './douyinAccountForm.js'
import { getChannelCapabilities } from './channelCapabilities.js'

test('requires App Key, App Secret and shop ID for a Douyin account', () => {
  assert.deepEqual(validateDouyinAccountForm({}), [
    '账号名称不能为空',
    'App Key 不能为空',
    'App Secret 不能为空',
    '店铺 ID 不能为空'
  ])
})

test('normalizes the Douyin account form and builds the create request', () => {
  const form = normalizeDouyinAccountForm({
    accountName: ' 抖店华东店 ',
    appKey: ' app-key ',
    appSecret: ' app-secret ',
    shopId: ' shop-1001 ',
    maxDailyQuota: '800'
  })

  assert.deepEqual(buildDouyinAccountCreateRequest(form), {
    channel: 'douyin',
    account_name: '抖店华东店',
    adapter_type: 'douyin_commerce',
    max_daily_quota: 800,
    config: {
      appKey: 'app-key',
      appSecret: 'app-secret',
      shopId: 'shop-1001'
    }
  })
})

test('builds the official callback URL from the server callback path', () => {
  assert.equal(buildDouyinCallbackUrl({
    id: 42,
    callbackPath: '/api/channel/douyin/webhook?account_id=42'
  }, 'https://service.example.com/'), 'https://service.example.com/api/channel/douyin/webhook?account_id=42')
})

test('exposes Douyin business-event capabilities without chat capabilities', () => {
  assert.deepEqual(getChannelCapabilities('douyin'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '抖店官方目前未开放飞鸽客服收发消息 API，本系统只接订单/售后/商品事件'
  })
})
