const test = require('node:test')
const assert = require('node:assert/strict')
const { serviceDay, agentVisibility, minePredicate, nextPresence } = require('./workspacePolicy')

test('daily customer count resets at China 19:00, including month and year boundaries', () => {
  assert.equal(serviceDay('2026-10-12T10:59:59Z'), '2026-10-11')
  assert.equal(serviceDay('2026-10-12T11:00:00Z'), '2026-10-12')
  assert.equal(serviceDay('2027-01-01T10:59:59Z'), '2026-12-31')
  assert.equal(serviceDay('2027-01-01T11:00:00Z'), '2027-01-01')
})
test('AI observation, assignment and permanent My history always require an account binding', () => {
  const sql = agentVisibility('cv', 'actor')
  assert.match(sql, /cv.account_id IN/)
  assert.match(sql, /seat_id = :actor AND status = 'active'/)
  assert.match(sql, /cv.pool_type = 'ai_self'/)
  assert.match(sql, /cv.agent_id = :actor/)
  assert.match(sql, /conversation_seat_history/)
  assert.match(minePredicate(), /conversation_seat_history/)
})
test('manual presence cycles independently of the customer count', () => {
  assert.equal(nextPresence('online'), 'busy')
  assert.equal(nextPresence('busy'), 'offline')
  assert.equal(nextPresence('offline'), 'online')
})
