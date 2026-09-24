const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

let workerModule = {}
try {
  workerModule = require('./alibaba1688SyncWorker')
} catch {
  // RED phase: assertions below define the worker contract.
}

test('loads only active alibaba1688_commerce accounts without account names', async () => {
  assert.equal(typeof workerModule.createAlibaba1688SyncWorker, 'function')
  let query
  const worker = workerModule.createAlibaba1688SyncWorker({
    sequelize: { query: async (sql, options) => { query = { sql, options }; return [[{ id: 3, config: 'ciphertext' }]] } },
    parseAccountConfig: () => ({ appKey: 'key', appSecret: 'secret', accessToken: 'token', sellerMemberId: 'member' }),
    syncService: { syncAccount: async () => ({ success: true }) },
    logger: { info() {}, error() {} }
  })

  const result = await worker.tick()
  assert.equal(result.succeeded, 1)
  assert.match(query.sql, /status\s*=\s*'active'/i)
  assert.match(query.sql, /adapter_type\s*=\s*'alibaba1688_commerce'/i)
  assert.match(query.sql, /SELECT\s+id,\s*config/i)
  assert.doesNotMatch(query.sql, /account_name|access_token|app_secret/i)
})

test('isolates bad credentials and redacts worker logs', async () => {
  assert.equal(typeof workerModule.createAlibaba1688SyncWorker, 'function')
  const synced = []
  const logs = []
  const worker = workerModule.createAlibaba1688SyncWorker({
    sequelize: { query: async () => [[{ id: 1, config: 'broken-sensitive' }, { id: 2, config: 'valid-sensitive' }]] },
    parseAccountConfig: config => {
      if (config.startsWith('broken')) throw Object.assign(new Error(config), { code: 'CONFIG_DECRYPT_FAILED' })
      return { appKey: 'key', appSecret: 'secret-sensitive', accessToken: 'token-sensitive', sellerMemberId: 'member' }
    },
    validateAccountConfig: config => config,
    syncService: { syncAccount: async account => { synced.push(account.id); return { success: true } } },
    logger: { info() {}, error(event, details) { logs.push({ event, details }) } }
  })

  const result = await worker.tick()
  assert.deepEqual(synced, [2])
  assert.deepEqual({ succeeded: result.succeeded, failed: result.failed }, { succeeded: 1, failed: 1 })
  const serialized = JSON.stringify(logs)
  for (const secret of ['broken-sensitive', 'valid-sensitive', 'secret-sensitive', 'token-sensitive']) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('prevents overlapping ticks and uses an unref 60-second timer', async () => {
  assert.equal(typeof workerModule.createAlibaba1688SyncWorker, 'function')
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const intervals = []
  const cleared = []
  const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1 } }
  const worker = workerModule.createAlibaba1688SyncWorker({
    sequelize: { query: async () => [[{ id: 2, config: 'ciphertext' }]] },
    parseAccountConfig: () => ({ appKey: 'key', appSecret: 'secret', accessToken: 'token', sellerMemberId: 'member' }),
    validateAccountConfig: config => config,
    syncService: { syncAccount: async () => blocked },
    logger: { info() {}, error() {} },
    setIntervalFn(callback, milliseconds) { intervals.push({ callback, milliseconds }); return timer },
    clearIntervalFn(value) { cleared.push(value) }
  })

  const first = worker.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await worker.tick(), { skipped: true, reason: 'already_running' })
  release({ success: true })
  await first

  assert.equal(worker.start(), worker)
  assert.equal(worker.start(), worker)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].milliseconds, 60_000)
  assert.equal(timer.unrefCalls, 1)
  worker.stop()
  assert.deepEqual(cleared, [timer])
})

test('application starts 1688 sync only after the database promise resolves', () => {
  const source = readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
  assert.match(source, /connectDB\(\)\.then\([\s\S]*initAlibaba1688SyncWorker\(\{\s*sequelize\s*\}\)/)
})
