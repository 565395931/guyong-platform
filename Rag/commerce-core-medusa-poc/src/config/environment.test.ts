import { describe, expect, it } from 'vitest'
import { ConfigurationError, loadEnvironment } from './environment'

function validEnvironment() {
  return {
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://synthetic.invalid/commerce_core_medusa_poc',
    STORE_CORS: 'http://127.0.0.1:8000',
    ADMIN_CORS: 'http://127.0.0.1:9000',
    AUTH_CORS: 'http://127.0.0.1:9000',
    JWT_SECRET: 'synthetic-jwt-secret-with-32-characters',
    COOKIE_SECRET: 'synthetic-cookie-secret-with-32-characters',
  }
}

describe('loadEnvironment', () => {
  it('returns an immutable validated configuration', () => {
    const input = validEnvironment()
    const result = loadEnvironment(input)

    input.DATABASE_URL = 'changed'

    expect(result.databaseUrl).toBe('postgres://synthetic.invalid/commerce_core_medusa_poc')
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each(['DATABASE_URL', 'STORE_CORS', 'ADMIN_CORS', 'AUTH_CORS', 'JWT_SECRET', 'COOKIE_SECRET'])(
    'rejects missing %s',
    field => {
      const input = validEnvironment()
      delete input[field as keyof typeof input]

      expect(() => loadEnvironment(input)).toThrowError(
        expect.objectContaining<Partial<ConfigurationError>>({ code: 'CONFIG_MISSING', field }),
      )
    },
  )

  it('rejects production mode while the Medusa audit is blocked', () => {
    expect(() => loadEnvironment({ ...validEnvironment(), APP_ENV: 'production' })).toThrowError(
      new ConfigurationError(
        'CONFIG_INVALID',
        'APP_ENV',
        'production mode is disabled until the dependency security gate passes',
      ),
    )
  })

  it('rejects short secrets', () => {
    expect(() => loadEnvironment({ ...validEnvironment(), JWT_SECRET: 'short' })).toThrowError(
      expect.objectContaining<Partial<ConfigurationError>>({ code: 'CONFIG_INVALID', field: 'JWT_SECRET' }),
    )
  })
})
