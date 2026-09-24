import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  followupStatusMeta,
  normalizeProfileSignals,
  profileStageSummary
} from './customerProfile.js'

test('pending follow-ups become overdue after their due time', () => {
  const meta = followupStatusMeta(
    { status: 'pending', dueAt: '2026-08-03 09:00:00' },
    new Date(2026, 7, 3, 10, 0, 0)
  )

  assert.equal(meta.code, 'overdue')
  assert.equal(meta.label, '已逾期')
  assert.equal(meta.tagType, 'danger')
})

test('completed and skipped follow-ups preserve their terminal state', () => {
  assert.equal(followupStatusMeta({ status: 'completed' }).label, '已完成')
  assert.equal(followupStatusMeta({ status: 'skipped' }).label, '已跳过')
})

test('profile signals accept structured and legacy string values', () => {
  assert.deepEqual(normalizeProfileSignals([
    { code: 'price_sensitive', label: '关注价格', evidence: '反复询问折扣' },
    '决策周期较长',
    null
  ]), [
    { code: 'price_sensitive', label: '关注价格', evidence: '反复询问折扣' },
    { code: 'signal-2', label: '决策周期较长', evidence: '' }
  ])
})

test('communication summary uses the latest communication index', () => {
  assert.deepEqual(profileStageSummary([
    { communication_index: 2, stage_label: 'second' },
    { communication_index: 3, stage_label: 'third' }
  ]), {
    count: 2,
    index: 3,
    code: 'third',
    label: '三次沟通'
  })
})
