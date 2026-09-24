const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerOperationsWorker } = require('./customerOperations.worker')

test('worker applies AI summaries to pending communication days and follow-ups', async () => {
  const calls = []
  const aiInputs = []
  const repository = {
    async markDueFollowups() { calls.push(['markDue']) },
    async listPendingCommunicationDays() { return [{ id: 'day-1', customer_id: 'customer-1', stage_label: 'first' }] },
    async updateCommunicationAi(input) { calls.push(['communication', input]) },
    async updateCustomerAiProfile(input) { calls.push(['profile', input]) },
    async listPendingFollowups() { return [{ id: 'followup-1', customer_id: 'customer-1', type: 'won_first', overriddenBy: null }] },
    async getCustomerAiContext() {
      return {
        accountIdentities: [{ channel: 'whatsapp', accountId: 2 }],
        recentCommunications: [{ summary: '询问价格' }],
        recentMessages: [{ direction: 'inbound', text: '可以优惠吗' }],
        recentOrders: [{ status: 'paid', dealAmount: 300 }]
      }
    },
    async updateFollowupAi(input) { calls.push(['followup', input]) },
    async appendAiAuditLog(input) { calls.push(['audit', input]) }
  }
  const aiService = {
    async decide(input) {
      aiInputs.push(input)
      return {
        source: 'ai',
        summary: `summary-${input.customerId}`,
        signals: [{ code: 'price_sensitive', label: '价格敏感', evidence: '询问价格' }],
        nextFollowupAt: '2026-08-13T08:00:00.000Z',
        followupType: input.followupType || 'won_first',
        confidence: 0.8,
        recommendedTone: '直接'
      }
    }
  }

  const worker = createCustomerOperationsWorker({ repository, aiService })
  await worker.runPendingWork()

  assert.equal(calls.filter(call => call[0] === 'communication').length, 1)
  assert.equal(calls.filter(call => call[0] === 'followup').length, 1)
  assert.equal(calls.filter(call => call[0] === 'audit').length, 2)
  assert.equal(calls.find(call => call[0] === 'profile')[1].profile.signals[0].code, 'price_sensitive')
  assert.equal(aiInputs[1].recentMessages[0].text, '可以优惠吗')
  assert.equal(aiInputs[1].recentOrders[0].status, 'paid')
})

test('worker continues after one AI item fails', async () => {
  const calls = []
  const repository = {
    async markDueFollowups() {},
    async listPendingCommunicationDays() { return [{ id: 'day-1', customer_id: 'customer-1' }, { id: 'day-2', customer_id: 'customer-2' }] },
    async updateCommunicationAi(input) { calls.push(input.id) },
    async updateCustomerAiProfile() {},
    async listPendingFollowups() { return [] },
    async appendAiAuditLog() {}
  }
  let callsToAi = 0
  const worker = createCustomerOperationsWorker({
    repository,
    aiService: { async decide() { callsToAi += 1; if (callsToAi === 1) throw new Error('AI down'); return { source: 'fallback', summary: 'fallback', signals: [], nextFollowupAt: null, confidence: 0, followupType: null } } },
    logger: { error() {} }
  })

  await worker.runPendingWork()

  assert.deepEqual(calls, ['day-2'])
})
