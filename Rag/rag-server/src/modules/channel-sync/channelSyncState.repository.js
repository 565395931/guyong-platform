const RESOURCE_VALUES = new Set(['order', 'after_sales'])
const CHANNEL_PATTERN = /^[a-z0-9_]{1,30}$/

function validateIdentity({ channel, accountId, resource }) {
  const normalizedChannel = String(channel || '').trim().toLowerCase()
  const normalizedAccountId = Number(accountId)
  const normalizedResource = String(resource || '').trim().toLowerCase()
  if (!CHANNEL_PATTERN.test(normalizedChannel)) throw new TypeError('channel is invalid')
  if (!Number.isSafeInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    throw new TypeError('accountId is invalid')
  }
  if (!RESOURCE_VALUES.has(normalizedResource)) throw new TypeError('resource is invalid')
  return {
    channel: normalizedChannel,
    accountId: normalizedAccountId,
    resource: normalizedResource
  }
}

function toEpochSeconds(value, fieldName) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  const timestamp = value instanceof Date
    ? value.getTime()
    : Date.parse(typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value)
  if (!Number.isFinite(timestamp)) throw new TypeError(`${fieldName} is invalid`)
  return Math.floor(timestamp / 1000)
}

function presentState(row) {
  if (!row) return null
  return {
    channel: row.channel,
    accountId: Number(row.account_id),
    resource: row.resource,
    cursorAt: toEpochSeconds(row.cursor_at, 'cursor_at'),
    failureCount: Number(row.failure_count || 0),
    lastAttemptAt: row.last_attempt_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorCode: row.last_error_code || null
  }
}

function safeErrorCode(value) {
  const code = String(value || 'SYNC_FAILED').trim()
  return /^[A-Za-z0-9_:-]{1,100}$/.test(code) ? code : 'SYNC_FAILED'
}

function createChannelSyncStateRepository(sequelize) {
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new TypeError('sequelize query dependency is required')
  }

  return {
    async getOrCreate(input) {
      const identity = validateIdentity(input)
      const initialCursorAt = toEpochSeconds(input.initialCursorAt, 'initialCursorAt')
      await sequelize.query(
        `INSERT INTO channel_sync_state
           (channel, account_id, resource, cursor_at, created_at, updated_at)
         VALUES
           (:channel, :accountId, :resource, FROM_UNIXTIME(:initialCursorAt), NOW(), NOW())
         ON DUPLICATE KEY UPDATE account_id = VALUES(account_id)`,
        { replacements: { ...identity, initialCursorAt } }
      )
      const [rows] = await sequelize.query(
        `SELECT channel, account_id, resource, cursor_at, failure_count,
                last_attempt_at, last_success_at, last_error_code
           FROM channel_sync_state
          WHERE channel = :channel
            AND account_id = :accountId
            AND resource = :resource
          LIMIT 1`,
        { replacements: identity }
      )
      if (!rows[0]) throw new Error('channel sync state could not be loaded')
      return presentState(rows[0])
    },

    async markSuccess(input) {
      const identity = validateIdentity(input)
      const cursorAt = toEpochSeconds(input.cursorAt, 'cursorAt')
      await sequelize.query(
        `UPDATE channel_sync_state
            SET cursor_at = FROM_UNIXTIME(:cursorAt),
                last_attempt_at = NOW(),
                last_success_at = NOW(),
                failure_count = 0,
                last_error_code = NULL,
                updated_at = NOW()
          WHERE channel = :channel
            AND account_id = :accountId
            AND resource = :resource`,
        { replacements: { ...identity, cursorAt } }
      )
    },

    async markFailure(input) {
      const identity = validateIdentity(input)
      await sequelize.query(
        `UPDATE channel_sync_state
            SET last_attempt_at = NOW(),
                failure_count = failure_count + 1,
                last_error_code = :errorCode,
                updated_at = NOW()
          WHERE channel = :channel
            AND account_id = :accountId
            AND resource = :resource`,
        { replacements: { ...identity, errorCode: safeErrorCode(input.errorCode) } }
      )
    }
  }
}

module.exports = {
  RESOURCE_VALUES,
  createChannelSyncStateRepository
}
