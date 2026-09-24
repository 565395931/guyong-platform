function firstValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function invalidAccountId() {
  const error = new Error('account_id 参数无效')
  error.status = 400
  return error
}

function normalizeConversationAccountId(rawValue) {
  const value = firstValue(rawValue)
  if (value == null || String(value).trim() === '') return null

  const text = String(value).trim()
  if (!/^[1-9]\d*$/.test(text)) throw invalidAccountId()

  const accountId = Number(text)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw invalidAccountId()
  return accountId
}

module.exports = { normalizeConversationAccountId }
