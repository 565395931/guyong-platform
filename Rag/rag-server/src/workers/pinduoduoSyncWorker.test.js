const test = require('node:test')
const assert = require('node:assert/strict')

let workerModule = {}
try {
  workerModule = require('./pinduoduoSyncWorker')
} catch {
  // RED phase: assertions below describe the module contract.
}

test('loads only active pinduoduo_commerce accounts without account names', async () => {
  assert.equal(typeof workerModule.createPinduoduoSyncWorker, 'function')
  let query
  const worker = workerModule.createPinduoduoSyncWorker({
    sequelize: {
      query: async (sql, options) => {
        query = { sql, options }
        return [[{ id: 1, config: 'encrypted' }]]
      }
    },
    parseAccountConfig: () => ({ clientId: 'id', clientSecret: 'secret', accessToken: 'token', mallId: 'mall' }),
    syncService: { syncAccount: async () => ({ success: true }) },
    logger: { info() {}, error() {} }
  })

  const result = await worker.tick()

  assert.equal(result.accounts, 1)
  assert.match(query.sql, /WHERE\s+status\s*=\s*'active'/i)
  assert.match(query.sql, /adapter_type\s*=\s*'pinduoduo_commerce'/i)
  assert.match(query.sql, /SELECT\s+id,\s*config/i)
  assert.doesNotMatch(query.sql, /account_name|token|secret/i)
})

test('isolates a config decryption failure and continues other accounts', async () => {
  assert.equal(typeof workerModule.createPinduoduoSyncWorker, 'function')
  const synced = []
  const errors = []
  const worker = workerModule.createPinduoduoSyncWorker({
    sequelize: {
      query: async () => [[
        { id: 1, config: 'broken-ciphertext-sensitive' },
        { id: 2, config: 'valid-ciphertext-sensitive' }
      ]]
    },
    parseAccountConfig: (config) => {
      if (config.startsWith('broken')) {
        throw Object.assign(new Error(`could not decrypt ${config}`), { code: 'CONFIG_DECRYPT_FAILED' })
      }
      return { clientId: 'id', clientSecret: 'secret-sensitive', accessToken: 'token-sensitive', mallId: 'mall' }
    },
    syncService: {
      syncAccount: async account => {
        synced.push(account.id)
        return { success: true }
      }
    },
    logger: { info() {}, error(event, details) { errors.push({ event, details }) } }
  })

  const result = await worker.tick()

  assert.deepEqual(synced, [2])
  assert.equal(result.failed, 1)
  assert.equal(result.succeeded, 1)
  const serialized = JSON.stringify(errors)
  for (const secret of [
    'broken-ciphertext-sensitive', 'valid-ciphertext-sensitive',
    'secret-sensitive', 'token-sensitive'
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('does not overlap ticks while an earlier tick is still running', async () => {
  assert.equal(typeof workerModule.createPinduoduoSyncWorker, 'function')
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const worker = workerModule.createPinduoduoSyncWorker({
    sequelize: { query: async () => [[{ id: 1, config: 'ciphertext' }]] },
    parseAccountConfig: () => ({ clientId: 'id', clientSecret: 'secret', accessToken: 'token', mallId: 'mall' }),
    syncService: { syncAccount: async () => blocked },
    logger: { info() {}, error() {} }
  })

  const first = worker.tick()
  await new Promise(resolve => setImmediate(resolve))
  const overlapping = await worker.tick()
  release({ success: true })
  await first

  assert.deepEqual(overlapping, { skipped: true, reason: 'already_running' })
})

test('start uses a 60 second unref timer and stop clears it', () => {
  assert.equal(typeof workerModule.createPinduoduoSyncWorker, 'function')
  const intervals = []
  const cleared = []
  const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1 } }
  const worker = workerModule.createPinduoduoSyncWorker({
    sequelize: { query: async () => [[]] },
    syncService: { syncAccount: async () => ({ success: true }) },
    parseAccountConfig: () => ({}),
    logger: { info() {}, error() {} },
    setIntervalFn(callback, milliseconds) {
      intervals.push({ callback, milliseconds })
      return timer
    },
    clearIntervalFn(value) { cleared.push(value) }
  })

  assert.equal(worker.start(), worker)
  assert.equal(worker.start(), worker, 'start must be idempotent')
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].milliseconds, 60_000)
  assert.equal(timer.unrefCalls, 1)
  worker.stop()
  assert.deepEqual(cleared, [timer])
})
