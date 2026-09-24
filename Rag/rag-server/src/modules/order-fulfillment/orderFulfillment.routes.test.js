'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOrderFulfillmentRouter } = require('./orderFulfillment.routes')

test('fulfillment router exposes reserve and ship endpoints behind authentication', () => {
  const source = require('node:fs').readFileSync(require.resolve('./orderFulfillment.routes'), 'utf8')
  assert.match(source, /router\.use\(authenticate/)
  assert.match(source, /router\.post\('\/orders\/:orderId\/reserve'/)
  assert.match(source, /router\.post\('\/orders\/:orderId\/ship'/)
  assert.equal(typeof createOrderFulfillmentRouter, 'function')
})
