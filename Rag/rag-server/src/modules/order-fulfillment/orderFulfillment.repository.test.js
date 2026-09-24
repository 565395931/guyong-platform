'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOrderFulfillmentRepository } = require('./orderFulfillment.repository')

test('reads the persisted shipment writeback status with a bound fulfillment identity', async () => {
  for (const status of ['pending', 'processing', 'failed', 'succeeded', null]) {
    const repository = createOrderFulfillmentRepository({
      async query(sql, options) {
        assert.match(sql, /WHERE fulfillment_id=:fulfillmentId AND event_type='shipment\.created'/)
        assert.doesNotMatch(sql, /status\s+IN/i)
        assert.deepEqual(options.replacements, { fulfillmentId: "F-'quoted" })
        assert.ok(!sql.includes("F-'quoted"))
        return [status ? [{ status }] : []]
      }
    })
    assert.equal(await repository.getWritebackStatus("F-'quoted"), status)
  }
})
