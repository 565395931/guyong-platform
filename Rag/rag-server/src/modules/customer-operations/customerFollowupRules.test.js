const test = require('node:test')
const assert = require('node:assert/strict')
const { buildNextFollowup } = require('./customerFollowupRules')

test('completing a first won follow-up schedules a second one fifteen days later', () => {
  const next = buildNextFollowup({
    customerId: 'customer-1',
    orderId: 'order-1',
    conversationId: 'conversation-1',
    type: 'won_first',
    assignedTo: 7
  }, new Date('2026-08-03T08:00:00.000Z'))

  assert.deepEqual(next, {
    customerId: 'customer-1',
    orderId: 'order-1',
    conversationId: 'conversation-1',
    type: 'won_second',
    assignedTo: 7,
    dueAt: '2026-08-18 08:00:00',
    source: 'fallback',
    aiReason: '首次复联完成后的默认二次复联时间，等待 AI 根据最新沟通重新评估',
    aiSignals: []
  })
})

test('terminal or non-first tasks do not schedule another follow-up', () => {
  assert.equal(buildNextFollowup({ type: 'won_second' }), null)
  assert.equal(buildNextFollowup({ type: 'manual' }), null)
})
