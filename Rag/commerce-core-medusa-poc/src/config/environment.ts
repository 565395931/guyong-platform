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

export type MedusaPocEnvironment = Readonly<{
  appEnv: 'dev' | 'test'
  databaseUrl: string
  storeCors: string
  adminCors: string
  authCors: string
  jwtSecret: string
  cookieSecret: string
}>

function required(source: EnvironmentSource, field: string): string {
  const value = source[field]?.trim()
  if (!value) throw new ConfigurationError('CONFIG_MISSING', field, `${field} is required`)
  return value
}

function secret(source: EnvironmentSource, field: string): string {
  const value = required(source, field)
  if (value.length < 32) {
    throw new ConfigurationError('CONFIG_INVALID', field, `${field} must contain at least 32 characters`)
  }
  return value
}

export function loadEnvironment(source: EnvironmentSource): MedusaPocEnvironment {
  const appEnv = required(source, 'APP_ENV')
  if (appEnv === 'production') {
    throw new ConfigurationError(
      'CONFIG_INVALID',
      'APP_ENV',
      'production mode is disabled until the dependency security gate passes',
    )
  }
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new ConfigurationError('CONFIG_INVALID', 'APP_ENV', 'APP_ENV must be dev or test')
  }

  return Object.freeze({
    appEnv,
    databaseUrl: required(source, 'DATABASE_URL'),
    storeCors: required(source, 'STORE_CORS'),
    adminCors: required(source, 'ADMIN_CORS'),
    authCors: required(source, 'AUTH_CORS'),
    jwtSecret: secret(source, 'JWT_SECRET'),
    cookieSecret: secret(source, 'COOKIE_SECRET'),
  })
}
