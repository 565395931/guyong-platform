const crypto = require('node:crypto')

const OMIT_VALUE = Symbol('alibaba1688-omit-value')

function signatureInputError(message) {
  const error = new TypeError(message)
  error.code = 'ALIBABA1688_SIGNATURE_INPUT_INVALID'
  return error
}

function normalizeValue(value, ancestors = new Set()) {
  if (value === null || value === undefined) return OMIT_VALUE
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw signatureInputError('1688 parameters must contain finite numbers')
    return value
  }
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw signatureInputError('1688 parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    return value
      .map(item => normalizeValue(item, nextAncestors))
      .filter(item => item !== OMIT_VALUE)
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) throw signatureInputError('1688 parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    const normalized = {}
    for (const key of Object.keys(value).sort()) {
      const item = normalizeValue(value[key], nextAncestors)
      if (item !== OMIT_VALUE) normalized[key] = item
    }
    return normalized
  }

  throw signatureInputError('1688 parameters contain an unsupported value')
}

function compactAlibaba1688Params(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw signatureInputError('1688 parameters must be an object')
  }
  const compacted = {}
  for (const key of Object.keys(params)) {
    const value = normalizeValue(params[key])
    if (value !== OMIT_VALUE) compacted[key] = value
  }
  return compacted
}

function serializeAlibaba1688Value(value) {
  const normalized = normalizeValue(value)
  if (normalized === OMIT_VALUE) return ''
  if (normalized && typeof normalized === 'object') return JSON.stringify(normalized)
  return String(normalized)
}

function buildAlibaba1688Signature(path, params, appSecret) {
  if (typeof path !== 'string' || !path.trim()) {
    throw signatureInputError('1688 API path is required')
  }
  if (typeof appSecret !== 'string' || !appSecret) {
    throw signatureInputError('1688 App Secret is required')
  }

  const compacted = compactAlibaba1688Params(params)
  const canonicalParams = Object.keys(compacted)
    .filter(key => key !== '_aop_signature')
    .sort()
    .map(key => `${key}${serializeAlibaba1688Value(compacted[key])}`)
    .join('')

  return crypto
    .createHmac('sha1', appSecret)
    .update(`${path.trim()}${canonicalParams}`, 'utf8')
    .digest('hex')
    .toUpperCase()
}

module.exports = {
  buildAlibaba1688Signature,
  compactAlibaba1688Params,
  serializeAlibaba1688Value
}
