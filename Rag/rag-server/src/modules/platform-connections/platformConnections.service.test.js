const test = require('node:test')
const assert = require('node:assert/strict')

const { createPlatformConnectionsService } = require('./platformConnections.service')

function createHarness() {
  const calls = []
  const connections = new Map()
  const accounts = new Map()
  const allowlist = new Map()
  let nextConnectionId = 1
  let nextAllowlistId = 100

  const repository = {
    transaction: async fn => fn({ id: 'tx' }),
    findByCorpId: async () => null,
    createConnection: async (row) => {
      const id = nextConnectionId++
      connections.set(id, {
        id,
        channel_code: 'wecom_kf',
        connection_name: row.connectionName,
        corp_id: row.corpId,
        credential_ciphertext: row.credentialCiphertext,
        callback_key: row.callbackKey,
        config_version: 1,
        status: 'draft',
        health_status: 'unknown'
      })
      calls.push(['createConnection', row])
      return id
    },
    getConnection: async (id, options = {}) => {
      const row = connections.get(Number(id))
      if (!row) return null
      const copy = { ...row }
      if (!options.includeCredentials) delete copy.credential_ciphertext
      return copy
    },
    listConnections: async () => [...connections.values()].map(row => {
      const copy = { ...row }
      delete copy.credential_ciphertext
      return copy
    }),
    updateConnectionStatus: async (id, input) => {
      calls.push(['updateConnectionStatus', Number(id), input])
      const row = connections.get(Number(id))
      if (row) Object.assign(row, {
        status: input.status ?? row.status,
        health_status: input.healthStatus ?? row.health_status,
        health_message: input.healthMessage ?? row.health_message,
        account_count: input.accountCount ?? row.account_count
      })
    },
    upsertWecomAccounts: async (connectionId, rows) => {
      calls.push(['upsertWecomAccounts', Number(connectionId), rows])
      rows.forEach((row, index) => accounts.set(index + 10, {
        id: index + 10,
        connection_id: Number(connectionId),
        account_name: row.name,
        external_account_id: row.externalAccountId,
        protection_level: row.protectionLevel,
        locked_reason: row.lockedReason,
        ai_enabled: false,
        allowlist_enabled: true
      }))
    },
    listAccounts: async connectionId => [...accounts.values()].filter(row => row.connection_id === Number(connectionId)),
    listActiveAllowlist: async accountId => Number(accountId) === 11 ? ['external-test'] : [],
    reserveConfigVersion: async id => {
      const row = connections.get(Number(id))
      row.config_version = Number(row.config_version || 0) + 1
      return row.config_version
    },
    getAccount: async accountId => accounts.get(Number(accountId)) || null,
    updateAccountPolicy: async (accountId, policy) => {
      calls.push(['updateAccountPolicy', Number(accountId), policy])
      Object.assign(accounts.get(Number(accountId)), policy)
    },
    listAllowlistEntries: async accountId => [...allowlist.values()]
      .filter(row => row.account_id === Number(accountId) && row.status === 'active'),
    getAllowlistEntry: async (accountId, entryId) => {
      const row = allowlist.get(Number(entryId))
      return row?.account_id === Number(accountId) ? row : null
    },
    upsertAllowlistEntry: async (accountId, input, operatorId) => {
      const existing = [...allowlist.values()].find(row => (
        row.account_id === Number(accountId) && row.external_user_id === input.external_user_id
      ))
      const row = existing || {
        id: nextAllowlistId++, account_id: Number(accountId), external_user_id: input.external_user_id,
        created_by: operatorId, created_at: new Date('2026-07-25T00:00:00Z')
      }
      Object.assign(row, { label: input.label, status: 'active', updated_at: new Date('2026-07-25T00:00:00Z') })
      allowlist.set(row.id, row)
      calls.push(['upsertAllowlistEntry', row.id])
      return row.id
    },
    deactivateAllowlistEntry: async (accountId, entryId) => {
      const row = allowlist.get(Number(entryId))
      if (row?.account_id === Number(accountId)) row.status = 'inactive'
      calls.push(['deactivateAllowlistEntry', Number(entryId)])
    },
    listOperationLogs: async () => ({ rows: [], total: 0 }),
    parseJson: value => typeof value === 'string' ? JSON.parse(value) : value,
    writeOperationLog: async row => calls.push(['audit', row])
  }

  const credentialCipher = {
    encrypt: payload => `encrypted:${JSON.stringify(payload)}`,
    decrypt: value => JSON.parse(value.slice('encrypted:'.length))
  }

  return { calls, connections, accounts, allowlist, repository, credentialCipher }
}

