const test = require('node:test')
const assert = require('node:assert/strict')

const { ensurePlatformConnectionsSchema } = require('./platformConnections.schema')

function fakeSequelize() {
  const statements = []
  return {
    statements,
    query: async (sql, options = {}) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push({ sql: normalized, options })
      if (normalized.includes('information_schema.COLUMNS')) return [[], []]
      if (normalized.includes('information_schema.STATISTICS')) return [[], []]
      return [[], []]
    }
  }
}

test('creates enterprise connection support tables', async () => {
  const sequelize = fakeSequelize()
  await ensurePlatformConnectionsSchema(sequelize)
  const sql = sequelize.statements.map(row => row.sql).join('\n')

  for (const table of [
    'platform_connections',
    'channel_account_allowlists',
    'channel_sync_states',
    'channel_operation_logs'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), table)
  }
  assert.match(sql, /uk_platform_connection_channel_corp/)
  assert.match(sql, /uk_account_allowlist_identity/)
})

test('adds multi-account fields and uniqueness only when missing', async () => {
  const sequelize = fakeSequelize()
  await ensurePlatformConnectionsSchema(sequelize)
  const sql = sequelize.statements.map(row => row.sql).join('\n')

  for (const column of [
    'connection_id', 'external_account_id', 'avatar_url', 'protection_level',
    'locked_reason', 'ai_enabled', 'allowlist_enabled', 'sync_status',
    'last_inbound_at', 'last_outbound_at'
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column}`), column)
  }
  assert.match(sql, /uk_channel_account_connection_external/)
})

test('does not alter fields already present', async () => {
  const statements = []
  const sequelize = {
    query: async (sql, options = {}) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (normalized.includes('information_schema.COLUMNS')) return [[{ found: 1 }], []]
      if (normalized.includes('information_schema.STATISTICS')) return [[{ found: 1 }], []]
      return [[], []]
    }
  }

  await ensurePlatformConnectionsSchema(sequelize)
  assert.equal(statements.some(sql => /ALTER TABLE channel_accounts/.test(sql)), false)
})
