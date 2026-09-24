const { ProjectionLedgerError } = require('@rag/commerce-projection-ledger')

const COMMAND_REF_PATTERN = /^channel_event_inbox:(0|[1-9][0-9]{0,19})$/
const UINT64_MAX = 18446744073709551615n

function invalid(message) {
  throw new ProjectionLedgerError('INVALID_INPUT', message)
}

function parseReference(commandRef) {
  const match = COMMAND_REF_PATTERN.exec(String(commandRef || ''))
  if (!match || BigInt(match[1]) > UINT64_MAX) invalid('Projection command reference is invalid')
  return match[1]
}

function parsePayload(value) {
  try {
    const payload = typeof value === 'string' ? JSON.parse(value) : value
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      invalid('Projection event payload is invalid')
    }
    return payload
  } catch (error) {
    if (error instanceof ProjectionLedgerError) throw error
    invalid('Projection event payload is invalid')
  }
}

function positiveAccountId(value) {
  const accountId = Number(value)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) invalid('Projection event account is invalid')
  return accountId
}

function boundedText(value, field, maximum) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maximum) invalid(`Projection event ${field} is invalid`)
  return text
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function createChannelEventProjectionCommandSource(sequelize) {
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new TypeError('Commerce projection source requires a SQL query executor')
  }

  return Object.freeze({
    async load(commandRef) {
      const eventInboxId = parseReference(commandRef)
      const [rows] = await sequelize.query(
        `SELECT id, channel, account_id, business_key, payload_json
           FROM channel_event_inbox
          WHERE id=:eventInboxId
          LIMIT 1`,
        { replacements: { eventInboxId } }
      )
      const row = rows[0]
      if (!row) invalid('Projection event does not exist')
      const payload = parsePayload(row.payload_json)
      const rawCommand = payload.projectionCommand
      if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
        invalid('Projection event has no normalized command')
      }
      const cloned = structuredClone(rawCommand)
      return deepFreeze({
        ...cloned,
        eventInboxId,
        rawPayloadRef: `channel_event_inbox:${eventInboxId}`,
        channel: boundedText(row.channel, 'channel', 30),
        accountId: positiveAccountId(row.account_id),
        externalOrderId: boundedText(row.business_key, 'business key', 160)
      })
    },

    async listPendingRefs(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError('Commerce projection source limit must be between 1 and 1000')
      }
      const [rows] = await sequelize.query(
        `SELECT events.id
           FROM channel_event_inbox AS events
           LEFT JOIN commerce_projection_jobs AS jobs ON jobs.event_inbox_id=events.id
          WHERE events.category='order'
            AND jobs.id IS NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(events.payload_json, '$.projectionCommand.schemaVersion'))='2'
          ORDER BY events.id
          LIMIT :limit`,
        { replacements: { limit } }
      )
      return Object.freeze(rows.map(row => `channel_event_inbox:${parseReference(`channel_event_inbox:${row.id}`)}`))
    }
  })
}

module.exports = { createChannelEventProjectionCommandSource, parseReference }

