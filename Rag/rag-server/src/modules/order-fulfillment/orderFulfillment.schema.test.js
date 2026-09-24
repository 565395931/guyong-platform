'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ORDER_FULFILLMENT_SCHEMA_STATEMENTS } = require('./orderFulfillment.schema')

test('fulfillment schema stores reservation, shipment, and durable writeback state', () => {
  const sql = ORDER_FULFILLMENT_SCHEMA_STATEMENTS.join('\n')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS order_fulfillments/i)
  assert.match(sql, /UNIQUE KEY uk_order_fulfillment_order \(order_id\)/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fulfillment_writeback_outbox/i)
  assert.match(sql, /UNIQUE KEY uk_fulfillment_writeback_event \(fulfillment_id, event_type\)/i)
})
