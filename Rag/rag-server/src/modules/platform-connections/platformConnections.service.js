const crypto = require('crypto')

const {
  normalizeConnectionInput,
  normalizeAccountPolicy,
  normalizeAllowlistInput,
  normalizeOperationLogQuery
} = require('./platformConnections.validation')

function maskIdentifier(value) {
  const text = String(value || '')
  if (text.length <= 4) return '*'.repeat(text.length || 4)
  const visible = 4
  return `${text.slice(0, visible)}${'*'.repeat(text.length - visible)}`
}

function safeErrorMessage(error) {
  return String(error?.message || 'unknown verification error')
    .replace(/([?&](?:corpsecret|access_token)=)[^&\s]+/gi, '$1******')
    .replace(/\b(?:secret|token)\s*[:=]\s*[^,;\s]+/gi, '$&'.replace(/[^:=\s]+$/, '******'))
    .slice(0, 400)
}

function normalizePublicCallbackBaseUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('WECOM_PUBLIC_CALLBACK_BASE_URL must use HTTPS and exclude username, password, query, and fragment')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    text.includes('?') ||
    text.includes('#')
  ) {
    throw new Error('WECOM_PUBLIC_CALLBACK_BASE_URL must use HTTPS and exclude username, password, query, and fragment')
  }
  return url.origin
}

function buildCallbackUrl(baseUrl, callbackKey) {
  if (!baseUrl || !callbackKey) return null
  return baseUrl + '/webhooks/wecom/' + encodeURIComponent(callbackKey)
}

