const crypto = require('node:crypto')

const OMIT_VALUE = Symbol('taobao-omit-value')

function signatureInputError(message) {
  const error = new TypeError(message)
  error.code = 'TAOBAO_SIGNATURE_INPUT_INVALID'
  return error
}

function normalizeValue(value, ancestors = new Set()) {
  if (value === null || value === undefined) return OMIT_VALUE
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw signatureInputError('Taobao parameters must contain finite numbers')
    return value
  }
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw signatureInputError('Taobao parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    return value
      .map(item => normalizeValue(item, nextAncestors))
      .filter(item => item !== OMIT_VALUE)
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) throw signatureInputError('Taobao parameters must not be circular')
    const nextAncestors = new Set(ancestors).add(value)
    const normalized = {}
    for (const key of Object.keys(value).sort()) {
      const item = normalizeValue(value[key], nextAncestors)
      if (item !== OMIT_VALUE) normalized[key] = item
    }
    return normalized
  }

  throw signatureInputError('Taobao parameters contain an unsupported value')
}

function compactTaobaoParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw signatureInputError('Taobao parameters must be an object')
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

function buildTaobaoSign(params, appSecret) {
  if (typeof appSecret !== 'string' || !appSecret) {
    throw signatureInputError('Taobao App Secret is required')
  }

  const compacted = compactTaobaoParams(params)
  const canonical = Object.keys(compacted)
    .filter(key => key !== 'sign')
    .sort()
    .map(key => `${key}${serializeValue(compacted[key])}`)
    .join('')

  return crypto
    .createHash('md5')
    .update(`${appSecret}${canonical}${appSecret}`, 'utf8')
    .digest('hex')
    .toUpperCase()
}

module.exports = {
  buildTaobaoSign,
  compactTaobaoParams,
  serializeValue
}
