const CATEGORY_VALUES = new Set(['order', 'after_sales', 'product', 'other'])
const STATUS_VALUES = new Set(['received', 'processed', 'failed'])
const CHANNEL_PATTERN = /^[a-z0-9_]{1,30}$/
const MAX_EVENT_PAYLOAD_BYTES = 128 * 1024
const SENSITIVE_PAYLOAD_KEY = /(credential|token|secret|password|authorization|cookie|api[_-]?key)/i
const PHONE_KEYS = new Set(['phone', 'mobile', 'tel', 'telephone'])
const ADDRESS_KEYS = new Set(['address', 'receiver_address', 'detail_address'])
const IDENTITY_KEYS = new Set(['id_card', 'idcard', 'identity', 'certificate_no', 'cert_no'])
const PERSON_NAME_KEYS = new Set([
  'receiver_name', 'recipient_name', 'consignee_name', 'real_name',
  'buyer_name', 'contact_name'
])
const STRING_PERSON_KEYS = new Set(['receiver', 'recipient', 'consignee'])

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function invalidQuery(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function normalizeBoundedDecimal(name, rawValue, defaultValue, min, max) {
  const value = firstValue(rawValue)
  if (value == null) return defaultValue
  const text = String(value)
  if (!/^(0|[1-9]\d*)$/.test(text)) throw invalidQuery(`${name} 参数无效`)
  const number = Number(text)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidQuery(`${name} 参数无效`)
  }
  return number
}

function normalizeChannelEventQuery(query = {}) {
  const rawChannel = firstValue(query.channel)
  const channel = String(rawChannel == null ? 'douyin' : rawChannel).trim().toLowerCase()
  if (!CHANNEL_PATTERN.test(channel)) throw invalidQuery('channel 参数无效')

  const rawAccountId = firstValue(query.account_id)
  let accountId = null
  if (rawAccountId != null && String(rawAccountId).trim() !== '') {
    accountId = Number.parseInt(String(rawAccountId), 10)
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || String(accountId) !== String(rawAccountId).trim()) {
      throw invalidQuery('account_id 参数无效')
    }
  }

  const normalizeEnum = (name, values) => {
    const raw = firstValue(query[name])
    if (raw == null || String(raw).trim() === '') return null
    const value = String(raw).trim().toLowerCase()
    if (!values.has(value)) throw invalidQuery(`${name} 参数无效`)
    return value
  }
  return {
    channel,
    accountId,
    category: normalizeEnum('category', CATEGORY_VALUES),
    status: normalizeEnum('status', STATUS_VALUES),
    limit: normalizeBoundedDecimal('limit', query.limit, 20, 1, 100),
    offset: normalizeBoundedDecimal('offset', query.offset, 0, 0, 100000)
  }
}

function presentChannelEventSummaryRow(row = {}) {
  const projectionState = row.category !== 'order'
    ? 'not_applicable'
    : Number(row.projection_ready || 0) === 1 ? 'ready' : 'raw_only'
  return {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    accountName: row.account_name || null,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    category: row.category,
    businessKey: row.business_key || null,
    status: row.status,
    occurredAt: row.occurred_at || null,
    receivedAt: row.received_at,
    projectionState
  }
}

