import test from 'node:test'
import assert from 'node:assert/strict'

import { buildXiaohongshuAccountCreateRequest } from './xiaohongshuAccountForm.js'
import { buildWechatShopAccountCreateRequest } from './wechatShopAccountForm.js'
import { buildKuaishouAccountCreateRequest } from './kuaishouAccountForm.js'
import { getChannelCapabilities } from './channelCapabilities.js'

test('builds create requests for the three new official commerce channels', () => {
  assert.equal(buildXiaohongshuAccountCreateRequest({
    accountName: ' XHS ', appKey: ' key ', appSecret: ' secret ', accessToken: ' token ', shopId: ' shop '
  }).adapter_type, 'xiaohongshu_commerce')

  assert.deepEqual(buildWechatShopAccountCreateRequest({
    accountName: ' WeChat Shop ', appId: ' wx ', appSecret: ' secret ', shopId: ' shop '
  }).config, { appId: 'wx', appSecret: 'secret', shopId: 'shop' })

  assert.equal(buildKuaishouAccountCreateRequest({
    accountName: ' KS ', appKey: ' key ', appSecret: ' secret ', accessToken: ' token ', shopId: ' shop '
  }).channel, 'kuaishou')
})

test('declares official commerce events while chat uses the desktop bridge', () => {
  for (const channel of ['xiaohongshu', 'wechat_shop', 'kuaishou']) {
    const capabilities = getChannelCapabilities(channel)
    assert.equal(capabilities.customerMessagesIn, false)
    assert.equal(capabilities.customerMessagesOut, false)
    assert.equal(capabilities.chatTransport, 'desktop_bridge')
    assert.equal(capabilities.orderEvents, true)
    assert.equal(capabilities.afterSalesEvents, true)
  }
})
