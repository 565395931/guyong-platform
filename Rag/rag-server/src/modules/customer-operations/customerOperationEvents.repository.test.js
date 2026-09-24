const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerOperationEventsRepository } = require('./customerOperationEvents.repository')

function createFakeDb() {
  const calls = []
  return {
    calls,
    async query(sql, options = {}) {
      calls.push({ sql, options })
      if (/SELECT id FROM customer_operation_events/.test(sql)) return [[{ id: 'event-1' }], {}]
      return [[], {}]
    }
  }
}

test('durable customer operation events are idempotent and claimed with a lease', async () => {
  const db = createFakeDb()
  const repository = createCustomerOperationEventsRepository({ sequelize: db })

  await repository.enqueue({
    id: 'event-1', eventKey: 'message:1:recorded', eventType: 'message.recorded', payload: { messageId: '1' }
  })
  const ids = await repository.claimBatch({
    workerId: 'worker-a', limit: 500, leaseUntil: '2026-08-05 09:00:00'
  })
  await repository.complete('event-1')
  await repository.retry('event-1', 'provider_timeout', '2026-08-04 09:05:00')

  assert.deepEqual(ids, ['event-1'])
  assert.match(db.calls[0].sql, /ON DUPLICATE KEY UPDATE/i)
  assert.match(db.calls[0].sql, /event_key = event_key/i)
  assert.match(db.calls[1].sql, /FOR UPDATE SKIP LOCKED/i)
  assert.equal(db.calls[1].options.replacements.limit, 100)
  assert.match(db.calls[2].sql, /status='processing'/i)
  assert.match(db.calls[3].sql, /status='completed'/i)
  assert.match(db.calls[4].sql, /status='retry'/i)
})
