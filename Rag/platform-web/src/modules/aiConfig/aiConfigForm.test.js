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
  assert.ok(keys.includes('message_review_enabled'))
  assert.ok(keys.includes('message_review_allow_threshold'))
  assert.ok(keys.includes('ai_self_reply_model'))
  assert.equal(keys.includes('automatic_no_reply'), false)
})

test('normalizes server wrappers and numeric input types', () => {
  assert.deepEqual(normalizeAiConfig({
    message_review_enabled: { value: true },
    message_review_allow_threshold: { value: 0.85 }
  }), {
    message_review_enabled: true,
    message_review_allow_threshold: 0.85
  })
  assert.equal(normalizeFieldValue({ type: 'number' }, '12'), 12)
  assert.equal(normalizeFieldValue({ type: 'boolean' }, false), false)
})

test('returns field-level errors for unsafe review boundaries', () => {
  const errors = validateAiConfig({
    message_review_allow_threshold: 1.2,
    message_review_context_count: 50,
    message_review_timeout_ms: 100
  })
  assert.ok(errors.message_review_allow_threshold)
  assert.ok(errors.message_review_context_count)
  assert.ok(errors.message_review_timeout_ms)
})

test('AI config view renders only the whitelist and states hard safety boundaries', () => {
  const source = readFileSync(new URL('../../views/Settings/AiConfigView.vue', import.meta.url), 'utf8')
  assert.match(source, /AI_CONFIG_FIELDS/)
  assert.match(source, /任何不回复决定必须由人工确认/)
  assert.match(source, /模型失败时进入人工审核/)
  assert.doesNotMatch(source, /automatic_no_reply/)
})

test('all AI model fields use searchable model selectors', () => {
  const modelFields = AI_CONFIG_FIELDS.filter(field => field.key.endsWith('_model'))
  assert.ok(modelFields.length >= 5)
  assert.ok(modelFields.every(field => field.type === 'model'))
})
