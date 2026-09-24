const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { createCustomerOperationsRepository } = require('./customerOperations.repository')
const databaseSource = readFileSync(__dirname + '/../../config/database.js', 'utf8')

test('customer migrations add stable links, evidence and versioned audit structures', () => {
  for (const table of [
    'customer_communication_events', 'customer_operation_events', 'customer_tags',
    'customer_profile_corrections', 'customer_audit_logs', 'customer_daily_report_revisions'
  ]) {
    assert.match(databaseSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  assert.match(databaseSource, /ALTER TABLE orders ADD COLUMN customer_id/)
  assert.match(databaseSource, /ALTER TABLE customers ADD COLUMN version/)
  assert.match(databaseSource, /normalized_account_key/)
  assert.match(databaseSource, /uk_customer_identity_normalized/)
})

function createFakeDb(results = []) {
  const calls = []
  return {
    calls,
    async query(sql, options) {
      calls.push({ sql, options })
      return results.shift() || [[], {}]
    }
  }
}

test('identity lookup is keyed by channel, account and external user id', async () => {
  const db = createFakeDb([[[{ customer_id: 'customer-1' }], {}]])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  const result = await repository.findOrCreateCustomerIdentity({
    channel: 'whatsapp',
    accountId: 2,
    externalUserId: 'u-1',
    phone: '13800000000',
    displayName: '客户'
  })

  assert.equal(result.customerId, 'customer-1')
  assert.match(db.calls[0].sql, /channel = :channel/)
  assert.match(db.calls[0].sql, /normalized_account_key = :normalizedAccountKey/)
  assert.match(db.calls[0].sql, /external_user_id = :externalUserId/)
})

test('communication day upsert increments messages without creating a second row', async () => {
  const db = createFakeDb([[[{ id: 'day-1' }], {}]])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  await repository.upsertCommunicationDay({
    customerId: 'customer-1',
    communicationDate: '2026-08-03',
    messageCountDelta: 1,
    firstMessageAt: '2026-08-03 09:00:00',
    lastMessageAt: '2026-08-03 09:00:00',
    ownerId: 7,
    conversationId: 'conversation-1'
  })

  assert.match(db.calls[0].sql, /ON DUPLICATE KEY UPDATE/i)
  assert.match(db.calls[0].sql, /message_count = message_count \+ VALUES\(message_count\)/i)
})

test('won follow-up insert is idempotent by order and type', async () => {
  const db = createFakeDb([[[{ id: 'followup-1' }], {}]])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  await repository.createWonFollowupIfMissing({
    customerId: 'customer-1',
    orderId: 'order-1',
    conversationId: 'conversation-1',
    type: 'won_first',
    assignedTo: 7,
    dueAt: '2026-08-13 09:00:00',
    source: 'order_status'
  })

  assert.match(db.calls[0].sql, /ON DUPLICATE KEY UPDATE/i)
  assert.match(db.calls[0].sql, /order_id, type/i)
})

test('marking a customer won updates the customer and cancels pending order follow-ups', async () => {
  const db = createFakeDb([[{}, {}], [{}, {}], [{}, {}]])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  await repository.markCustomerWon({ customerId: 'customer-1', wonAt: '2026-08-03 08:00:00' })
  await repository.cancelPendingOrderFollowups('order-1')
  await repository.markAiRecomputeNeeded('customer-1')

  assert.match(db.calls[0].sql, /UPDATE customers/i)
  assert.match(db.calls[1].sql, /UPDATE customer_followups/i)
  assert.match(db.calls[2].sql, /UPDATE customer_communication_days/i)
})

test('pending AI records can be claimed and updated with an audit-safe payload', async () => {
  const db = createFakeDb([[[{ id: 'day-1', customer_id: 'customer-1' }], {}], [{}, {}], [{}, {}]])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  const pending = await repository.listPendingCommunicationDays(10)
  await repository.updateCommunicationAi({ id: 'day-1', summary: '摘要', stageLabel: 'first' })
  await repository.updateCustomerAiProfile({ customerId: 'customer-1', profile: { signals: [] } })

  assert.equal(pending.length, 1)
  assert.match(db.calls[0].sql, /ai_pending = 1/i)
  assert.match(db.calls[1].sql, /UPDATE customer_communication_days/i)
  assert.match(db.calls[2].sql, /UPDATE customers/i)
})

test('AI context includes account identities, communication history, messages and orders', async () => {
  const db = createFakeDb([
    [[{ channel: 'whatsapp', accountId: 2, externalUserId: 'u-1' }], {}],
    [[{ communicationDate: '2026-08-03', summary: '询问价格' }], {}],
    [[{ direction: 'inbound', senderType: 'customer', text: '可以优惠吗' }], {}],
    [[{ orderNo: 'SO-1', status: 'paid', dealAmount: 300 }], {}]
  ])
  const repository = createCustomerOperationsRepository({ sequelize: db })

  const context = await repository.getCustomerAiContext('customer-1')

  assert.equal(context.accountIdentities[0].channel, 'whatsapp')
  assert.equal(context.recentMessages[0].text, '可以优惠吗')
  assert.equal(context.recentOrders[0].status, 'paid')
  assert.match(db.calls[0].sql, /customer_identities/i)
  assert.match(db.calls[1].sql, /customer_communication_days/i)
  assert.match(db.calls[2].sql, /plat_messages/i)
  assert.match(db.calls[3].sql, /orders/i)
  assert.match(db.calls[3].sql, /o\.customer_id = :customerId/)
})