function mapConnection(row) {
  if (!row) return null
  return {
    id: row.id,
    channelCode: row.channel_code || 'wecom_kf',
    connectionName: row.connection_name,
    corpId: maskIdentifier(row.corp_id),
    status: row.status,
    healthStatus: row.health_status,
    healthMessage: row.health_message || null,
    accountCount: Number(row.account_count || 0),
    configVersion: Number(row.config_version || 1),
    lastTokenRefreshAt: row.last_token_refresh_at || null,
    lastCallbackAt: row.last_callback_at || null,
    lastSyncAt: row.last_sync_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function mapAccount(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    accountName: row.account_name,
    externalAccountId: maskIdentifier(row.external_account_id),
    avatarUrl: row.avatar_url || null,
    status: row.status || 'active',
    protectionLevel: row.protection_level || 'locked',
    lockedReason: row.locked_reason || null,
    aiEnabled: row.ai_enabled === true || Number(row.ai_enabled) === 1,
    allowlistEnabled: row.allowlist_enabled === true || Number(row.allowlist_enabled) === 1,
    syncStatus: row.sync_status || 'synced',
    lastInboundAt: row.last_inbound_at || null,
    lastOutboundAt: row.last_outbound_at || null
  }
}

function mapAllowlistEntry(row) {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    externalUserId: row.external_user_id,
    label: row.label || null,
    status: row.status,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function mapOperationLog(row, parseJson) {
  return {
    id: Number(row.id),
    connectionId: row.connection_id == null ? null : Number(row.connection_id),
    connectionName: row.connection_name || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountName: row.account_name || null,
    action: row.action,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    operatorId: row.operator_id == null ? null : Number(row.operator_id),
    operatorName: row.operator_name || null,
    createdAt: row.created_at || null
  }
}

function createPlatformConnectionsService({
  repository,
  credentialCipher,
  wecomClient,
  runtimeConfigPublisher = null,
  protectedAccountNames = ['客服1号'],
  publicCallbackBaseUrl = '',
  now = () => new Date(),
  randomBytes = crypto.randomBytes
}) {
  const protectedNames = new Set(protectedAccountNames.map(name => String(name).trim()).filter(Boolean))
  const normalizedPublicCallbackBaseUrl = normalizePublicCallbackBaseUrl(publicCallbackBaseUrl)
  const mapConnectionResponse = row => {
    const connection = mapConnection(row)
    if (!connection) return null
    return {
      ...connection,
      callbackUrl: buildCallbackUrl(normalizedPublicCallbackBaseUrl, row?.callback_key)
    }
  }

  async function requireConnection(id, options) {
    const connection = await repository.getConnection(id, options)
    if (!connection) throw new Error('platform connection not found')
    return connection
  }

  function isProductionBaseline(account) {
    return account.locked_reason === 'production_baseline' || protectedNames.has(String(account.account_name || '').trim())
  }

  function requireInactiveConnection(connection) {
    if (connection.status === 'active') {
      throw new Error('disable runtime before editing account configuration')
    }
  }

  async function requireAllowlistAccount(accountId, transaction, { mutable = false } = {}) {
    const account = await repository.getAccount(accountId, transaction)
    if (!account) throw new Error('channel account not found')
    if (isProductionBaseline(account)) throw new Error('production baseline account is locked')
    if (account.protection_level !== 'test') throw new Error('allowlist is available only for test accounts')
    if (mutable) {
      const connection = await requireConnection(account.connection_id, { transaction })
      requireInactiveConnection(connection)
    }
    return account
  }

  async function buildRuntimeSnapshot(connection, configVersion) {
    const credentials = credentialCipher.decrypt(connection.credential_ciphertext)
    const accounts = (await repository.listAccounts(connection.id))
      .filter(account => account.status === 'active' && account.sync_status !== 'missing')
    if (!accounts.length) throw new Error('WeCom connection has no active synced accounts')
    const runtimeAccounts = []
    for (const account of accounts) {
      const productionBaseline = isProductionBaseline(account)
      const protectionLevel = productionBaseline ? 'locked' : (account.protection_level || 'locked')
      runtimeAccounts.push({
        accountId: Number(account.id),
        openKfId: account.external_account_id,
        name: account.account_name,
        status: account.status,
        protectionLevel,
        aiEnabled: protectionLevel === 'locked'
          ? false
          : (account.ai_enabled === true || Number(account.ai_enabled) === 1),
        allowlistEnabled: account.allowlist_enabled === true || Number(account.allowlist_enabled) === 1,
        allowlist: await repository.listActiveAllowlist(account.id)
      })
    }
    return {
      snapshot: {
        connectionId: Number(connection.id),
        configVersion,
        callbackKey: connection.callback_key,
        corpId: connection.corp_id,
        secret: credentials.secret,
        callbackToken: credentials.callbackToken,
        encodingAesKey: credentials.encodingAesKey,
        accounts: runtimeAccounts
      },
      accountCount: runtimeAccounts.length
    }
  }

  return {
    async listConnections() {
      return (await repository.listConnections()).map(mapConnectionResponse)
    },

    async createConnection(input, operatorId) {
      const normalized = normalizeConnectionInput(input)
      const duplicate = await repository.findByCorpId(normalized.channel_code, normalized.corp_id)
      if (duplicate) throw new Error('enterprise CorpID already exists')
      const credentialCiphertext = credentialCipher.encrypt({
        secret: normalized.secret,
        callbackToken: normalized.callback_token,
        encodingAesKey: normalized.encoding_aes_key
      })
      const callbackKey = randomBytes(16).toString('hex')
      const id = await repository.transaction(async transaction => {
        const connectionId = await repository.createConnection({
          connectionName: normalized.connection_name,
          corpId: normalized.corp_id,
          credentialCiphertext,
          callbackKey,
          createdBy: operatorId
        }, transaction)
        await repository.writeOperationLog({
          connectionId,
          action: 'connection_created',
          afterJson: { channel_code: normalized.channel_code, connection_name: normalized.connection_name },
          operatorId
        }, transaction)
        return connectionId
      })
      return mapConnectionResponse(await requireConnection(id))
    },

    async replaceCredentials(id, input, operatorId) {
      const connection = await requireConnection(id, { includeCredentials: true })
      requireInactiveConnection(connection)
      const normalized = normalizeConnectionInput({
        connectionName: connection.connection_name,
        corpId: connection.corp_id,
        ...input
      })
      const credentialCiphertext = credentialCipher.encrypt({
        secret: normalized.secret,
        callbackToken: normalized.callback_token,
        encodingAesKey: normalized.encoding_aes_key
      })
      await repository.transaction(async transaction => {
        await repository.replaceCredentials(id, credentialCiphertext, operatorId, transaction)
        await repository.writeOperationLog({
          connectionId: Number(id), action: 'connection_credentials_replaced', operatorId
        }, transaction)
      })
      return mapConnectionResponse(await requireConnection(id))
    },

    async verifyConnection(id, operatorId) {
      const connection = await requireConnection(id, { includeCredentials: true })
      requireInactiveConnection(connection)
      try {
        const credentials = credentialCipher.decrypt(connection.credential_ciphertext)
        const verified = await wecomClient.verifyAndListAccounts({
          corpId: connection.corp_id,
          secret: credentials.secret
        })
        const accountRows = verified.accounts.map(account => ({
          ...account,
          protectionLevel: 'locked',
          lockedReason: protectedNames.has(account.name) ? 'production_baseline' : null
        }))
        const timestamp = now()
        await repository.transaction(async transaction => {
          await repository.upsertWecomAccounts(id, accountRows, transaction)
          await repository.updateConnectionStatus(id, {
            status: 'verified',
            healthStatus: 'healthy',
            healthMessage: null,
            accountCount: accountRows.length,
            lastTokenRefreshAt: timestamp,
            lastSyncAt: timestamp,
            updatedBy: operatorId
          }, transaction)
          await repository.writeOperationLog({
            connectionId: Number(id), action: 'connection_verified',
            afterJson: { account_count: accountRows.length }, operatorId
          }, transaction)
        })
        return {
          connection: mapConnectionResponse(await requireConnection(id)),
          accounts: (await repository.listAccounts(id)).map(mapAccount)
        }
      } catch (error) {
        const message = safeErrorMessage(error)
        await repository.updateConnectionStatus(id, {
          status: 'error', healthStatus: 'error', healthMessage: message, updatedBy: operatorId
        })
        throw new Error(`WeCom connection verification failed: ${message}`)
      }
    },

    async listAccounts(connectionId) {
      await requireConnection(connectionId)
      return (await repository.listAccounts(connectionId)).map(mapAccount)
    },

    async publishRuntimeConfig(id, operatorId) {
      if (!runtimeConfigPublisher) throw new Error('WeCom runtime config publisher is not configured')
      const connection = await requireConnection(id, { includeCredentials: true })
      if (!['verified', 'active'].includes(connection.status)) {
        throw new Error('WeCom connection must be verified before runtime publishing')
      }
      const configVersion = await repository.reserveConfigVersion(id, operatorId)
      const { snapshot, accountCount } = await buildRuntimeSnapshot(connection, configVersion)
      try {
        const applied = await runtimeConfigPublisher.publish(snapshot)
        await repository.transaction(async transaction => {
          await repository.updateConnectionStatus(id, {
            status: 'active',
            healthStatus: 'healthy',
            healthMessage: null,
            updatedBy: operatorId
          }, transaction)
          await repository.writeOperationLog({
            connectionId: Number(id),
            action: 'runtime_config_published',
            afterJson: { config_version: configVersion, account_count: accountCount },
            operatorId
          }, transaction)
        })
        return {
          connection: mapConnectionResponse(await requireConnection(id)),
          runtime: applied
        }
      } catch (error) {
        const message = safeErrorMessage(error)
        await repository.updateConnectionStatus(id, {
          healthStatus: 'error',
          healthMessage: message,
          updatedBy: operatorId
        })
        throw new Error(`WeCom runtime publish failed: ${message}`)
      }
    },

    async disableRuntimeConfig(id, operatorId) {
      if (!runtimeConfigPublisher) throw new Error('WeCom runtime config publisher is not configured')
      const connection = await requireConnection(id, { includeCredentials: true })
      if (connection.status !== 'active') throw new Error('only an active WeCom runtime can be disabled')
      const configVersion = await repository.reserveConfigVersion(id, operatorId)
      const { snapshot, accountCount } = await buildRuntimeSnapshot(connection, configVersion)
      try {
        const applied = await runtimeConfigPublisher.publish(snapshot, { status: 'disabled' })
        await repository.transaction(async transaction => {
          await repository.updateConnectionStatus(id, {
            status: 'disabled',
            healthStatus: 'healthy',
            healthMessage: null,
            updatedBy: operatorId
          }, transaction)
          await repository.writeOperationLog({
            connectionId: Number(id),
            action: 'runtime_config_disabled',
            beforeJson: { status: 'active' },
            afterJson: { status: 'disabled', config_version: configVersion, account_count: accountCount },
            operatorId
          }, transaction)
        })
        return { connection: mapConnectionResponse(await requireConnection(id)), runtime: applied }
      } catch (error) {
        const message = safeErrorMessage(error)
        await repository.updateConnectionStatus(id, {
          healthStatus: 'error', healthMessage: message, updatedBy: operatorId
        })
        throw new Error(`WeCom runtime disable failed: ${message}`)
      }
    },

    async updateAccountPolicy(accountId, input, operatorId) {
      const policy = normalizeAccountPolicy(input)
      if (policy.protection_level === 'none') {
        throw new Error('production account mode is not available in this phase')
      }
      return repository.transaction(async transaction => {
        const account = await repository.getAccount(accountId, transaction)
        if (!account) throw new Error('channel account not found')
        if (isProductionBaseline(account)) throw new Error('production baseline account is locked')
        const connection = await requireConnection(account.connection_id, { transaction })
        requireInactiveConnection(connection)
        await repository.updateAccountPolicy(accountId, policy, transaction)
        await repository.writeOperationLog({
          connectionId: account.connection_id,
          accountId: Number(accountId),
          action: 'account_policy_updated',
          beforeJson: {
            protection_level: account.protection_level,
            ai_enabled: Boolean(account.ai_enabled),
            allowlist_enabled: Boolean(account.allowlist_enabled)
          },
          afterJson: policy,
          operatorId
        }, transaction)
        return policy
      })
    },

    async listAllowlist(accountId) {
      await requireAllowlistAccount(accountId)
      return (await repository.listAllowlistEntries(accountId)).map(mapAllowlistEntry)
    },

    async addAllowlistEntry(accountId, input, operatorId) {
      const normalized = normalizeAllowlistInput(input)
      return repository.transaction(async transaction => {
        const account = await requireAllowlistAccount(accountId, transaction, { mutable: true })
        const entryId = await repository.upsertAllowlistEntry(accountId, normalized, operatorId, transaction)
        const entry = await repository.getAllowlistEntry(accountId, entryId, transaction)
        await repository.writeOperationLog({
          connectionId: account.connection_id,
          accountId: Number(accountId),
          action: 'allowlist_added',
          afterJson: {
            external_user_id: maskIdentifier(normalized.external_user_id),
            label: normalized.label
          },
          operatorId
        }, transaction)
        return mapAllowlistEntry(entry || {
          id: entryId,
          account_id: accountId,
          ...normalized,
          status: 'active'
        })
      })
    },

    async removeAllowlistEntry(accountId, entryId, operatorId) {
      return repository.transaction(async transaction => {
        const account = await requireAllowlistAccount(accountId, transaction, { mutable: true })
        const entry = await repository.getAllowlistEntry(accountId, entryId, transaction)
        if (!entry || entry.status !== 'active') throw new Error('allowlist entry not found')
        await repository.deactivateAllowlistEntry(accountId, entryId, transaction)
        await repository.writeOperationLog({
          connectionId: account.connection_id,
          accountId: Number(accountId),
          action: 'allowlist_removed',
          beforeJson: {
            external_user_id: maskIdentifier(entry.external_user_id),
            label: entry.label || null
          },
          operatorId
        }, transaction)
        return { id: Number(entryId), status: 'inactive' }
      })
    },

    async listOperationLogs(input) {
      const filters = normalizeOperationLogQuery(input)
      const result = await repository.listOperationLogs(filters)
      return {
        items: result.rows.map(row => mapOperationLog(row, repository.parseJson)),
        total: result.total,
        page: filters.page,
        pageSize: filters.page_size
      }
    }
  }
}

module.exports = {
  createPlatformConnectionsService,
  maskIdentifier,
  mapConnection,
  mapAccount,
  mapAllowlistEntry,
  mapOperationLog
}
