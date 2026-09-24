export type ConfigurationErrorCode = 'CONFIG_MISSING' | 'CONFIG_INVALID'

export class ConfigurationError extends Error {
  constructor(
    public readonly code: ConfigurationErrorCode,
    public readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type CommerceCoreEnvironment = Readonly<{
  appEnv: 'dev' | 'test' | 'production'
  serverPort: number
  cookieSecret: string
  superadminUsername: string
  superadminPassword: string
  database: Readonly<{
    type: 'mysql'
    host: string
    port: number
    name: string
    username: string
    password: string
  }>
}>

function required(source: EnvironmentSource, field: string): string {
  const value = source[field]?.trim()
  if (!value) throw new ConfigurationError('CONFIG_MISSING', field, `${field} is required`)
  return value
}

function port(source: EnvironmentSource, field: string): number {
  const raw = required(source, field)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new ConfigurationError('CONFIG_INVALID', field, `${field} must be an integer between 1 and 65535`)
  }
  return value
}

function minimumLength(value: string, field: string, length: number): string {
  if (value.length < length) {
    throw new ConfigurationError('CONFIG_INVALID', field, `${field} must contain at least ${length} characters`)
  }
  return value
}

export function loadEnvironment(source: EnvironmentSource): CommerceCoreEnvironment {
  const appEnv = required(source, 'APP_ENV')
  if (!['dev', 'test', 'production'].includes(appEnv)) {
    throw new ConfigurationError('CONFIG_INVALID', 'APP_ENV', 'APP_ENV must be dev, test, or production')
  }
  if (appEnv === 'production') {
    throw new ConfigurationError(
      'CONFIG_INVALID',
      'APP_ENV',
      'production mode is disabled until the dependency security gate passes',
    )
  }

  const databaseName = required(source, 'DB_NAME')
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new ConfigurationError('CONFIG_INVALID', 'DB_NAME', 'DB_NAME may contain only letters, digits, and underscores')
  }

  const database = Object.freeze({
    type: 'mysql' as const,
    host: required(source, 'DB_HOST'),
    port: port(source, 'DB_PORT'),
    name: databaseName,
    username: required(source, 'DB_USERNAME'),
    password: required(source, 'DB_PASSWORD'),
  })

  return Object.freeze({
    appEnv: appEnv as CommerceCoreEnvironment['appEnv'],
    serverPort: port(source, 'VENDURE_SERVER_PORT'),
    cookieSecret: minimumLength(required(source, 'COOKIE_SECRET'), 'COOKIE_SECRET', 32),
    superadminUsername: required(source, 'SUPERADMIN_USERNAME'),
    superadminPassword: minimumLength(required(source, 'SUPERADMIN_PASSWORD'), 'SUPERADMIN_PASSWORD', 16),
    database,
  })
}
