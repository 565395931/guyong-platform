const test = require('node:test')
const assert = require('node:assert/strict')
const { createLeaseService, LEASE_DURATION_MS, HEARTBEAT_INTERVAL_MS } = require('./leaseService')

function createMemoryRepository() {
  const state = {
    bindings: new Map([[7, { channelAccountId: 7, enabled: true, preferredNodeId: null }]]),
    leases: new Map(),
    audits: []
  }
  let queue = Promise.resolve()
  return {
    state,
    withLeaseLock(accountId, callback) {
      const run = queue.then(() => callback({
        account: { id: accountId, channel: 'taobao' },
        binding: state.bindings.get(accountId),
        lease: state.leases.get(accountId) || null,
        saveLease: async lease => state.leases.set(accountId, { ...lease }),
        writeAudit: async audit => state.audits.push(audit)
      }))
      queue = run.catch(() => {})
      return run
    }
  }
}

test('lease constants enforce 15-second heartbeat and 45-second expiry', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 15_000)
  assert.equal(LEASE_DURATION_MS, 45_000)
})

test('one account has one active lease and explicit takeover revokes the old token', async () => {
  const repository = createMemoryRepository()
  let currentTime = new Date('2026-07-31T10:00:00.000Z')
  let tokenSeed = 0
  const service = createLeaseService({
    repository,
    now: () => new Date(currentTime),
    randomBytes: () => Buffer.alloc(32, ++tokenSeed)
  })

  const first = await service.acquire({ accountId: 7, nodeId: 101 })
  assert.equal(first.generation, 1)
  assert.equal(first.expiresAt.getTime() - currentTime.getTime(), LEASE_DURATION_MS)

  await assert.rejects(
    () => service.acquire({ accountId: 7, nodeId: 202 }),
    error => error.code === 'ACCOUNT_LEASE_CONFLICT'
  )

  const takeover = await service.takeover({
    accountId: 7,
    nodeId: 202,
    actor: { id: 9, role: 'supervisor' },
    reason: '主电脑计划维护，切换到备用节点'
  })
  assert.equal(takeover.generation, 2)
  assert.equal(repository.state.audits.at(-1).action, 'lease.takeover')

  await assert.rejects(
    () => service.renew({ accountId: 7, nodeId: 101, leaseToken: first.leaseToken }),
    error => error.code === 'LEASE_REVOKED'
  )
})

test('concurrent acquisition has exactly one winner', async () => {
  const repository = createMemoryRepository()
  const service = createLeaseService({ repository })

  const results = await Promise.allSettled([
    service.acquire({ accountId: 7, nodeId: 101 }),
    service.acquire({ accountId: 7, nodeId: 202 })
  ])

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.reason?.code === 'ACCOUNT_LEASE_CONFLICT').length, 1)
})

test('renew extends the current generation without exposing the stored token hash', async () => {
  const repository = createMemoryRepository()
  let currentTime = new Date('2026-07-31T10:00:00.000Z')
  const service = createLeaseService({ repository, now: () => new Date(currentTime) })
  const lease = await service.acquire({ accountId: 7, nodeId: 101 })

  currentTime = new Date('2026-07-31T10:00:15.000Z')
  const renewed = await service.renew({
    accountId: 7,
    nodeId: 101,
    leaseToken: lease.leaseToken,
    generation: lease.generation
  })

  assert.equal(renewed.generation, 1)
  assert.equal(renewed.expiresAt.toISOString(), '2026-07-31T10:01:00.000Z')
  assert.equal('leaseTokenHash' in renewed, false)
})
