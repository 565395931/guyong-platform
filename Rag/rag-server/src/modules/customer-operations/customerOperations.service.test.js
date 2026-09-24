const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerOperationsService } = require('./customerOperations.service')

function createRecordingRepository() {
  const communicationDays = []
  const followups = []
  const wonCustomers = []
  return {
    communicationDays,
    followups,
    wonCustomers,
    async findOrCreateCustomerIdentity() {
      return { customerId: 'customer-1' }
    },
    async upsertCommunicationDay(input) {
      let row = communicationDays.find(item => item.customerId === input.customerId && item.communicationDate === input.communicationDate)
      if (!row) {
        row = { ...input, messageCount: 0 }
        communicationDays.push(row)
      }
      row.messageCount += Number(input.messageCountDelta || 1)
      return row
    },
    async resequenceCommunicationStages() {},
    async markCustomerWon(input) {
      wonCustomers.push(input)
    },
    async createWonFollowupIfMissing(input) {
      if (!followups.some(item => item.orderId === input.orderId && item.type === input.type)) followups.push(input)
      return input
    },
    async markAiRecomputeNeeded() {}
  }
}

test('thirty messages on one day create one communication day', async () => {
  const repository = createRecordingRepository()
  const service = createCustomerOperationsService({
    repository,
    now: () => '2026-08-03T08:00:00Z'
  })

  await Promise.all(Array.from({ length: 30 }, () => service.recordMessage({
    channel: 'whatsapp',
    accountId: 2,
    externalUserId: 'u1',
    direction: 'inbound',
    senderType: 'customer',
    timestamp: '2026-08-03T08:00:00Z'
  })))

  assert.equal(repository.communicationDays.length, 1)
  assert.equal(repository.communicationDays[0].messageCount, 30)
})

test('paid order creates one first follow-up and repeated order events stay idempotent', async () => {
  const repository = createRecordingRepository()
  const service = createCustomerOperationsService({
    repository,
    now: () => '2026-08-03T08:00:00Z'
  })

  await service.applyOrderStatus({
    orderId: 'order-1',
    status: 'paid',
    customer: { phone: '13800000000' },
    ownerId: 7
  })
  await service.applyOrderStatus({
    orderId: 'order-1',
    status: 'paid',
    customer: { phone: '13800000000' },
    ownerId: 7
  })

  assert.equal(repository.wonCustomers.length, 2)
  assert.equal(repository.followups.filter(item => item.type === 'won_first').length, 1)
  assert.equal(repository.followups[0].dueAt, '2026-08-13 08:00:00')
})

test('AI outbound replies do not count as a communication day', async () => {
  const repository = createRecordingRepository()
  const service = createCustomerOperationsService({ repository })

  const result = await service.recordMessage({
    channel: 'whatsapp',
    accountId: 2,
    externalUserId: 'u1',
    direction: 'outbound',
    senderType: 'ai'
  })

  assert.equal(result.ignored, true)
  assert.equal(repository.communicationDays.length, 0)
})
