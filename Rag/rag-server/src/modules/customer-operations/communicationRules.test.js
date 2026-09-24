const test = require('node:test')
const assert = require('node:assert/strict')

const {
  stageForCommunicationIndex,
  localDateKey,
  buildVisibilityPredicate
} = require('./communicationRules')

test('maps daily communication index to first, second, third and nth labels', () => {
  assert.deepEqual([1, 2, 3, 4].map(stageForCommunicationIndex), [
    { code: 'first', label: '首次沟通' },
    { code: 'second', label: '二次沟通' },
    { code: 'third', label: '三次沟通' },
    { code: 'nth', label: '第4次沟通' }
  ])
})

test('uses the configured timezone date for the communication day', () => {
  assert.equal(localDateKey('2026-08-03T15:30:00.000Z', 'Asia/Shanghai'), '2026-08-03')
})

test('ordinary users are scoped to owned conversations while supervisors see all', () => {
  assert.match(buildVisibilityPredicate({ role: 'user', id: 7 }).sql, /claimed_by = :viewerId/)
  assert.equal(buildVisibilityPredicate({ role: 'supervisor', id: 7 }).sql, '1=1')
})
