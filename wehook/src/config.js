const fs = require('fs')
const path = require('path')

function loadLocalEnv(env, filePath = path.resolve(process.cwd(), '.env')) {
  if (!env || !fs.existsSync(filePath)) return
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = line.slice(0, separatorIndex).trim()
    if (!key || Object.prototype.hasOwnProperty.call(env, key)) continue
    let value = line.slice(separatorIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
}

function numberFromEnv(env, name, fallback) {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function loadConfig(env = process.env) {
  if (env === process.env) loadLocalEnv(env)
  const nodeEnv = env.NODE_ENV || 'development'
  const authToken = env.GATEWAY_AUTH_TOKEN || (nodeEnv === 'production' ? null : 'development-only-token')
  if (!authToken) throw new Error('GATEWAY_AUTH_TOKEN is required in production')
  if (Boolean(env.GATEWAY_TLS_CERT_PATH) !== Boolean(env.GATEWAY_TLS_KEY_PATH)) {
    throw new Error('GATEWAY_TLS_CERT_PATH and GATEWAY_TLS_KEY_PATH must be configured together')
  }
  const storeDriver = String(env.GATEWAY_STORE_DRIVER || 'file').toLowerCase()
  if (!['file', 'mysql'].includes(storeDriver)) throw new Error('GATEWAY_STORE_DRIVER must be file or mysql')
  const mockInboundEnabled = nodeEnv !== 'production' &&
    (env.GATEWAY_MOCK_INBOUND_ENABLED === undefined || String(env.GATEWAY_MOCK_INBOUND_ENABLED).toLowerCase() === 'true')
  return {
    nodeEnv,
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: numberFromEnv(env, 'GATEWAY_PORT', 8787),
    authToken,
    tlsCertPath: env.GATEWAY_TLS_CERT_PATH ? path.resolve(env.GATEWAY_TLS_CERT_PATH) : null,
    tlsKeyPath: env.GATEWAY_TLS_KEY_PATH ? path.resolve(env.GATEWAY_TLS_KEY_PATH) : null,
    storeDriver,
    storePath: path.resolve(env.GATEWAY_STORE_PATH || './data/gateway-store.json'),
    wecomRuntimeConfigKey: env.WECOM_RUNTIME_CONFIG_KEY || null,
    wecomRuntimeConfigStorePath: path.resolve(env.WECOM_RUNTIME_CONFIG_STORE_PATH || './data/wecom-runtime-configs.json'),
    wecomSyncStateStorePath: path.resolve(env.WECOM_SYNC_STATE_STORE_PATH || './data/wecom-sync-states.json'),
    mockInboundEnabled,
    mockInboundToken: env.GATEWAY_MOCK_INBOUND_TOKEN || authToken,
    db: {
      host: env.GATEWAY_DB_HOST || '127.0.0.1',
      port: numberFromEnv(env, 'GATEWAY_DB_PORT', 3306),
      name: env.GATEWAY_DB_NAME || null,
      user: env.GATEWAY_DB_USER || null,
      password: env.GATEWAY_DB_PASSWORD || null,
      ssl: String(env.GATEWAY_DB_SSL || '').toLowerCase() === 'true',
      poolMax: numberFromEnv(env, 'GATEWAY_DB_POOL_MAX', 10),
      poolMin: numberFromEnv(env, 'GATEWAY_DB_POOL_MIN', 0),
      leaseMs: numberFromEnv(env, 'GATEWAY_DB_LEASE_MS', 60000)
    },
    authTimeoutMs: numberFromEnv(env, 'GATEWAY_AUTH_TIMEOUT_MS', 5000),
    heartbeatMs: numberFromEnv(env, 'GATEWAY_HEARTBEAT_MS', 15000),
    ackTimeoutMs: numberFromEnv(env, 'GATEWAY_ACK_TIMEOUT_MS', 10000),
    retryBaseMs: numberFromEnv(env, 'GATEWAY_RETRY_BASE_MS', 500),
    retryMaxMs: numberFromEnv(env, 'GATEWAY_RETRY_MAX_MS', 30000),
    maxRetries: numberFromEnv(env, 'GATEWAY_MAX_RETRIES', 5)
  }
}

module.exports = { loadConfig }
