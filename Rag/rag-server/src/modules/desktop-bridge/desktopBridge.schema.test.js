const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { ensureDesktopBridgeSchema } = require('./desktopBridge.schema')

test('creates every durable bridge table with required uniqueness and queue indexes', async () => {
  const statements = []
  const sequelize = { query: async sql => statements.push(sql) }

  await ensureDesktopBridgeSchema(sequelize)

  const sql = statements.join('\n')
  for (const table of [
    'desktop_bridge_nodes',
    'desktop_bridge_pairings',
    'desktop_bridge_bindings',
    'desktop_bridge_leases',
    'desktop_bridge_events',
    'desktop_bridge_commands',
    'desktop_bridge_audit_logs'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'))
  }

  assert.match(sql, /desktop_bridge_nodes[\s\S]*UNIQUE KEY\s+\w+\s*\(node_key\)/i)
  assert.match(sql, /desktop_bridge_pairings[\s\S]*UNIQUE KEY\s+\w+\s*\(code_hash\)/i)
  assert.match(sql, /desktop_bridge_bindings[\s\S]*UNIQUE KEY\s+\w+\s*\(channel_account_id\)/i)
  assert.match(sql, /desktop_bridge_leases[\s\S]*UNIQUE KEY\s+\w+\s*\(channel_account_id\)/i)
  assert.match(sql, /desktop_bridge_events[\s\S]*UNIQUE KEY\s+\w+\s*\(event_id\)/i)
  assert.match(sql, /desktop_bridge_commands[\s\S]*UNIQUE KEY\s+\w+\s*\(command_id\)/i)
  assert.match(sql, /desktop_bridge_audit_logs[\s\S]*INDEX\s+\w+\s*\(node_id,\s*created_at\)/i)
  assert.match(sql, /DATETIME\(3\)/i)
  assert.match(sql, /idx_bridge_commands_queue/i)
  assert.match(sql, /idx_bridge_events_status/i)
})

test('schema initialization is repeatable', async () => {
  const statements = []
  const sequelize = { query: async sql => statements.push(sql) }
  await ensureDesktopBridgeSchema(sequelize)
  const firstRunCount = statements.length
  await ensureDesktopBridgeSchema(sequelize)
  assert.equal(statements.length, firstRunCount * 2)
  assert.ok(statements.every(sql => /CREATE TABLE IF NOT EXISTS/i.test(sql)))
})

test('database bootstrap invokes the module-owned schema initializer', () => {
  const source = readFileSync(path.join(__dirname, '../../config/database.js'), 'utf8')
  assert.match(source, /require\('\.\.\/modules\/desktop-bridge\/desktopBridge\.schema'\)/)
  assert.match(source, /await ensureDesktopBridgeSchema\(sequelize\)/)
})
