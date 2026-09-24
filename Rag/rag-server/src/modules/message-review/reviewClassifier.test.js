const test = require('node:test')
const assert = require('node:assert/strict')

const { createReviewClassifier } = require('./reviewClassifier')

const validResult = {
  riskLevel: 'low',
  confidence: 0.94,
  recommendedAction: 'allow',
  reasonCode: 'other',
  reason: 'Routine delivery question'
}

test('classifies with bounded, allowlisted conversation context', async () => {
  let capturedRequest
  const config = {
    message_review_model: 'review-model',
    message_review_context_count: 2,
    message_review_timeout_ms: 1000
  }
  const classifier = createReviewClassifier({
    getConfig: async (key) => config[key],
    getContext: async () => [
      { role: 'customer', content: 'first', createdAt: '2026-01-01', channel: 'whatsapp', apiKey: 'secret' },
      { role: 'agent', content: 'second', createdAt: '2026-01-02', channel: 'whatsapp', token: 'hidden' },
      { role: 'customer', content: 'third', createdAt: '2026-01-03', channel: 'whatsapp' }
    ],
    invokeModel: async (request) => {
      capturedRequest = request
      return JSON.stringify(validResult)
    }
  })

  const result = await classifier.classify({
    conversationId: 'c1',
    message: { content: { text: 'When will this arrive?' }, channel: 'whatsapp', apiKey: 'message-secret' }
  })

  assert.deepEqual(result, validResult)
  assert.equal(capturedRequest.model, 'review-model')
  assert.equal(capturedRequest.context.length, 2)
  assert.equal(JSON.stringify(capturedRequest).includes('secret'), false)
  assert.equal(JSON.stringify(capturedRequest).includes('hidden'), false)
})

test('rejects malformed model output', async () => {
  const classifier = createReviewClassifier({
    getConfig: async (key) => ({
      message_review_context_count: 0,
      message_review_timeout_ms: 1000
    })[key],
    getContext: async () => [],
    invokeModel: async () => '{"recommendedAction":"allow"}'
  })

  await assert.rejects(
    classifier.classify({ conversationId: 'c1', message: { content: { text: 'hello' } } }),
    /riskLevel/
  )
})

test('rejects when model invocation exceeds configured timeout', async () => {
  const classifier = createReviewClassifier({
    getConfig: async (key) => ({
      message_review_context_count: 0,
      message_review_timeout_ms: 5
    })[key],
    getContext: async () => [],
    invokeModel: async () => new Promise(() => {})
  })

  await assert.rejects(
    classifier.classify({ conversationId: 'c1', message: { content: { text: 'hello' } } }),
    /timed out/
  )
})

test('clamps unsafe context config to the supported maximum', async () => {
  let requestedCount
  const classifier = createReviewClassifier({
    getConfig: async (key) => ({
      message_review_context_count: 999,
      message_review_timeout_ms: 1000
    })[key],
    getContext: async (_conversationId, count) => {
      requestedCount = count
      return []
    },
    invokeModel: async () => validResult
  })

  await classifier.classify({ conversationId: 'c1', message: { content: { text: 'hello' } } })
  assert.equal(requestedCount, 20)
})