test('creates an encrypted connection and returns only masked metadata', async () => {
  const harness = createHarness()
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    publicCallbackBaseUrl: 'https://wecom.thelonelybrave.cn',
    randomBytes: () => Buffer.from('1234567890123456')
  })
  const expectedCallbackKey = Buffer.from('1234567890123456').toString('hex')
  const expectedCallbackUrl = 'https://wecom.thelonelybrave.cn/webhooks/wecom/' + expectedCallbackKey

  const result = await service.createConnection({
    connectionName: '孤勇者企业微信', corpId: 'ww123456789', secret: 'secret',
    callbackToken: 'token', encodingAesKey: 'aes-key'
  }, 9)

  assert.equal(result.id, 1)
  assert.equal(result.corpId, 'ww12*******')
  assert.equal(result.callbackUrl, expectedCallbackUrl)
  assert.equal('secret' in result, false)
  assert.equal('credentialCiphertext' in result, false)
  const createCall = harness.calls.find(call => call[0] === 'createConnection')
  assert.match(createCall[1].credentialCiphertext, /^encrypted:/)
  assert.doesNotMatch(JSON.stringify(result), /callback_key|credential_ciphertext|secret|callbackToken|encodingAesKey/)
})

test('lists connections with the same derived callback url', async () => {
  const harness = createHarness()
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    publicCallbackBaseUrl: 'https://wecom.thelonelybrave.cn',
    randomBytes: () => Buffer.from('1234567890123456')
  })
  const expectedCallbackUrl = 'https://wecom.thelonelybrave.cn/webhooks/wecom/31323334353637383930313233343536'

  await service.createConnection({
    connectionName: 'test connection', corpId: 'ww123456789', secret: 'secret',
    callbackToken: 'token', encodingAesKey: 'aes-key'
  }, 9)

  const rows = await service.listConnections()
  assert.equal(rows[0].callbackUrl, expectedCallbackUrl)
  assert.equal('callback_key' in rows[0], false)
  assert.doesNotMatch(JSON.stringify(rows[0]), /secret|callbackToken|encodingAesKey|credentialCiphertext/)
})

test('rejects non-https public callback bases', () => {
  const harness = createHarness()
  assert.throws(() => createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    publicCallbackBaseUrl: 'http://wecom.thelonelybrave.cn'
  }), /must use HTTPS/)
})

test('rejects public callback bases with credentials, query, or fragment', () => {
  const harness = createHarness()
  for (const publicCallbackBaseUrl of [
    'https://admin:password@wecom.thelonelybrave.cn',
    'https://wecom.thelonelybrave.cn?source=admin',
    'https://wecom.thelonelybrave.cn#callback',
    'https://wecom.thelonelybrave.cn?',
    'https://wecom.thelonelybrave.cn#'
  ]) {
    assert.throws(() => createPlatformConnectionsService({
      repository: harness.repository,
      credentialCipher: harness.credentialCipher,
      wecomClient: {},
      publicCallbackBaseUrl
    }), /exclude username, password, query, and fragment/)
  }
})

