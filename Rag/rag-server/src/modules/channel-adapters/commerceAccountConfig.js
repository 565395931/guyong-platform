const { decrypt } = require('../../shared/utils/encrypt')

function createCommerceAccountConfig({ adapterType, errorCode, requiredFields, logName }) {
  const fields = Object.freeze([...requiredFields])
  const clean = value => typeof value === 'string' ? value.trim() : ''

  function normalize(config = {}) {
    const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
    return Object.fromEntries(fields.map(field => [field, clean(source[field])]))
  }

  function validate(config = {}) {
    const normalized = normalize(config)
    const missing = fields.filter(field => !normalized[field])
    if (missing.length) {
      const error = new TypeError(`${logName} account config requires: ${missing.join(', ')}`)
      error.code = errorCode
      error.fields = missing
      throw error
    }
    return normalized
  }

  function hasComplete(config = {}) {
    const normalized = normalize(config)
    return fields.every(field => Boolean(normalized[field]))
  }

  function parse(rawConfig, source = 'unknown') {
    if (!rawConfig) return normalize()
    if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) return normalize(rawConfig)
    if (typeof rawConfig !== 'string') return normalize()

    try {
      return normalize(JSON.parse(rawConfig))
    } catch {
      // Persisted account configs are normally encrypted.
    }

    try {
      return normalize(decrypt(rawConfig))
    } catch (error) {
      console.error(`[${logName}AccountConfig] Failed to decrypt ${source}: ${error.message}`)
      return normalize()
    }
  }

  function prepare(input = {}) {
    return { adapterType, config: validate(input.config) }
  }

  return { normalize, validate, hasComplete, parse, prepare }
}

module.exports = { createCommerceAccountConfig }
