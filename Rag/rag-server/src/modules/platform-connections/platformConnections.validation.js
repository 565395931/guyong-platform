const PROTECTION_LEVELS = new Set(['locked', 'test', 'none'])

function requiredText(value, field) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function boundedText(value, field, maxLength, { required = true } = {}) {
  const text = String(value || '').trim()
  if (required && !text) throw new Error(`${field} is required`)
  if (text.length > maxLength) throw new Error(`${field} is too long`)
  return text || null
}

function positiveInteger(value, field, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} is invalid`)
  return number
}

function normalizeBoolean(value, field, fallback = false) {
  if (value == null || value === '') return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  throw new Error(`${field} must be boolean`)
}

function normalizeConnectionInput(input = {}, { requireCredentials = true } = {}) {
  const normalized = {
    connection_name: requiredText(input.connectionName || input.connection_name, 'connectionName'),
    channel_code: 'wecom_kf',
    corp_id: requiredText(input.corpId || input.corp_id, 'corpId')
  }

  const credentialFields = [
    ['secret', 'secret'],
    ['callbackToken', 'callback_token'],
    ['encodingAesKey', 'encoding_aes_key']
  ]
  for (const [source, target] of credentialFields) {
    const raw = input[source] ?? input[target]
    if (requireCredentials || raw != null) normalized[target] = requiredText(raw, source)
  }
  return normalized
}

function normalizeAccountPolicy(input = {}) {
  const protectionLevel = String(input.protectionLevel || input.protection_level || 'locked').trim().toLowerCase()
  if (!PROTECTION_LEVELS.has(protectionLevel)) throw new Error('protectionLevel is invalid')
  const aiEnabled = normalizeBoolean(input.aiEnabled ?? input.ai_enabled, 'aiEnabled')
  const allowlistEnabled = normalizeBoolean(input.allowlistEnabled ?? input.allowlist_enabled, 'allowlistEnabled', true)
  if (protectionLevel === 'locked' && aiEnabled) throw new Error('locked account cannot enable AI')
  if (protectionLevel === 'test' && aiEnabled && !allowlistEnabled) throw new Error('test account requires allowlist before enabling AI')
  return {
    protection_level: protectionLevel,
    ai_enabled: aiEnabled,
    allowlist_enabled: allowlistEnabled
  }
}

function normalizeAllowlistInput(input = {}) {
  return {
    external_user_id: boundedText(input.externalUserId ?? input.external_user_id, 'externalUserId', 160),
    label: boundedText(input.label, 'label', 120, { required: false })
  }
}

function normalizeOperationLogQuery(input = {}) {
  const page = positiveInteger(input.page, 'page', 1)
  const requestedPageSize = positiveInteger(input.pageSize ?? input.page_size, 'pageSize', 20)
  const pageSize = Math.min(requestedPageSize, 100)
  const action = boundedText(input.action, 'action', 60, { required: false })
  return {
    connection_id: positiveInteger(input.connectionId ?? input.connection_id, 'connectionId'),
    account_id: positiveInteger(input.accountId ?? input.account_id, 'accountId'),
    action,
    page,
    page_size: pageSize,
    offset: (page - 1) * pageSize
  }
}

module.exports = {
  normalizeConnectionInput,
  normalizeAccountPolicy,
  normalizeAllowlistInput,
  normalizeOperationLogQuery
}
