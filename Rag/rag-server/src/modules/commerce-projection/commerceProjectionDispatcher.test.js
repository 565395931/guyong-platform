const test = require('node:test')
const assert = require('node:assert/strict')

const { ProjectionLedgerError } = require('@rag/commerce-projection-ledger')
const { createCommerceProjectionDispatcher } = require('./commerceProjectionDispatcher')

test('dispatches pending commands and reports terminal failures without exposing payloads', async () => {
  const calls = []
  const source = {
    listPendingRefs: async () => ['channel_event_inbox:42', 'channel_event_inbox:43'],
    load: async ref => ({ ref })
  }
  const coordinator = {
    async projectExternalOrder(value) {
      calls.push(value.ref)
      if (value.ref.endsWith(':43')) throw new ProjectionLedgerError('INVALID_INPUT', 'safe')
      return { kind: 'created' }
    }
  }
  const dispatcher = createCommerceProjectionDispatcher({ source, coordinator, batchSize: 10 })

  assert.deepEqual(await dispatcher.runOnce(), {
    listed: 2,
    succeeded: 1,
    failed: 1
  })
  assert.deepEqual(calls, ['channel_event_inbox:42', 'channel_event_inbox:43'])
})

test('rejects invalid dispatcher dependencies and bounds', () => {
  assert.throws(
    () => createCommerceProjectionDispatcher({ source: {}, coordinator: {}, batchSize: 0 }),
    TypeError
  )
})

