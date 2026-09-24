const test = require('node:test')
const assert = require('node:assert/strict')

const { getChannelCapabilities } = require('./channelCapabilities')

test('Douyin commerce exposes business events without pretending Feige chat APIs exist', () => {
  assert.deepEqual(getChannelCapabilities('douyin'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '抖店开放平台暂未提供飞鸽客服消息收发 API'
  })
})

test('Pinduoduo commerce exposes order and after-sales sync without pretending buyer chat APIs exist', () => {
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

test('unknown channels fail closed with no capabilities', () => {
  assert.deepEqual(getChannelCapabilities('not-a-channel'), {
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: false,
    afterSalesEvents: false,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '渠道能力尚未定义'
  })
})