function normalizePayloadKey(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function maskPhone(value) {
  const digits = String(value).replace(/\D/g, '')
  return `***${digits.slice(-4)}`
}

function maskEmail(value) {
  const text = String(value)
  const separator = text.lastIndexOf('@')
  if (separator <= 0 || separator === text.length - 1) return `${text.charAt(0)}***`
  return `${text.charAt(0)}***${text.slice(separator)}`
}

function maskAddress(value) {
  return `${Array.from(String(value)).slice(0, 6).join('')}***`
}

function maskIdentity(value) {
  const characters = Array.from(String(value))
  return `${characters.slice(0, 3).join('')}***${characters.slice(-4).join('')}`
}

function maskPersonName(value) {
  const characters = Array.from(String(value))
  return characters.length ? `${characters[0]}${'*'.repeat(Math.max(0, characters.length - 1))}` : ''
}

function hasTerminalPiiToken(key, tokens) {
  return tokens.has(key) || [...tokens].some(token => key.endsWith(`_${token}`))
}

function maskPiiValue(key, value) {
  if (!['string', 'number'].includes(typeof value)) return null
  const normalizedKey = normalizePayloadKey(key)
  if (hasTerminalPiiToken(normalizedKey, PHONE_KEYS)) return maskPhone(value)
  if (normalizedKey === 'email' || normalizedKey.endsWith('_email')) return maskEmail(value)
  if (hasTerminalPiiToken(normalizedKey, ADDRESS_KEYS)) return maskAddress(value)
  if (IDENTITY_KEYS.has(normalizedKey)) return maskIdentity(value)
  if (PERSON_NAME_KEYS.has(normalizedKey) || STRING_PERSON_KEYS.has(normalizedKey)) {
    return maskPersonName(value)
  }
  return null
}

function redactSensitivePayload(value) {
  if (Array.isArray(value)) return value.map(redactSensitivePayload)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    if (SENSITIVE_PAYLOAD_KEY.test(key)) return [key, '[REDACTED]']
    const masked = maskPiiValue(key, nested)
    return [key, masked == null ? redactSensitivePayload(nested) : masked]
  }))
}

function safePayload(payloadJson) {
  let serialized
  if (typeof payloadJson === 'string') serialized = payloadJson
  else {
    try {
      serialized = JSON.stringify(payloadJson == null ? {} : payloadJson)
    } catch {
      return {}
    }
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    return {
      truncated: true,
      reason: 'payload_too_large',
      maxBytes: MAX_EVENT_PAYLOAD_BYTES
    }
  }
  let payload
  try {
    payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson
  } catch {
    return {}
  }
  if (payload == null || typeof payload !== 'object') return {}
  return redactSensitivePayload(payload)
}

function presentChannelEventDetailRow(row = {}) {
  return {
    ...presentChannelEventSummaryRow(row),
    payload: safePayload(row.payload_json)
  }
}

function buildEventWhere(filters) {
  const conditions = ['events.channel = :channel']
  const replacements = { channel: filters.channel }
  if (filters.accountId != null) {
    conditions.push('events.account_id = :accountId')
    replacements.accountId = filters.accountId
  }
  if (filters.category) {
    conditions.push('events.category = :category')
    replacements.category = filters.category
  }
  if (filters.status) {
    conditions.push('events.status = :status')
    replacements.status = filters.status
  }
  return { clause: conditions.join(' AND '), replacements }
}

function applyAccessScope(where, accessScope, { identityColumn, channelColumn }) {
  if (accessScope?.mode === 'all') return where
  if (accessScope?.mode !== 'bound' || !Number.isSafeInteger(accessScope.seatId) || accessScope.seatId <= 0) {
    const error = new Error('事件访问范围无效')
    error.status = 403
    throw error
  }
  where.clause += ` AND EXISTS (
    SELECT 1
     FROM seat_account_bindings AS access_binding
     WHERE access_binding.account_id = ${identityColumn}
       AND access_binding.seat_id = :seatId
       AND access_binding.status = 'active'
       AND access_binding.channel = ${channelColumn}
  )`
  where.replacements.seatId = accessScope.seatId
  return where
}

