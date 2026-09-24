const test = require('node:test')
const assert = require('node:assert/strict')

let schemaModule = {}
let repositoryModule = {}
try {
  schemaModule = require('./channelSyncState.schema')
  repositoryModule = require('./channelSyncState.repository')
} catch {
  // RED phase: assertions below describe the module contract.
}

test('creates one cursor per channel, account and supported resource', async () => {
  assert.equal(typeof schemaModule.ensureChannelSyncStateSchema, 'function')
  const statements = []

  await schemaModule.ensureChannelSyncStateSchema({
    query: async sql => statements.push(sql)
  })

  assert.equal(statements.length, 1)
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS channel_sync_state/i)
  assert.match(statements[0], /resource ENUM\('order','after_sales'\) NOT NULL/i)
  assert.match(
    statements[0],
    /UNIQUE KEY uq_channel_sync_state \(channel, account_id, resource\)/i
  )
})

test('creates an initial cursor without overwriting an existing cursor', async () => {
  assert.equal(typeof repositoryModule.createChannelSyncStateRepository, 'function')
  const calls = []
  const repository = repositoryModule.createChannelSyncStateRepository({
    query: async (sql, options) => {
      calls.push({ sql, options })
      if (/^\s*SELECT/i.test(sql)) {
        return [[{
          channel: 'pinduoduo', account_id: 7, resource: 'order',
          cursor_at: '2026-07-25 04:00:00', failure_count: 0,
          last_attempt_at: null, last_success_at: null, last_error_code: null
        }]]
      }
      return [null, { affectedRows: 1 }]
    }
  })

  const state = await repository.getOrCreate({
    channel: 'pinduoduo',
    accountId: 7,
    resource: 'order',
    initialCursorAt: '2026-07-25 04:00:00'
  })

  assert.equal(state.accountId, 7)
  assert.equal(state.resource, 'order')
  assert.match(calls[0].sql, /INSERT INTO channel_sync_state/i)
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/i)
  assert.doesNotMatch(calls[0].sql, /cursor_at\s*=\s*VALUES\(cursor_at\)/i)
  assert.deepEqual(calls[1].options.replacements, {
    channel: 'pinduoduo', accountId: 7, resource: 'order'
  })
})

test('advances only the selected account and resource on success', async () => {
  assert.equal(typeof repositoryModule.createChannelSyncStateRepository, 'function')
  let call
  const repository = repositoryModule.createChannelSyncStateRepository({
    query: async (sql, options) => {
      call = { sql, options }
      return [null, { affectedRows: 1 }]
    }
  })

  await repository.markSuccess({
    channel: 'pinduoduo',
    accountId: 9,
    resource: 'after_sales',
    cursorAt: '2026-07-25 04:30:00'
  })

  assert.match(call.sql, /SET\s+cursor_at\s*=\s*(?:FROM_UNIXTIME\()?\s*:cursorAt/i)
  assert.match(call.sql, /failure_count\s*=\s*0/i)
  assert.match(call.sql, /WHERE\s+channel\s*=\s*:channel[\s\S]*account_id\s*=\s*:accountId[\s\S]*resource\s*=\s*:resource/i)
  assert.equal(call.options.replacements.accountId, 9)
  assert.equal(call.options.replacements.resource, 'after_sales')
})

test('records a safe failure code without changing the cursor', async () => {
  assert.equal(typeof repositoryModule.createChannelSyncStateRepository, 'function')
  let call
  const repository = repositoryModule.createChannelSyncStateRepository({
    query: async (sql, options) => {
      call = { sql, options }
      return [null, { affectedRows: 1 }]
    }
  })

  await repository.markFailure({
    channel: 'pinduoduo',
    accountId: 9,
    resource: 'order',
    errorCode: 'PINDUODUO_API_ERROR'
  })

  assert.doesNotMatch(call.sql, /SET[\s\S]*cursor_at\s*=/i)
  assert.match(call.sql, /failure_count\s*=\s*failure_count\s*\+\s*1/i)
  assert.equal(call.options.replacements.errorCode, 'PINDUODUO_API_ERROR')
  await assert.rejects(
    () => repository.markFailure({
      channel: 'pinduoduo', accountId: 9, resource: 'product', errorCode: 'bad'
    }),
    /resource/i
  )
})
