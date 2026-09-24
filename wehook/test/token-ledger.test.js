const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const { TokenLedger } = require('../src/saas/tokenLedger')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-ledger-'))
  const store = new FileSaasStore(path.join(directory, 'store.json'))
  return { directory, store, ledger: new TokenLedger(store, () => '2026-09-24T00:00:00.000Z') }
}

test('credit ledger grants, reserves, settles and preserves idempotency', async t => {
  const { directory, store, ledger } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  await store.transaction(data => data.tenants.push({ id: 'tenant-a', name: 'A' }))
  const grant = await ledger.grant({ tenantId: 'tenant-a', credits: 1000, actorId: 'operator', reason: 'test', idempotencyKey: 'grant-1' })
  assert.equal(grant.balance, 1000)
  const duplicateGrant = await ledger.grant({ tenantId: 'tenant-a', credits: 9999, actorId: 'operator', reason: 'duplicate', idempotencyKey: 'grant-1' })
  assert.equal(duplicateGrant.balance, 1000)
  assert.equal(duplicateGrant.duplicate, true)

  const held = await ledger.reserve({ tenantId: 'tenant-a', credits: 300, idempotencyKey: 'request-1', model: 'deepseek', deviceId: 'device-a' })
  assert.equal(held.balance, 700)
  const duplicateHold = await ledger.reserve({ tenantId: 'tenant-a', credits: 300, idempotencyKey: 'request-1', model: 'deepseek', deviceId: 'device-a' })
  assert.equal(duplicateHold.balance, 700)
  assert.equal(duplicateHold.duplicate, true)

  const settled = await ledger.settle({ tenantId: 'tenant-a', reservationId: held.reservation.id, actualCredits: 220 })
  assert.equal(settled.balance, 780)
  assert.equal(settled.reservation.status, 'settled')
  const duplicateSettle = await ledger.settle({ tenantId: 'tenant-a', reservationId: held.reservation.id, actualCredits: 220 })
  assert.equal(duplicateSettle.balance, 780)
  assert.equal(duplicateSettle.duplicate, true)
})

test('credit ledger rejects overdraw and refunds cancelled reservations', async t => {
  const { directory, store, ledger } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  await store.transaction(data => data.tenants.push({ id: 'tenant-a', name: 'A' }))
  await ledger.grant({ tenantId: 'tenant-a', credits: 100, actorId: 'operator', idempotencyKey: 'grant-1' })
  await assert.rejects(() => ledger.reserve({ tenantId: 'tenant-a', credits: 101, idempotencyKey: 'too-much', deviceId: 'd' }), error => error.code === 'insufficient_credits')
  const held = await ledger.reserve({ tenantId: 'tenant-a', credits: 70, idempotencyKey: 'ok', deviceId: 'd' })
  const cancelled = await ledger.cancel({ tenantId: 'tenant-a', reservationId: held.reservation.id })
  assert.equal(cancelled.balance, 100)
  assert.equal(cancelled.reservation.status, 'cancelled')
})
