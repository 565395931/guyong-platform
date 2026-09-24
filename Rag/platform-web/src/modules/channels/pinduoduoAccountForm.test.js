import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPinduoduoAccountCreateRequest,
  normalizePinduoduoAccountForm,
  validatePinduoduoAccountForm
} from './pinduoduoAccountForm.js'
import { getChannelCapabilities } from './channelCapabilities.js'

test('requires every official Pinduoduo credential', () => {
  assert.deepEqual(validatePinduoduoAccountForm({}), [
    '账号名称不能为空',
    'Client ID 不能为空',
    'Client Secret 不能为空',
    'Access Token 不能为空',
    'Mall ID 不能为空'
  ])
})

test('normalizes the Pinduoduo account form and builds the create request', () => {
  const form = normalizePinduoduoAccountForm({
    accountName: ' 拼多多旗舰店 ',
    clientId: ' client-id ',
    clientSecret: ' client-secret ',
    accessToken: ' access-token ',
    mallId: ' 10000001 ',
    maxDailyQuota: '600'
  })

  assert.deepEqual(buildPinduoduoAccountCreateRequest(form), {
    channel: 'pinduoduo',
    account_name: '拼多多旗舰店',
    adapter_type: 'pinduoduo_commerce',
    max_daily_quota: 600,
    config: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'access-token',
      mallId: '10000001'
    }
  })
})

test('exposes only official Pinduoduo order and after-sales capabilities', () => {
  assert.deepEqual(getChannelCapabilities('pinduoduo'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '拼多多官方商家 API 当前未提供买家客服聊天收发能力，本系统只同步订单和售后事件'
  })
})
