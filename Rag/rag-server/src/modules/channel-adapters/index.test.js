'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { initAdapters, getAdapterByChannel } = require('./index')

test('registers explicitly supplied certified order projection mappers by channel', () => {
  const mapper = () => null
  initAdapters({ orderProjectionMappers: { pinduoduo: mapper } })

  assert.equal(getAdapterByChannel('pinduoduo').orderProjectionMapper, mapper)
  assert.equal(getAdapterByChannel('taobao').orderProjectionMapper, null)
})

test('fails closed for malformed or unknown projection mapper configuration', () => {
  assert.throws(() => initAdapters({ orderProjectionMappers: [] }), TypeError)
  assert.throws(() => initAdapters({ orderProjectionMappers: { pinduoduo: true } }), TypeError)
  assert.throws(() => initAdapters({ orderProjectionMappers: { typo_channel: () => null } }), /unsupported/i)
})
