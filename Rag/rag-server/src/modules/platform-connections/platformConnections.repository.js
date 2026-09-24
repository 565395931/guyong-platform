const { QueryTypes } = require('sequelize')

function parseJson(value) {
  if (value == null || typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function createPlatformConnectionsRepository(sequelize) {
  return {
    transaction: fn => sequelize.transaction(fn),

    async listConnections() {
      const [rows] = await sequelize.query(
        `SELECT id,channel_code,connection_name,corp_id,callback_key,status,health_status,health_message,
                account_count,config_version,last_token_refresh_at,last_callback_at,last_sync_at,
                created_by,updated_by,created_at,updated_at
         FROM platform_connections ORDER BY created_at DESC`
      )
      return rows
    },

    async getConnection(id, { includeCredentials = false, transaction } = {}) {
      const credentialColumn = includeCredentials ? ',credential_ciphertext' : ''
      const [rows] = await sequelize.query(
        `SELECT id,channel_code,connection_name,corp_id,callback_key,status,health_status,
                health_message,account_count,config_version,last_token_refresh_at,last_callback_at,
                last_sync_at,created_by,updated_by,created_at,updated_at${credentialColumn}
         FROM platform_connections WHERE id=:id LIMIT 1`,
        { replacements: { id }, transaction }
      )
      return rows[0] || null
    },

    async findByCorpId(channelCode, corpId, transaction) {
      const [rows] = await sequelize.query(
        'SELECT id FROM platform_connections WHERE channel_code=:channelCode AND corp_id=:corpId LIMIT 1',
        { replacements: { channelCode, corpId }, transaction }
      )
      return rows[0] || null
    },

    async createConnection(row, transaction) {
      const [id] = await sequelize.query(
        `INSERT INTO platform_connections
         (channel_code,connection_name,corp_id,credential_ciphertext,callback_key,status,
          health_status,created_by,updated_by)
         VALUES ('wecom_kf',:connectionName,:corpId,:credentialCiphertext,:callbackKey,'draft',
                 'unknown',:createdBy,:createdBy)`,
        {
          replacements: row,
          type: QueryTypes.INSERT,
          transaction
        }
      )
      return id
    },

    async replaceCredentials(id, credentialCiphertext, operatorId, transaction) {
      await sequelize.query(
        `UPDATE platform_connections
         SET credential_ciphertext=:credentialCiphertext,config_version=config_version+1,
             status='draft',health_status='unknown',health_message=NULL,updated_by=:operatorId
         WHERE id=:id`,
        { replacements: { id, credentialCiphertext, operatorId }, transaction }
      )
    },

    async updateConnectionStatus(id, input, transaction) {
      const allowed = {
        status: 'status',
        healthStatus: 'health_status',
        healthMessage: 'health_message',
        accountCount: 'account_count',
        lastTokenRefreshAt: 'last_token_refresh_at',
        lastCallbackAt: 'last_callback_at',
        lastSyncAt: 'last_sync_at',
        updatedBy: 'updated_by'
      }
      const assignments = []
      const replacements = { id }
      for (const [source, column] of Object.entries(allowed)) {
        if (Object.prototype.hasOwnProperty.call(input, source)) {
          assignments.push(`${column}=:${source}`)
          replacements[source] = input[source]
        }
      }
      if (!assignments.length) return
      await sequelize.query(
        `UPDATE platform_connections SET ${assignments.join(',')},updated_at=NOW() WHERE id=:id`,
        { replacements, transaction }
      )
    },

    async listAccounts(connectionId) {
      const [rows] = await sequelize.query(
        `SELECT id,connection_id,channel,account_name,external_account_id,avatar_url,status,
                protection_level,locked_reason,ai_enabled,allowlist_enabled,sync_status,
                last_inbound_at,last_outbound_at,created_at,updated_at
         FROM channel_accounts WHERE connection_id=:connectionId ORDER BY account_name ASC`,
        { replacements: { connectionId } }
      )
      return rows
    },

    async listActiveAllowlist(accountId) {
      const [rows] = await sequelize.query(
        `SELECT external_user_id FROM channel_account_allowlists
         WHERE account_id=:accountId AND status='active' ORDER BY id ASC`,
        { replacements: { accountId } }
      )
      return rows.map(row => row.external_user_id)
    },

    async listAllowlistEntries(accountId) {
      const [rows] = await sequelize.query(
        `SELECT id,account_id,external_user_id,label,status,created_by,created_at,updated_at
         FROM channel_account_allowlists
         WHERE account_id=:accountId AND status='active' ORDER BY created_at DESC,id DESC`,
        { replacements: { accountId } }
      )
      return rows
    },

    async getAllowlistEntry(accountId, entryId, transaction) {
      const [rows] = await sequelize.query(
        `SELECT id,account_id,external_user_id,label,status,created_by,created_at,updated_at
         FROM channel_account_allowlists WHERE id=:entryId AND account_id=:accountId LIMIT 1`,
        { replacements: { accountId, entryId }, transaction }
      )
      return rows[0] || null
    },

    async upsertAllowlistEntry(accountId, input, operatorId, transaction) {
      const [id] = await sequelize.query(
        `INSERT INTO channel_account_allowlists
         (account_id,external_user_id,label,status,created_by)
         VALUES (:accountId,:externalUserId,:label,'active',:operatorId)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),label=VALUES(label),status='active',
                 created_by=VALUES(created_by),updated_at=NOW()`,
        {
          replacements: {
            accountId,
            externalUserId: input.external_user_id,
            label: input.label || null,
            operatorId
          },
          type: QueryTypes.INSERT,
          transaction
        }
      )
      return Number(id)
    },

    async deactivateAllowlistEntry(accountId, entryId, transaction) {
      await sequelize.query(
        `UPDATE channel_account_allowlists SET status='inactive',updated_at=NOW()
         WHERE id=:entryId AND account_id=:accountId`,
        { replacements: { accountId, entryId }, transaction }
      )
    },

    async reserveConfigVersion(id, operatorId, transaction) {
      await sequelize.query(
        `UPDATE platform_connections
         SET config_version=config_version+1,updated_by=:operatorId,updated_at=NOW()
         WHERE id=:id`,
        { replacements: { id, operatorId }, transaction }
      )
      const [rows] = await sequelize.query(
        'SELECT config_version FROM platform_connections WHERE id=:id LIMIT 1',
        { replacements: { id }, transaction }
      )
      if (!rows[0]) throw new Error('platform connection not found')
      return Number(rows[0].config_version)
    },

    async getAccount(accountId, transaction) {
      const [rows] = await sequelize.query(
        `SELECT id,connection_id,channel,account_name,external_account_id,status,
                protection_level,locked_reason,ai_enabled,allowlist_enabled,sync_status
         FROM channel_accounts WHERE id=:accountId LIMIT 1`,
        { replacements: { accountId }, transaction }
      )
      return rows[0] || null
    },

    async upsertWecomAccounts(connectionId, accounts, transaction) {
      await sequelize.query(
        "UPDATE channel_accounts SET sync_status='missing' WHERE connection_id=:connectionId AND channel='wecom_kf'",
        { replacements: { connectionId }, transaction }
      )
      for (const account of accounts) {
        await sequelize.query(
          `INSERT INTO channel_accounts
           (channel,account_name,config,status,adapter_type,connection_id,external_account_id,
            avatar_url,protection_level,locked_reason,ai_enabled,allowlist_enabled,sync_status,
            created_at,updated_at)
           VALUES ('wecom_kf',:name,'{}','active','wecom_official',:connectionId,:externalAccountId,
                   :avatar,:protectionLevel,:lockedReason,0,1,'synced',NOW(),NOW())
           ON DUPLICATE KEY UPDATE account_name=VALUES(account_name),avatar_url=VALUES(avatar_url),
                   status='active',adapter_type='wecom_official',sync_status='synced',
                   locked_reason=CASE WHEN VALUES(locked_reason)='production_baseline'
                     THEN 'production_baseline' ELSE locked_reason END,
                   protection_level=CASE WHEN VALUES(locked_reason)='production_baseline'
                     THEN 'locked' ELSE protection_level END,
                   ai_enabled=CASE WHEN VALUES(locked_reason)='production_baseline'
                     THEN 0 ELSE ai_enabled END,
                   allowlist_enabled=CASE WHEN VALUES(locked_reason)='production_baseline'
                     THEN 1 ELSE allowlist_enabled END,
                   updated_at=NOW()`,
          {
            replacements: {
              connectionId,
              externalAccountId: account.externalAccountId,
              name: account.name,
              avatar: account.avatar || null,
              protectionLevel: account.protectionLevel || 'locked',
              lockedReason: account.lockedReason || null
            },
            transaction
          }
        )
      }
    },

    async updateAccountPolicy(accountId, policy, transaction) {
      await sequelize.query(
        `UPDATE channel_accounts
         SET protection_level=:protectionLevel,ai_enabled=:aiEnabled,
             allowlist_enabled=:allowlistEnabled,updated_at=NOW()
         WHERE id=:accountId`,
        {
          replacements: {
            accountId,
            protectionLevel: policy.protection_level,
            aiEnabled: policy.ai_enabled ? 1 : 0,
            allowlistEnabled: policy.allowlist_enabled ? 1 : 0
          },
          transaction
        }
      )
    },

    async markWecomInbound({ connectionId, accountId, occurredAt }, transaction) {
      const timestamp = occurredAt || new Date()
      await sequelize.query(
        `UPDATE platform_connections
         SET health_status='healthy',
             health_message=NULL,
             last_callback_at=:timestamp,
             last_sync_at=:timestamp,
             updated_at=NOW()
         WHERE id=:connectionId AND channel_code='wecom_kf'`,
        { replacements: { connectionId: Number(connectionId), timestamp }, transaction }
      )
      await sequelize.query(
        `UPDATE channel_accounts
         SET last_inbound_at=:timestamp,
             sync_status='synced',
             updated_at=NOW()
         WHERE id=:accountId AND channel='wecom_kf'`,
        { replacements: { accountId: Number(accountId), timestamp }, transaction }
      )
    },

    async markWecomOutbound({ accountId, occurredAt }, transaction) {
      const timestamp = occurredAt || new Date()
      await sequelize.query(
        `UPDATE channel_accounts
         SET last_outbound_at=:timestamp,
             updated_at=NOW()
         WHERE id=:accountId AND channel='wecom_kf'`,
        { replacements: { accountId: Number(accountId), timestamp }, transaction }
      )
    },

    async writeOperationLog(row, transaction) {
      await sequelize.query(
        `INSERT INTO channel_operation_logs
         (connection_id,account_id,action,before_json,after_json,operator_id)
         VALUES (:connectionId,:accountId,:action,:beforeJson,:afterJson,:operatorId)`,
        {
          replacements: {
            connectionId: row.connectionId || null,
            accountId: row.accountId || null,
            action: row.action,
            beforeJson: row.beforeJson ? JSON.stringify(row.beforeJson) : null,
            afterJson: row.afterJson ? JSON.stringify(row.afterJson) : null,
            operatorId: row.operatorId || null
          },
          transaction
        }
      )
    },

    async listOperationLogs(filters) {
      const conditions = ['1=1']
      const replacements = { limit: filters.page_size, offset: filters.offset }
      if (filters.connection_id) {
        conditions.push('l.connection_id=:connectionId')
        replacements.connectionId = filters.connection_id
      }
      if (filters.account_id) {
        conditions.push('l.account_id=:accountId')
        replacements.accountId = filters.account_id
      }
      if (filters.action) {
        conditions.push('l.action=:action')
        replacements.action = filters.action
      }
      const where = conditions.join(' AND ')
      const [rows] = await sequelize.query(
        `SELECT l.id,l.connection_id,l.account_id,l.action,l.before_json,l.after_json,
                l.operator_id,l.created_at,p.connection_name,a.account_name,u.username AS operator_name
         FROM channel_operation_logs l
         LEFT JOIN platform_connections p ON p.id=l.connection_id
         LEFT JOIN channel_accounts a ON a.id=l.account_id
         LEFT JOIN users u ON u.id=l.operator_id
         WHERE ${where}
         ORDER BY l.created_at DESC,l.id DESC LIMIT :limit OFFSET :offset`,
        { replacements }
      )
      const [countRows] = await sequelize.query(
        `SELECT COUNT(*) AS total FROM channel_operation_logs l WHERE ${where}`,
        { replacements }
      )
      return { rows, total: Number(countRows[0]?.total || 0) }
    },

    parseJson
  }
}

module.exports = { createPlatformConnectionsRepository }
