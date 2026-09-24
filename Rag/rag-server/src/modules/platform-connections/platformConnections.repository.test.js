const test = require('node:test')
const assert = require('node:assert/strict')

const { createPlatformConnectionsRepository } = require('./platformConnections.repository')

function createFakeSequelize() {
  const calls = []
  return {
    calls,
    transaction: async fn => fn({ id: 'tx-1' }),
    query: async (sql, options = {}) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), options })
      if (/^INSERT INTO platform_connections/.test(sql.trim())) return [41, 1]
      if (/^SELECT/.test(sql.trim())) return [[], []]
      return [[], []]
    }
  }
}

test('creates a connection with named replacements', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)

  const id = await repository.createConnection({
    connectionName: '孤勇者企业微信',
    corpId: 'ww123',
    credentialCiphertext: 'ciphertext',
    callbackKey: 'callback-key',
    createdBy: 9
  })

  assert.equal(id, 41)
  const insert = sequelize.calls.find(call => call.sql.startsWith('INSERT INTO platform_connections'))
  assert.equal(insert.options.replacements.corpId, 'ww123')
  assert.equal(insert.sql.includes('ww123'), false)
})

test('lists connections with callback keys for public callback url derivation', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)

  await repository.listConnections()

  const list = sequelize.calls.find(call => call.sql.startsWith('SELECT id,channel_code,connection_name,corp_id'))
  assert.match(list.sql, /callback_key/)
})

test('synchronizes accounts without overwriting protection policy', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)

  await repository.transaction(transaction => repository.upsertWecomAccounts(7, [{
    externalAccountId: 'wkABC',
    name: 'AI测试客服',
    avatar: 'https://example.test/avatar.png',
    protectionLevel: 'locked',
    lockedReason: null
  }], transaction))

  const markMissing = sequelize.calls.find(call => call.sql.startsWith('UPDATE channel_accounts SET sync_status'))
  const upsert = sequelize.calls.find(call => call.sql.startsWith('INSERT INTO channel_accounts'))
  assert.equal(markMissing.options.replacements.connectionId, 7)
  assert.equal(markMissing.options.transaction.id, 'tx-1')
  assert.equal(upsert.options.replacements.externalAccountId, 'wkABC')
  assert.equal(upsert.options.transaction.id, 'tx-1')
  assert.doesNotMatch(upsert.sql, /protection_level\s*=\s*VALUES\(protection_level\)/)
  assert.match(upsert.sql, /production_baseline/)
})

test('writes account policies and audit entries in the supplied transaction', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)
  const transaction = { id: 'tx-policy' }

  await repository.updateAccountPolicy(12, {
    protection_level: 'test', ai_enabled: true, allowlist_enabled: true
  }, transaction)
  await repository.writeOperationLog({
    accountId: 12, action: 'account_policy_updated', beforeJson: {}, afterJson: { ai_enabled: true }, operatorId: 9
  }, transaction)

  const updates = sequelize.calls.filter(call => call.options.transaction === transaction)
  assert.equal(updates.length, 2)
  assert.equal(updates[0].options.replacements.accountId, 12)
  assert.equal(updates[1].options.replacements.action, 'account_policy_updated')
})

test('upserts and soft-disables allowlist entries in the supplied transaction', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)
  const transaction = { id: 'tx-allowlist' }

  await repository.upsertAllowlistEntry(12, {
    external_user_id: 'wm-test', label: '测试手机'
  }, 9, transaction)
  await repository.deactivateAllowlistEntry(12, 41, transaction)

  const upsert = sequelize.calls.find(call => call.sql.startsWith('INSERT INTO channel_account_allowlists'))
  const disable = sequelize.calls.find(call => call.sql.startsWith('UPDATE channel_account_allowlists'))
  assert.equal(upsert.options.replacements.externalUserId, 'wm-test')
  assert.match(upsert.sql, /ON DUPLICATE KEY UPDATE/)
  assert.equal(disable.options.replacements.entryId, 41)
  assert.equal(disable.options.transaction, transaction)
})

test('queries filtered operation logs with bounded pagination', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)

  await repository.listOperationLogs({
    connection_id: 8, account_id: 12, action: 'allowlist_added', page_size: 20, offset: 20
  })

  const list = sequelize.calls.find(call => /FROM channel_operation_logs l/.test(call.sql) && /ORDER BY/.test(call.sql))
  assert.equal(list.options.replacements.connectionId, 8)
  assert.equal(list.options.replacements.accountId, 12)
  assert.equal(list.options.replacements.limit, 20)
  assert.equal(list.options.replacements.offset, 20)
})

test('marks WeCom inbound activity on the connection and account only', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)
  const timestamp = new Date('2026-08-01T08:00:00Z')

  await repository.markWecomInbound({ connectionId: 8, accountId: 12, occurredAt: timestamp })

  const connectionUpdate = sequelize.calls.find(call => call.sql.startsWith('UPDATE platform_connections'))
  const accountUpdate = sequelize.calls.find(call => call.sql.startsWith('UPDATE channel_accounts SET last_inbound_at'))
  assert.match(connectionUpdate.sql, /channel_code='wecom_kf'/)
  assert.equal(connectionUpdate.options.replacements.connectionId, 8)
  assert.equal(connectionUpdate.options.replacements.timestamp, timestamp)
  assert.match(accountUpdate.sql, /channel='wecom_kf'/)
  assert.equal(accountUpdate.options.replacements.accountId, 12)
})

test('marks WeCom outbound activity on the account only', async () => {
  const sequelize = createFakeSequelize()
  const repository = createPlatformConnectionsRepository(sequelize)
  const timestamp = new Date('2026-08-01T08:05:00Z')

  await repository.markWecomOutbound({ accountId: 12, occurredAt: timestamp })

  const accountUpdate = sequelize.calls.find(call => call.sql.startsWith('UPDATE channel_accounts SET last_outbound_at'))
  assert.match(accountUpdate.sql, /channel='wecom_kf'/)
  assert.equal(accountUpdate.options.replacements.accountId, 12)
  assert.equal(accountUpdate.options.replacements.timestamp, timestamp)
})
