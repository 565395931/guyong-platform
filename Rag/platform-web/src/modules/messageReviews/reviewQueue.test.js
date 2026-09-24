import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  canTakeOverReview,
  isReviewConflict,
  normalizeReview,
  sortReviewItems,
  validateDismiss,
  validateReply
} from './reviewQueue.js'

test('only privileged users can take over work claimed by someone else', () => {
  const item = { status: 'claimed', claimedBy: 12 }
  assert.equal(canTakeOverReview(item, { id: 7, role: 'admin' }), true)
  assert.equal(canTakeOverReview(item, { id: 7, role: 'supervisor' }), true)
  assert.equal(canTakeOverReview(item, { id: 7, role: 'agent' }), false)
  assert.equal(canTakeOverReview(item, { id: 12, role: 'admin' }), false)
})

test('sorts high risk first and oldest first within a risk level', () => {
  const items = [
    { id: 'medium', riskLevel: 'medium', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'high-new', riskLevel: 'high', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'high-old', riskLevel: 'high', createdAt: '2025-12-31T00:00:00Z' }
  ]
  assert.deepEqual(sortReviewItems(items).map(item => item.id), ['high-old', 'high-new', 'medium'])
})

test('normalizes backend snake case without losing evidence', () => {
  const item = normalizeReview({
    id: 'r1', conversation_id: 'c1', risk_level: 'high', reason_code: 'prompt_injection',
    reason_text: 'Matched rule', rule_hits: ['prompt_injection'], message_ids: ['m1'], assigned_to: 7
  })
  assert.equal(item.conversationId, 'c1')
  assert.equal(item.riskLevel, 'high')
  assert.deepEqual(item.ruleHits, ['prompt_injection'])
  assert.equal(item.assignedTo, 7)
})

test('validates human terminal decisions', () => {
  assert.equal(validateReply(' ').length, 1)
  assert.equal(validateReply('A clear answer').length, 0)
  assert.equal(validateDismiss({ reasonCode: '' }).length, 1)
  assert.equal(validateDismiss({ reasonCode: 'spam' }).length, 0)
})

test('detects optimistic concurrency conflicts', () => {
  assert.equal(isReviewConflict({ response: { status: 409 } }), true)
  assert.equal(isReviewConflict({ response: { status: 500 } }), false)
})

test('review workbench is composed from three focused panels with human no-reply confirmation', () => {
  const viewSource = readFileSync(new URL('../../views/MessageReviews/MessageReviewView.vue', import.meta.url), 'utf8')
  const decisionSource = readFileSync(new URL('../../views/MessageReviews/components/ReviewDecisionPanel.vue', import.meta.url), 'utf8')
  assert.match(viewSource, /ReviewQueuePanel/)
  assert.match(viewSource, /ReviewConversationPanel/)
  assert.match(viewSource, /ReviewDecisionPanel/)
  assert.match(decisionSource, /不回复原因/)
  assert.doesNotMatch(decisionSource, /自动不回复/)
})
