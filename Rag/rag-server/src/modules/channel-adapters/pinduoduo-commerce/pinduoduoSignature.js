const crypto = require('node:crypto')

const OMIT_VALUE = Symbol('pinduoduo-omit-value')

function signatureInputError(message) {
  const error = new TypeError(message)
  error.code = 'PINDUODUO_SIGNATURE_INPUT_INVALID'
  return error
}

function normalizeValue(value, ancestors = new Set()) {
  if (value === null || value === undefined) return OMIT_VALUE
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw signatureInputError('Pinduoduo parameters must contain finite numbers')
    return value
  }
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw signatureInputError('Pinduoduo parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    return value
      .map(item => normalizeValue(item, nextAncestors))
      .filter(item => item !== OMIT_VALUE)
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) throw signatureInputError('Pinduoduo parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    const normalized = {}
    for (const key of Object.keys(value).sort()) {
      const item = normalizeValue(value[key], nextAncestors)
      if (item !== OMIT_VALUE) normalized[key] = item
    }
    return normalized
  }

  throw signatureInputError('Pinduoduo parameters contain an unsupported value')
}

function compactPinduoduoParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw signatureInputError('Pinduoduo parameters must be an object')
  }

  const compacted = {}
  for (const key of Object.keys(params)) {
    const value = normalizeValue(params[key])
    if (value !== OMIT_VALUE) compacted[key] = value
  }
  return compacted
}

function serializeValue(value) {
  const normalized = normalizeValue(value)
  if (normalized === OMIT_VALUE) return ''
  if (normalized && typeof normalized === 'object') return JSON.stringify(normalized)
  return String(normalized)
}

function buildPinduoduoSign(params, clientSecret) {
  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw signatureInputError('Pinduoduo client secret is required')
  }

  const compacted = compactPinduoduoParams(params)
  const canonical = Object.keys(compacted)
    .filter(key => key !== 'sign' && key !== 'client_secret')
    .sort()
    .map(key => `${key}${serializeValue(compacted[key])}`)
    .join('')

  return crypto
    .createHash('md5')
    .update(`${clientSecret}${canonical}${clientSecret}`, 'utf8')
    .digest('hex')
    .toUpperCase()
}

module.exports = {
  buildPinduoduoSign,
  compactPinduoduoParams,
  serializeValue
}
