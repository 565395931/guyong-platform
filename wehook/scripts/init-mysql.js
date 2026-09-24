const mysql = require('mysql2/promise')
const MySqlEventStore = require('../src/gateway/mysqlEventStore')

function portFromEnv(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

async function main() {
  const name = process.env.GATEWAY_DB_NAME || 'cloud_channel_gateway'
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('GATEWAY_DB_NAME contains unsupported characters')
  const host = process.env.GATEWAY_DB_HOST || '127.0.0.1'
  const port = portFromEnv(process.env.GATEWAY_DB_PORT, 3306)
  const user = process.env.GATEWAY_DB_USER
  const password = process.env.GATEWAY_DB_PASSWORD || ''
  const adminUser = process.env.GATEWAY_DB_ADMIN_USER || user
  const adminPassword = process.env.GATEWAY_DB_ADMIN_PASSWORD || password
  if (!user || !adminUser) throw new Error('GATEWAY_DB_USER or GATEWAY_DB_ADMIN_USER is required')

  const admin = await mysql.createConnection({
    host,
    port,
    user: adminUser,
    password: adminPassword,
    ssl: String(process.env.GATEWAY_DB_SSL || '').toLowerCase() === 'true' ? {} : undefined
  })
  try {
    const quote = String.fromCharCode(96)
    await admin.query('CREATE DATABASE IF NOT EXISTS ' + quote + name + quote + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
  } finally {
    await admin.end()
  }

  const store = new MySqlEventStore({
    host,
    port,
    name,
    user,
    password,
    ssl: String(process.env.GATEWAY_DB_SSL || '').toLowerCase() === 'true',
    poolMax: portFromEnv(process.env.GATEWAY_DB_POOL_MAX, 10),
    leaseMs: portFromEnv(process.env.GATEWAY_DB_LEASE_MS, 60000)
  })
  try {
    await store.stats()
  } finally {
    await store.close()
  }
  process.stdout.write(`MySQL Event Store initialized: ${host}:${port}/${name}\n`)
}

main().catch(error => {
  process.stderr.write(`MySQL Event Store initialization failed: ${error.message}\n`)
  process.exit(1)
})
