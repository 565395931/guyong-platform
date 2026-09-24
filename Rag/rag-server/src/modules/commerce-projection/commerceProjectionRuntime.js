const {
  HttpCommerceOrderPort,
  MySqlProjectionLedgerStore,
  ProjectionCoordinator,
  ProjectionWorker
} = require('@rag/commerce-projection-ledger')
const { createChannelEventProjectionCommandSource } = require('./commerceProjectionSource')
const { createCommerceProjectionDispatcher } = require('./commerceProjectionDispatcher')

class CommerceProjectionConfigurationError extends Error {
  constructor(code, field, message) {
    super(message)
    this.name = 'CommerceProjectionConfigurationError'
    this.code = code
    this.field = field
  }
}

function required(source, field) {
  const value = String(source[field] || '').trim()
  if (!value) throw new CommerceProjectionConfigurationError('CONFIG_MISSING', field, `${field} is required`)
  return value
}

function integer(source, field, fallback, minimum, maximum) {
  const value = Number(source[field] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CommerceProjectionConfigurationError('CONFIG_INVALID', field, `${field} is invalid`)
  }
  return value
}

function endpoint(source) {
  const raw = required(source, 'COMMERCE_PROJECTION_ENDPOINT')
  let parsed
  try { parsed = new URL(raw) } catch {
    throw new CommerceProjectionConfigurationError(
      'CONFIG_INVALID', 'COMMERCE_PROJECTION_ENDPOINT', 'COMMERCE_PROJECTION_ENDPOINT is invalid'
    )
  }
  const allowLocalHttp = source.NODE_ENV !== 'production'
    && source.COMMERCE_PROJECTION_ALLOW_INSECURE_HTTP === 'true'
  if (parsed.protocol !== 'https:' && !(allowLocalHttp && parsed.protocol === 'http:')) {
    throw new CommerceProjectionConfigurationError(
      'CONFIG_INVALID', 'COMMERCE_PROJECTION_ENDPOINT', 'COMMERCE_PROJECTION_ENDPOINT must use HTTPS'
    )
  }
  return raw
}

function resolveCommerceProjectionConfig(source = process.env) {
  if (source.COMMERCE_PROJECTION_ENABLED !== 'true') return Object.freeze({ enabled: false })
  const sharedSecret = required(source, 'COMMERCE_PROJECTION_SHARED_SECRET')
  if (sharedSecret.length < 32 || sharedSecret.length > 4096) {
    throw new CommerceProjectionConfigurationError(
      'CONFIG_INVALID', 'COMMERCE_PROJECTION_SHARED_SECRET', 'COMMERCE_PROJECTION_SHARED_SECRET is invalid'
    )
  }
  const retryPolicy = Object.freeze({
    maxAttempts: integer(source, 'COMMERCE_PROJECTION_MAX_ATTEMPTS', 5, 1, 100),
    baseDelayMs: integer(source, 'COMMERCE_PROJECTION_RETRY_BASE_MS', 1000, 0, 86400000),
    maxDelayMs: integer(source, 'COMMERCE_PROJECTION_RETRY_MAX_MS', 300000, 0, 86400000)
  })
  if (retryPolicy.maxDelayMs < retryPolicy.baseDelayMs) {
    throw new CommerceProjectionConfigurationError(
      'CONFIG_INVALID', 'COMMERCE_PROJECTION_RETRY_MAX_MS', 'Retry maximum must not be below its base'
    )
  }
  return Object.freeze({
    enabled: true,
    endpoint: endpoint(source),
    keyId: required(source, 'COMMERCE_PROJECTION_KEY_ID'),
    sharedSecret,
    allowInsecureHttp: source.NODE_ENV !== 'production'
      && source.COMMERCE_PROJECTION_ALLOW_INSECURE_HTTP === 'true',
    batchSize: integer(source, 'COMMERCE_PROJECTION_BATCH_SIZE', 25, 1, 1000),
    intervalMs: integer(source, 'COMMERCE_PROJECTION_INTERVAL_MS', 5000, 1000, 300000),
    leaseTimeoutMs: integer(source, 'COMMERCE_PROJECTION_LEASE_TIMEOUT_MS', 300000, 1000, 86400000),
    timeoutMs: integer(source, 'COMMERCE_PROJECTION_HTTP_TIMEOUT_MS', 10000, 100, 120000),
    retryPolicy
  })
}

function createDisabledRuntime() {
  return Object.freeze({
    enabled: false,
    runOnce: async () => Object.freeze({ disabled: true }),
    start: () => false,
    stop: () => false
  })
}

function createCommerceProjectionRuntime({
  sequelize,
  environment = process.env,
  logger = console,
  fetch,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const config = resolveCommerceProjectionConfig(environment)
  if (!config.enabled) return createDisabledRuntime()
  if (!sequelize || typeof sequelize.query !== 'function' || typeof sequelize.transaction !== 'function') {
    throw new TypeError('Commerce projection runtime requires Sequelize')
  }

  const store = new MySqlProjectionLedgerStore(sequelize)
  const source = createChannelEventProjectionCommandSource(sequelize)
  const port = new HttpCommerceOrderPort({
    endpoint: config.endpoint,
    keyId: config.keyId,
    sharedSecret: config.sharedSecret,
    allowInsecureHttp: config.allowInsecureHttp,
    timeoutMs: config.timeoutMs,
    now,
    ...(fetch ? { fetch } : {})
  })
  const coordinator = new ProjectionCoordinator({
    store,
    vendure: port,
    compareExternalVersions: (incoming, current) => incoming.localeCompare(current),
    retryPolicy: config.retryPolicy,
    now
  })
  const dispatcher = createCommerceProjectionDispatcher({ source, coordinator, batchSize: config.batchSize })
  const worker = new ProjectionWorker({
    store,
    coordinator,
    commandSource: source,
    retryPolicy: config.retryPolicy,
    now,
    batchSize: config.batchSize,
    leaseTimeoutMs: config.leaseTimeoutMs
  })
  let timer = null
  let running = false

  async function runOnce() {
    const dispatch = await dispatcher.runOnce()
    const retry = await worker.runOnce()
    return Object.freeze({ dispatch, retry })
  }

  async function tick() {
    if (running) return
    running = true
    try {
      const summary = await runOnce()
      logger.info?.('commerce.projection_tick', summary)
    } catch (error) {
      logger.error?.('commerce.projection_tick_failed', { code: error?.code || 'COMMERCE_PROJECTION_TICK_FAILED' })
    } finally {
      running = false
    }
  }

  return Object.freeze({
    enabled: true,
    runOnce,
    start() {
      if (timer) return false
      timer = setIntervalFn(() => { void tick() }, config.intervalMs)
      timer?.unref?.()
      void tick()
      return true
    },
    stop() {
      if (!timer) return false
      clearIntervalFn(timer)
      timer = null
      return true
    }
  })
}

module.exports = {
  CommerceProjectionConfigurationError,
  createCommerceProjectionRuntime,
  resolveCommerceProjectionConfig
}

