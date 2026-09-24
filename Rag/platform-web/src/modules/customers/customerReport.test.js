import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDailyReport, stageLabel } from './customerReport.js'

test('normalizes missing AI fields without losing deterministic counts', () => {
  const report = normalizeDailyReport({ first_count: '2', customer_count: '30', details: null })

  assert.equal(report.customerCount, 30)
  assert.equal(report.firstCount, 2)
  assert.deepEqual(report.details, [])
})

test('maps communication stage codes to Chinese labels', () => {
  assert.equal(stageLabel('first'), '首次沟通')
  assert.equal(stageLabel('nth', 4), '第4次沟通')
})

test('normalizes camel-case stage codes into a display label', () => {
  const report = normalizeDailyReport({
    customers: [{ id: 'c1', stageLabel: 'second', communicationIndex: 2 }]
  })

  assert.equal(report.details[0].stageCode, 'second')
  assert.equal(report.details[0].stageLabel, '二次沟通')
})