function createChannelEventInboxRepository(sequelize) {
  return {
    async store(event) {
      const [, metadata] = await sequelize.query(
        `INSERT IGNORE INTO channel_event_inbox
          (channel, account_id, external_event_id, event_type, category, business_key,
           payload_json, status, occurred_at, received_at, updated_at)
         VALUES
          (:channel, :accountId, :externalEventId, :eventType, :category, :businessKey,
           :payloadJson, 'received', :occurredAt, NOW(), NOW())`,
        {
          replacements: {
            channel: event.channel,
            accountId: Number(event.accountId),
            externalEventId: String(event.externalEventId || ''),
            eventType: String(event.eventType || 'unknown'),
            category: String(event.category || 'other'),
            businessKey: event.businessKey == null ? null : String(event.businessKey),
            payloadJson: JSON.stringify(event.payload || {}),
            occurredAt: event.occurredAt || null
          }
        }
      )
      const stored = Number(metadata?.affectedRows || 0) === 1
      return { stored, duplicate: !stored }
    },

    async list(filters, accessScope) {
      const where = applyAccessScope(buildEventWhere(filters), accessScope, {
        identityColumn: 'events.account_id',
        channelColumn: 'events.channel'
      })
      const [rows] = await sequelize.query(
        `SELECT events.id, events.channel, events.account_id, accounts.account_name,
                events.external_event_id, events.event_type, events.category,
                events.business_key, events.status, events.occurred_at,
                events.received_at,
                CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(events.payload_json, '$.projectionCommand.schemaVersion'))='2'
                     THEN 1 ELSE 0 END AS projection_ready
           FROM channel_event_inbox AS events
           LEFT JOIN channel_accounts AS accounts ON accounts.id = events.account_id
          WHERE ${where.clause}
          ORDER BY events.received_at DESC, events.id DESC
          LIMIT :limit OFFSET :offset`,
        { replacements: { ...where.replacements, limit: filters.limit, offset: filters.offset } }
      )
      return rows
    },

    async count(filters, accessScope) {
      const where = applyAccessScope(buildEventWhere(filters), accessScope, {
        identityColumn: 'events.account_id',
        channelColumn: 'events.channel'
      })
      const [rows] = await sequelize.query(
        `SELECT COUNT(*) AS total
           FROM channel_event_inbox AS events
          WHERE ${where.clause}`,
        { replacements: where.replacements }
      )
      return Number(rows[0]?.total || 0)
    },

    async projectionSummary(channel, accessScope) {
      const where = applyAccessScope({
        clause: "events.channel = :channel AND events.category='order'",
        replacements: { channel }
      }, accessScope, {
        identityColumn: 'events.account_id',
        channelColumn: 'events.channel'
      })
      const [rows] = await sequelize.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(events.payload_json, '$.projectionCommand.schemaVersion'))='2'
                         THEN 1 ELSE 0 END) AS ready,
                SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(events.payload_json, '$.projectionCommand.schemaVersion'))='2'
                         THEN 0 ELSE 1 END) AS raw_only
           FROM channel_event_inbox AS events
          WHERE ${where.clause}`,
        { replacements: where.replacements }
      )
      return Object.freeze({
        total: Number(rows[0]?.total || 0),
        ready: Number(rows[0]?.ready || 0),
        rawOnly: Number(rows[0]?.raw_only || 0)
      })
    },

    async detail(eventId, accessScope) {
      const where = applyAccessScope({
        clause: 'events.id = :eventId',
        replacements: { eventId }
      }, accessScope, {
        identityColumn: 'events.account_id',
        channelColumn: 'events.channel'
      })
      const [rows] = await sequelize.query(
        `SELECT events.id, events.channel, events.account_id, accounts.account_name,
                events.external_event_id, events.event_type, events.category,
                events.business_key, events.status, events.occurred_at,
                events.received_at, events.payload_json
           FROM channel_event_inbox AS events
           LEFT JOIN channel_accounts AS accounts ON accounts.id = events.account_id
          WHERE ${where.clause}
          LIMIT 1`,
        { replacements: where.replacements }
      )
      return rows[0] || null
    },

    async listAccountOptions(channel, accessScope) {
      const where = applyAccessScope({
        clause: 'accounts.channel = :channel',
        replacements: { channel }
      }, accessScope, {
        identityColumn: 'accounts.id',
        channelColumn: 'accounts.channel'
      })
      const [rows] = await sequelize.query(
        `SELECT accounts.id, accounts.account_name
           FROM channel_accounts AS accounts
          WHERE ${where.clause}
          ORDER BY accounts.account_name ASC, accounts.id ASC`,
        { replacements: where.replacements }
      )
      return rows.map(row => ({ id: row.id, name: row.account_name }))
    }
  }
}

module.exports = {
  createChannelEventInboxRepository,
  normalizeChannelEventQuery,
  presentChannelEventSummaryRow,
  presentChannelEventDetailRow,
  MAX_EVENT_PAYLOAD_BYTES
}
