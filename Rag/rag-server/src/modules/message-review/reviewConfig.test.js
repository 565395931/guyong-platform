const test = require('node:test')
const assert = require('node:assert/strict')

const {
  REVIEW_DEFAULTS,
  getPublicAiConfigKeys,
  validatePublicAiConfig,
  validateReviewConfig
} = require('./reviewConfig')

test('validates review booleans, models, thresholds and bounded integers', () => {
  assert.equal(validateReviewConfig('message_review_enabled', true), true)
  assert.equal(validateReviewConfig('message_review_model', 'deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(validateReviewConfig('message_review_allow_threshold', 0.8), 0.8)
  assert.equal(validateReviewConfig('message_review_context_count', 20), 20)
  assert.equal(validateReviewConfig('message_review_timeout_ms', 12000), 12000)
})

test('rejects unknown review keys and out-of-range values', () => {
  assert.throws(() => validateReviewConfig('unknown_key', true), /not editable/)
  assert.throws(() => validateReviewConfig('message_review_allow_threshold', 1.1), /between 0 and 1/)
  assert.throws(() => validateReviewConfig('message_review_context_count', 50), /between 0 and 20/)
  assert.throws(() => validateReviewConfig('message_review_timeout_ms', 100), /between 1000 and 60000/)
  assert.throws(() => validateReviewConfig('message_review_enabled', 'true'), /boolean/)
})

test('public AI config whitelist includes review and existing operational keys only', () => {
  const keys = getPublicAiConfigKeys()
  assert.ok(keys.includes('message_review_enabled'))
  assert.ok(keys.includes('ai_self_reply_model'))
  assert.ok(keys.includes('ai_timeout_ms'))
  assert.equal(keys.includes('automatic_no_reply'), false)
  assert.equal(validatePublicAiConfig('ai_queue_concurrency', 4), 4)
  assert.throws(() => validatePublicAiConfig('database_password', 'secret'), /not editable/)
})

test('review defaults are conservative', () => {
  assert.equal(REVIEW_DEFAULTS.message_review_enabled, true)
  assert.equal(REVIEW_DEFAULTS.message_review_allow_threshold, 0.85)
  assert.equal(REVIEW_DEFAULTS.message_review_context_count, 6)
})
