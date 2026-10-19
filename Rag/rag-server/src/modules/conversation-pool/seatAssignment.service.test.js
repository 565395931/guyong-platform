const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { orderSeats, effectiveSeatStatus, createSeatAssignmentService } = require('./seatAssignment.service')

test('low-load seats win; busy seats remain eligible and multi-seat offline is excluded', () => {
  const seats = [
    { id: 1, status: 'busy', current: 2, max: 5 },
    { id: 2, status: 'online', current: 0, max: 5 },
    { id: 3, status: 'offline', current: 0, max: 5 },
    { id: 4, status: 'busy', current: 5, max: 5 }
  ]
  assert.deepEqual(orderSeats(seats).map(s => s.id), [2, 1, 4])
  assert.equal(effectiveSeatStatus('online', 1), 'online')
  assert.equal(effectiveSeatStatus('busy', 0), 'busy')
  assert.equal(effectiveSeatStatus('offline', 4), 'offline')
})

test('equal loads prefer the agent who has waited longest', () => {
  assert.deepEqual(orderSeats([
    { id: 1, status: 'busy', current: 1, max: 5, lastAssignedAt: '2026-10-12T02:00:00Z' },
    { id: 2, status: 'busy', current: 1, max: 5, lastAssignedAt: '2026-10-12T01:00:00Z' }
  ]).map(s => s.id), [2, 1])
})

test('one batch recalculates loads and commits ownership before emitting updates', async () => {
  const seats = [1, 2, 3].map(id => ({ id, username: `agent${id}`, status: 'online', current: 0, max: 5 }))
  const claims = []
  const waiting = Array.from({ length: 7 }, (_, index) => ({ id: `c${index}`, account_id: 10 }))
  let committed = false
  const sqlCalls = []
  const sequelize = {
    async transaction(fn) { const result = await fn({ id: 'tx' }); committed = true; return result },
    async query(sql, options = {}) {
      sqlCalls.push(sql)
      if (sql.includes('SELECT id, account_id')) return [waiting]
      if (sql.includes('SELECT u.id')) {
        assert.equal(options.transaction.id, 'tx')
        assert.match(sql, /seat_account_bindings/)
        assert.match(sql, /u.role\s*=\s*'agent'/)
        return [seats.map(s => ({ ...s }))]
      }
      if (sql.includes('UPDATE conversations SET')) {
        const seat = seats.find(s => s.id === options.replacements.seatId)
        seat.reserved = (seat.reserved || 0) + 1; seat.lastAssignedAt = new Date().toISOString()
        claims.push(seat.id)
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT * FROM conversations')) return [[{ id: options.replacements.id, claimed_by: claims[claims.length - 1] }]]
      return [[]]
    }
  }
  const events = new EventEmitter()
  let pushed = 0
  events.on('conversationUpdate', () => { assert.equal(committed, true); pushed += 1 })
  const service = createSeatAssignmentService({ sequelize, eventEmitter: events,
    connectedSeatIds: () => [1, 2, 3], removePendingJobs: async () => {}, poolService: { clearPoolStatsCache() {} } })
  const first = service.kick()
  const concurrent = service.kick()
  assert.equal(first, concurrent)
  assert.equal(await first, 7)
  assert.deepEqual(seats.map(s => s.reserved).sort(), [2, 2, 3])
  assert.equal(pushed, 7)
  assert.ok(sqlCalls.some(sql => sql.includes('workspace_dispatch_lock') && sql.includes('FOR UPDATE')))
})

test('no connected agent leaves pending conversations untouched', async () => {
  const sqlCalls = []
  const sequelize = { transaction: fn => fn({}), query: async sql => { sqlCalls.push(sql); return [[]] } }
  const service = createSeatAssignmentService({ sequelize, connectedSeatIds: () => [], poolService: {} })
  assert.equal(await service.kick(), 0)
  assert.equal(sqlCalls.some(sql => sql.includes('UPDATE conversations')), false)
})

test('the sole configured seat remains eligible while offline or disconnected',()=>{
 const seat={id:1,status:'offline',current:20}
 assert.deepEqual(orderSeats([seat],[]),[seat])
 assert.deepEqual(orderSeats([seat,{id:2,status:'offline',current:0}],[]),[])
})
