const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerOperationsEventHooks } = require('./customerOperations.events')

test('message hooks record customer and agent messages but ignore AI replies', async () => {
  const calls = []
  const hooks = createCustomerOperationsEventHooks({
    service: {
      recordMessage: async message => calls.push(message)
    },
    logger: { error() {} }
  })

  await hooks.recordMessage({ direction: 'inbound', senderType: 'customer' })
  await hooks.recordMessage({ direction: 'outbound', senderType: 'agent' })
  await hooks.recordMessage({ direction: 'outbound', senderType: 'ai' })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].senderType, 'customer')
  assert.equal(calls[1].senderType, 'agent')
})

test('order hooks only process won and cancelled status transitions', async () => {
  const calls = []
  const hooks = createCustomerOperationsEventHooks({
    service: {
      applyOrderStatus: async order => calls.push(order)
    },
    logger: { error() {} }
  })

  await hooks.recordOrderStatus({ orderId: 'o1', status: 'draft' })
  await hooks.recordOrderStatus({ orderId: 'o1', status: 'paid' })
  await hooks.recordOrderStatus({ orderId: 'o1', status: 'cancelled' })

  assert.deepEqual(calls.map(item => item.status), ['paid', 'cancelled'])
})

test('eligible hooks enqueue replayable idempotent operation events', async () => {
  const events = []
  const hooks = createCustomerOperationsEventHooks({
    service: { recordMessage: async () => {}, applyOrderStatus: async () => {} },
    eventsRepository: { enqueue: async event => events.push(event) },
    logger: { error() {} }
  })

  await hooks.recordMessage({ direction: 'inbound', senderType: 'customer', messageId: 'm-1', conversationId: 'c-1' })
  await hooks.recordOrderStatus({ orderId: 'o-1', status: 'paid', customerId: 'customer-1' })

  assert.deepEqual(events.map(event => event.eventKey), ['message:m-1:inbound', 'order:o-1:paid'])
  assert.equal(events[1].payload.customerId, 'customer-1')
})
