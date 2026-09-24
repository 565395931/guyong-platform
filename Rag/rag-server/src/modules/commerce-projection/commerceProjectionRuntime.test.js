const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createCommerceProjectionRuntime,
  resolveCommerceProjectionConfig
} = require('./commerceProjectionRuntime')

function enabledEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    COMMERCE_PROJECTION_ENABLED: 'true',
    COMMERCE_PROJECTION_ENDPOINT: 'https://commerce.internal/internal/v1/order-projections',
    COMMERCE_PROJECTION_KEY_ID: 'rag-worker',
    COMMERCE_PROJECTION_SHARED_SECRET: 'commerce-shared-secret-with-32-characters',
    ...overrides
  }
}

test('keeps commerce projection disabled by default and validates enabled secrets', () => {
  assert.deepEqual(resolveCommerceProjectionConfig({}), { enabled: false })
  assert.throws(
    () => resolveCommerceProjectionConfig(enabledEnvironment({ COMMERCE_PROJECTION_SHARED_SECRET: '' })),
    error => error.code === 'CONFIG_MISSING' && error.field === 'COMMERCE_PROJECTION_SHARED_SECRET'
  )
  assert.throws(
    () => resolveCommerceProjectionConfig(enabledEnvironment({ COMMERCE_PROJECTION_ENDPOINT: 'http://commerce.internal' })),
    error => error.code === 'CONFIG_INVALID' && error.field === 'COMMERCE_PROJECTION_ENDPOINT'
  )
})

test('builds immutable bounded production runtime configuration', () => {
  const config = resolveCommerceProjectionConfig(enabledEnvironment({
    COMMERCE_PROJECTION_BATCH_SIZE: '40',
    COMMERCE_PROJECTION_INTERVAL_MS: '5000',
    COMMERCE_PROJECTION_MAX_ATTEMPTS: '8'
  }))

  assert.equal(config.enabled, true)
  assert.equal(config.batchSize, 40)
  assert.equal(config.intervalMs, 5000)
  assert.equal(config.retryPolicy.maxAttempts, 8)
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.retryPolicy), true)
})

test('runs an empty dispatcher and retry worker without opening a listener', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options = {}) {
      calls.push({ sql, options })
      if (/SELECT events\.id/.test(sql)) return [[], {}]
      if (/SELECT id, event_inbox_id/.test(sql)) return [[], {}]
      return [[], { affectedRows: 0 }]
    },
    async transaction(operation) { return operation('transaction') }
  }
  const runtime = createCommerceProjectionRuntime({
    sequelize,
    environment: enabledEnvironment(),
    logger: { info() {}, error() {} },
    fetch: async () => { throw new Error('must not be called') }
  })

  assert.equal(runtime.enabled, true)
  assert.deepEqual(await runtime.runOnce(), {
    dispatch: { listed: 0, succeeded: 0, failed: 0 },
    retry: { recovered: 0, listed: 0, claimed: 0, succeeded: 0, failed: 0, skipped: 0 }
  })
  assert.equal(calls.some(call => /commerce_projection_jobs/.test(call.sql)), true)
})

test('returns a no-op runtime when the feature is disabled', async () => {
  const runtime = createCommerceProjectionRuntime({ environment: {} })

  assert.equal(runtime.enabled, false)
  assert.deepEqual(await runtime.runOnce(), { disabled: true })
  assert.equal(runtime.start(), false)
  assert.equal(runtime.stop(), false)
})

