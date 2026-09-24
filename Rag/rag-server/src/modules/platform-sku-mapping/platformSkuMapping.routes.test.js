'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlatformSkuMappingRouter } = require('./platformSkuMapping.routes')

test('platform SKU mapping router exposes authenticated read/write endpoints', () => {
  const source = require('node:fs').readFileSync(require.resolve('./platformSkuMapping.routes'), 'utf8')
  assert.match(source, /router\.use\(authenticate/)
  assert.match(source, /router\.get\('\/'/)
  assert.match(source, /router\.post\('\/'/)
  assert.match(source, /router\.patch\('\/:id\/status'/)
  assert.equal(typeof createPlatformSkuMappingRouter, 'function')
})
