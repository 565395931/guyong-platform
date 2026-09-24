class DatabaseConfigurationError extends Error {
  constructor(code, field, message) {
    super(message)
    this.name = 'DatabaseConfigurationError'
    this.code = code
    this.field = field
  }
}

function required(source, field) {
  const value = String(source[field] || '').trim()
  if (!value) throw new DatabaseConfigurationError('CONFIG_MISSING', field, `${field} is required`)
  return value
}

function resolvePort(source, strict) {
  const raw = strict ? required(source, 'DB_PORT') : String(source.DB_PORT || '3306')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new DatabaseConfigurationError('CONFIG_INVALID', 'DB_PORT', 'DB_PORT is invalid')
  }
  return value
}

function resolveName(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new DatabaseConfigurationError('CONFIG_INVALID', 'DB_NAME', 'DB_NAME is invalid')
  }
  return value
}

function resolveDatabaseEnvironment(source = process.env) {
  const strict = source.NODE_ENV === 'production'
  const password = strict ? required(source, 'DB_PASSWORD') : String(source.DB_PASSWORD || '')
  if (strict && password.length < 16) {
    throw new DatabaseConfigurationError('CONFIG_INVALID', 'DB_PASSWORD', 'DB_PASSWORD is too short')
  }
  return Object.freeze({
    host: strict ? required(source, 'DB_HOST') : String(source.DB_HOST || 'localhost'),
    port: resolvePort(source, strict),
    name: resolveName(strict ? required(source, 'DB_NAME') : String(source.DB_NAME || 'rag_customer_service')),
    user: strict ? required(source, 'DB_USER') : String(source.DB_USER || 'root'),
    password
  })
}

function resolveAdminSeedPassword(source = process.env) {
  const password = String(source.ADMIN_SEED_PASSWORD || '')
  if (!password) return null
  if (password.length < 16 || password.length > 128) {
    throw new DatabaseConfigurationError(
      'CONFIG_INVALID',
      'ADMIN_SEED_PASSWORD',
      'ADMIN_SEED_PASSWORD must contain between 16 and 128 characters'
    )
  }
  return password
}

module.exports = {
  DatabaseConfigurationError,
  resolveAdminSeedPassword,
  resolveDatabaseEnvironment
}