test('verification syncs accounts locked and protects 客服1号 as production baseline', async () => {
  const harness = createHarness()
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {
      verifyAndListAccounts: async () => ({
        accounts: [
          { externalAccountId: 'wk-prod', name: '客服1号', avatar: null },
          { externalAccountId: 'wk-test', name: 'AI测试客服', avatar: null }
        ],
        expiresIn: 7200
      })
    },
    now: () => new Date('2026-07-24T10:00:00Z')
  })
  await service.createConnection({
    connectionName: '孤勇者企业微信', corpId: 'ww123', secret: 'secret',
    callbackToken: 'token', encodingAesKey: 'aes-key'
  }, 9)

  const result = await service.verifyConnection(1, 9)
  const syncCall = harness.calls.find(call => call[0] === 'upsertWecomAccounts')
  assert.equal(syncCall[2].length, 2)
  assert.deepEqual(syncCall[2].map(row => row.protectionLevel), ['locked', 'locked'])
  assert.equal(syncCall[2][0].lockedReason, 'production_baseline')
  assert.equal(syncCall[2][1].lockedReason, null)
  assert.equal(result.connection.status, 'verified')
  assert.equal(result.accounts.length, 2)
})

test('never unlocks a production baseline account', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'verified' })
  harness.accounts.set(12, {
    id: 12, connection_id: 1, account_name: '客服1号', protection_level: 'locked',
    locked_reason: 'production_baseline', ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  await assert.rejects(
    () => service.updateAccountPolicy(12, {
      protectionLevel: 'test', aiEnabled: false, allowlistEnabled: true
    }, 9),
    /production baseline account is locked/
  )
  assert.equal(harness.calls.some(call => call[0] === 'updateAccountPolicy'), false)
})

test('rejects every policy write for 客服1号 even when legacy data lacks the baseline marker', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'verified' })
  harness.accounts.set(12, {
    id: 12, connection_id: 1, account_name: '客服1号', protection_level: 'locked',
    locked_reason: null, ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  await assert.rejects(
    () => service.updateAccountPolicy(12, {
      protectionLevel: 'locked', aiEnabled: false, allowlistEnabled: false
    }, 9),
    /production baseline account is locked/
  )
  assert.equal(harness.calls.some(call => call[0] === 'updateAccountPolicy'), false)
})

test('allows a non-baseline account to enter allowlisted test mode', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'verified' })
  harness.accounts.set(13, {
    id: 13, connection_id: 1, account_name: 'AI测试客服', protection_level: 'locked',
    locked_reason: null, ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  const result = await service.updateAccountPolicy(13, {
    protectionLevel: 'test', aiEnabled: true, allowlistEnabled: true
  }, 9)

  assert.equal(result.protection_level, 'test')
  assert.equal(result.ai_enabled, true)
  assert.equal(harness.calls.some(call => call[0] === 'audit'), true)
})

test('rejects account policy edits while the gateway snapshot is active', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'active' })
  harness.accounts.set(13, {
    id: 13, connection_id: 1, account_name: 'AI测试客服', protection_level: 'test',
    locked_reason: null, ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  await assert.rejects(
    () => service.updateAccountPolicy(13, {
      protectionLevel: 'test', aiEnabled: true, allowlistEnabled: true
    }, 9),
    /disable runtime before editing account configuration/
  )
})

test('publishes a protected runtime snapshot and activates only after gateway confirmation', async () => {
  const harness = createHarness()
  const published = []
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {
      verifyAndListAccounts: async () => ({
        accounts: [
          { externalAccountId: 'wk-prod', name: '客服1号', avatar: null },
          { externalAccountId: 'wk-test', name: 'AI测试客服', avatar: null }
        ]
      })
    },
    runtimeConfigPublisher: {
      async publish(snapshot) {
        published.push(snapshot)
        return {
          connectionId: snapshot.connectionId,
          configVersion: snapshot.configVersion,
          status: 'applied'
        }
      }
    }
  })
  await service.createConnection({
    connectionName: '孤勇者企业微信', corpId: 'ww123', secret: 'secret',
    callbackToken: 'token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  }, 9)
  await service.verifyConnection(1, 9)
  const testAccount = harness.accounts.get(11)
  Object.assign(testAccount, {
    status: 'active',
    sync_status: 'synced',
    protection_level: 'test',
    ai_enabled: true,
    allowlist_enabled: true
  })
  const productionAccount = harness.accounts.get(10)
  Object.assign(productionAccount, { status: 'active', sync_status: 'synced', ai_enabled: true })

  const result = await service.publishRuntimeConfig(1, 9)

  assert.equal(published.length, 1)
  assert.equal(published[0].configVersion, 2)
  assert.equal(published[0].accounts[0].protectionLevel, 'locked')
  assert.equal(published[0].accounts[0].aiEnabled, false)
  assert.deepEqual(published[0].accounts[1].allowlist, ['external-test'])
  assert.equal(result.connection.status, 'active')
})

