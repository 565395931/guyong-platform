const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createCommerceProjectionAdminRepository,
  normalizeProjectionJobQuery
} = require('./commerceProjectionAdminRepository')

test('lists projection jobs with bounded parameterized filters', async () => {
  const calls = []
  const repository = createCommerceProjectionAdminRepository({
    async query(sql, options) {
      calls.push({ sql, options })
      if (/COUNT\(\*\)/.test(sql)) return [[{ total: 1 }], {}]
      return [[{ id: 'job-1', status: 'terminal_failed' }], {}]
    },
    async transaction(operation) { return operation('tx') }
  })
  const filters = normalizeProjectionJobQuery({ status: 'terminal_failed', limit: '20', offset: '0' })

  assert.deepEqual(await repository.list(filters), {
    items: [{ id: 'job-1', status: 'terminal_failed' }],
    total: 1,
    limit: 20,
    offset: 0
  })
  assert.equal(calls.every(call => !call.sql.includes('terminal_failed')), true)
  assert.equal(calls[0].options.replacements.status, 'terminal_failed')
})

test('replays only terminal work and writes an actor audit in the same transaction', async () => {
  const calls = []
  const repository = createCommerceProjectionAdminRepository({
    async query(sql, options = {}) {
      calls.push({ sql, options })
      if (/FOR UPDATE/.test(sql)) return [[{ id: 'job-1', status: 'terminal_failed' }], {}]
      return [[], { affectedRows: 1 }]
    },
    async transaction(operation) { return operation('tx-1') }
  }, { createAuditId: () => 'audit-1' })

  assert.deepEqual(await repository.replay('job-1', { actorId: 9, reason: 'Credential was rotated' }), {
    id: 'job-1',
    status: 'retryable_failed'
  })
  const update = calls.find(call => /UPDATE commerce_projection_jobs/.test(call.sql))
  const audit = calls.find(call => /INSERT INTO commerce_projection_audit_logs/.test(call.sql))
  assert.equal(update.options.transaction, 'tx-1')
  assert.equal(audit.options.transaction, 'tx-1')
  assert.deepEqual(audit.options.replacements, {
    id: 'audit-1', jobId: 'job-1', actorId: 9, action: 'manual_replay',
    beforeStatus: 'terminal_failed', afterStatus: 'retryable_failed', reason: 'Credential was rotated'
  })
})

test('rejects replay of running work and invalid operator input', async () => {
  const repository = createCommerceProjectionAdminRepository({
    async query(sql) {
      if (/FOR UPDATE/.test(sql)) return [[{ id: 'job-1', status: 'processing' }], {}]
      return [[], {}]
    },
    async transaction(operation) { return operation('tx') }
  })

  await assert.rejects(repository.replay('job-1', { actorId: 9, reason: 'retry' }), error => error.status === 409)
  await assert.rejects(repository.replay('bad id!', { actorId: 9, reason: 'retry' }), error => error.status === 400)
  await assert.rejects(repository.replay('job-1', { actorId: 0, reason: '' }), error => error.status === 400)
  assert.throws(() => normalizeProjectionJobQuery({ status: 'unknown' }), error => error.status === 400)
})

