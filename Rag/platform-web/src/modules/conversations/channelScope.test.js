import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveChannelScope } from './channelScope.js'

test('locks WeCom conversation routes to the official channel code', () => {
  assert.deepEqual(resolveChannelScope('wecom_kf'), {
    fixedChannel: 'wecom_kf',
    selectedChannels: ['wecom_kf'],
    label: '微信客服',
    filterLocked: true
  })
})

test('keeps the unified workbench unrestricted', () => {
  assert.deepEqual(resolveChannelScope(''), {
    fixedChannel: '',
    selectedChannels: [],
    label: '全部渠道',
    filterLocked: false
  })
})

test('rejects unknown route channel codes', () => {
  assert.deepEqual(resolveChannelScope('unknown'), {
    fixedChannel: '',
    selectedChannels: [],
    label: '全部渠道',
    filterLocked: false
  })
})

test('explicit prop overrides query and route metadata', () => {
  assert.equal(resolveChannelScope({
    prop: 'taobao',
    query: 'whatsapp',
    meta: 'wecom_kf'
  }).fixedChannel, 'taobao')
})

test('query channel overrides route metadata and supports every commerce channel', () => {
  assert.equal(resolveChannelScope({ query: 'whatsapp', meta: 'wecom_kf' }).fixedChannel, 'whatsapp')
  assert.deepEqual(resolveChannelScope({ meta: 'wechat' }), {
    fixedChannel: 'wechat',
    selectedChannels: ['wechat'],
    label: '微信小程序',
    filterLocked: true
  })
  assert.equal(resolveChannelScope({ meta: 'douyin' }).fixedChannel, 'douyin')
  assert.equal(resolveChannelScope({ meta: 'pinduoduo' }).fixedChannel, 'pinduoduo')
  assert.equal(resolveChannelScope({ meta: 'taobao' }).fixedChannel, 'taobao')
  assert.equal(resolveChannelScope({ meta: 'alibaba1688' }).fixedChannel, 'alibaba1688')
})

test('empty or unknown scopes remain unrestricted', () => {
  assert.equal(resolveChannelScope({}).fixedChannel, '')
  assert.equal(resolveChannelScope({ prop: 'unknown' }).fixedChannel, '')
})