test('disables an active gateway snapshot before marking the connection disabled', async () => {
  const harness = createHarness()
  const published = []
  harness.connections.set(1, {
    id: 1, connection_name: '测试企业', corp_id: 'ww123', callback_key: 'callback',
    credential_ciphertext: harness.credentialCipher.encrypt({
      secret: 'secret', callbackToken: 'token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    }),
    config_version: 3, status: 'active', health_status: 'healthy'
  })
  harness.accounts.set(13, {
    id: 13, connection_id: 1, account_name: 'AI测试客服', external_account_id: 'wk-test',
    status: 'active', sync_status: 'synced', protection_level: 'test', locked_reason: null,
    ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    runtimeConfigPublisher: {
      async publish(snapshot, options) {
        published.push({ snapshot, options })
        return { connectionId: snapshot.connectionId, configVersion: snapshot.configVersion, status: 'applied' }
      }
    }
  })

  const result = await service.disableRuntimeConfig(1, 9)

  assert.equal(published.length, 1)
  assert.equal(published[0].options.status, 'disabled')
  assert.equal(result.connection.status, 'disabled')
  assert.ok(harness.calls.some(call => call[0] === 'audit' && call[1].action === 'runtime_config_disabled'))
})

test('manages allowlist entries only for inactive non-baseline test accounts', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'verified' })
  harness.accounts.set(13, {
    id: 13, connection_id: 1, account_name: 'AI测试客服', protection_level: 'test',
    locked_reason: null, ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  const added = await service.addAllowlistEntry(13, {
    externalUserId: ' wm-test-user ', label: ' 测试手机 '
  }, 9)
  assert.equal(added.externalUserId, 'wm-test-user')
  assert.equal((await service.listAllowlist(13)).length, 1)

  await service.removeAllowlistEntry(13, added.id, 9)
  assert.equal((await service.listAllowlist(13)).length, 0)
  assert.deepEqual(
    harness.calls.filter(call => call[0] === 'audit').map(call => call[1].action),
    ['allowlist_added', 'allowlist_removed']
  )
  assert.doesNotMatch(JSON.stringify(harness.calls.filter(call => call[0] === 'audit')), /wm-test-user/)
})

test('never allows a production baseline account into allowlist management', async () => {
  const harness = createHarness()
  harness.connections.set(1, { id: 1, status: 'verified' })
  harness.accounts.set(12, {
    id: 12, connection_id: 1, account_name: '客服1号', protection_level: 'test',
    locked_reason: 'production_baseline', ai_enabled: false, allowlist_enabled: true
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  await assert.rejects(
    () => service.addAllowlistEntry(12, { externalUserId: 'wm-test-user' }, 9),
    /production baseline account is locked/
  )
})

test('returns paged operation logs with parsed change summaries', async () => {
  const harness = createHarness()
  harness.repository.listOperationLogs = async filters => ({
    rows: [{
      id: 71,
      connection_id: 1,
      connection_name: '测试企业',
      account_id: 13,
      account_name: 'AI测试客服',
      action: 'allowlist_added',
      before_json: null,
      after_json: '{"external_user_id":"wm-t*******"}',
      operator_id: 9,
      operator_name: 'admin',
      created_at: '2026-07-25T00:00:00Z'
    }],
    total: 1,
    filters
  })
  const service = createPlatformConnectionsService({
    repository: harness.repository, credentialCipher: harness.credentialCipher, wecomClient: {}
  })

  const result = await service.listOperationLogs({ page: 1, pageSize: 20 })

  assert.equal(result.total, 1)
  assert.equal(result.items[0].operatorName, 'admin')
  assert.deepEqual(result.items[0].after, { external_user_id: 'wm-t*******' })
})
