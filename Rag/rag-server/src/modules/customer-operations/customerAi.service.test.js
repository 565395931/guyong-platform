const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerAiService, CUSTOMER_AI_SYSTEM_PROMPT } = require('./customerAi.service')

test('AI instructions use evidence-based behavioral psychology without sensitive diagnosis', () => {
  assert.match(CUSTOMER_AI_SYSTEM_PROMPT, /行为心理学/)
  assert.match(CUSTOMER_AI_SYSTEM_PROMPT, /可观察证据/)
  assert.match(CUSTOMER_AI_SYSTEM_PROMPT, /不要推断.*心理疾病/)
})

test('normalizes a valid structured AI decision', async () => {
  const service = createCustomerAiService({
    provider: async () => JSON.stringify({
      summary: '客户关注交付时间',
      signals: [{ code: 'delivery_sensitive', label: '关注交付保障', evidence: '多次询问交期' }],
      nextFollowupAt: '2026-08-13T08:00:00.000Z',
      followupType: 'won_first',
      confidence: 0.82,
      recommendedTone: '明确交付节点'
    })
  })

  const decision = await service.decide({ followupType: 'won_first' })

  assert.equal(decision.source, 'ai')
  assert.equal(decision.confidence, 0.82)
  assert.equal(decision.signals[0].code, 'delivery_sensitive')
})

test('invalid AI output falls back to a ten-day first reminder', async () => {
  const service = createCustomerAiService({
    provider: async () => ({ followupType: 'unknown', confidence: 3 }),
    now: () => '2026-08-03T08:00:00.000Z'
  })

  const decision = await service.decide({ followupType: 'won_first' })

  assert.equal(decision.source, 'fallback')
  assert.equal(decision.nextFollowupAt, '2026-08-13T08:00:00.000Z')
  assert.equal(decision.followupType, 'won_first')
})

test('provider failure uses fifteen days for a second reminder', async () => {
  const service = createCustomerAiService({
    provider: async () => { throw new Error('provider unavailable') },
    now: () => '2026-08-03T08:00:00.000Z'
  })

  const decision = await service.decide({ followupType: 'won_second' })

  assert.equal(decision.source, 'fallback')
  assert.equal(decision.nextFollowupAt, '2026-08-18T08:00:00.000Z')
  assert.match(decision.errorMessage, /provider unavailable/)
})

test('human-locked due time is preserved when AI suggests a new time', async () => {
  const service = createCustomerAiService({
    provider: async () => ({
      summary: 'AI suggestion',
      signals: [],
      nextFollowupAt: '2026-09-01T08:00:00.000Z',
      followupType: 'won_first',
      confidence: 0.9,
      recommendedTone: 'direct'
    })
  })

  const decision = await service.decide({ followupType: 'won_first' }, {
    overriddenBy: 7,
    dueAt: '2026-08-20T08:00:00.000Z'
  })

  assert.equal(decision.nextFollowupAt, '2026-08-20T08:00:00.000Z')
  assert.equal(decision.humanLocked, true)
})
