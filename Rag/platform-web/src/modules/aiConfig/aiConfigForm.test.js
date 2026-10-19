import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  AI_CONFIG_FIELDS,
  normalizeAiConfig,
  normalizeFieldValue,
  validateAiConfig
} from './aiConfigForm.js'

test('schema exposes approved review and reply keys but no automatic no-reply control', () => {
  const keys = AI_CONFIG_FIELDS.map(field => field.key)
  assert.equal(keys.some(key => key.startsWith('message_review_')), false)
  assert.ok(keys.includes('ai_queue_concurrency'))
  assert.ok(keys.includes('ai_self_reply_model'))
  assert.equal(keys.includes('automatic_no_reply'), false)
})

test('normalizes server wrappers and numeric input types', () => {
  assert.deepEqual(normalizeAiConfig({
    ai_self_pool_enabled: { value: true },
    ai_queue_concurrency: { value: 5 }
  }), {
    ai_self_pool_enabled: true,
    ai_queue_concurrency: 5
  })
  assert.equal(normalizeFieldValue({ type: 'number' }, '12'), 12)
  assert.equal(normalizeFieldValue({ type: 'boolean' }, false), false)
})

test('returns field-level errors for unsafe review boundaries', () => {
  const errors = validateAiConfig({
    ai_queue_concurrency: 21,
    llm_context_message_count: 101,
    ai_timeout_ms: 100
  })
  assert.ok(errors.ai_queue_concurrency)
  assert.ok(errors.llm_context_message_count)
  assert.ok(errors.ai_timeout_ms)
})

test('AI config view cannot enable automatic no-reply decisions', () => {
  const source = readFileSync(new URL('../../views/Settings/AiConfigView.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /automatic_no_reply/)
})

test('all AI model fields use searchable model selectors', () => {
  const modelFields = AI_CONFIG_FIELDS.filter(field => field.key.endsWith('_model'))
  assert.ok(modelFields.length >= 4)
  assert.ok(modelFields.every(field => field.type === 'model'))
})
