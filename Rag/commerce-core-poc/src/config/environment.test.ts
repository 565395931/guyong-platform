import { describe, expect, it } from 'vitest'
import { ConfigurationError, loadEnvironment } from './environment'

function validEnvironment() {
  return {
    APP_ENV: 'dev',
    VENDURE_SERVER_PORT: '3050',
    COOKIE_SECRET: 'cookie-secret-with-at-least-32-characters',
    SUPERADMIN_USERNAME: 'admin',
    SUPERADMIN_PASSWORD: 'superadmin-password-with-16-chars',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'vendure_commerce_poc',
    DB_USERNAME: 'vendure_poc',
    DB_PASSWORD: 'database-password',
  }
}

describe('loadEnvironment', () => {
  it('returns a typed immutable configuration', () => {
    const input = validEnvironment()
    const result = loadEnvironment(input)

    input.DB_NAME = 'changed'

    expect(result).toEqual({
      appEnv: 'dev',
      serverPort: 3050,
      cookieSecret: 'cookie-secret-with-at-least-32-characters',
      superadminUsername: 'admin',
      superadminPassword: 'superadmin-password-with-16-chars',
      database: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        name: 'vendure_commerce_poc',
        username: 'vendure_poc',
        password: 'database-password',
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.database)).toBe(true)
  })

  it.each(['COOKIE_SECRET', 'SUPERADMIN_PASSWORD', 'DB_PASSWORD'])('rejects missing secret %s', field => {
    const input = validEnvironment()
    delete input[field as keyof typeof input]

    expect(() => loadEnvironment(input)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_MISSING', field }),
    )
  })

  it('rejects short secrets', () => {
    const input = { ...validEnvironment(), COOKIE_SECRET: 'too-short' }

    expect(() => loadEnvironment(input)).toThrowError(
      new ConfigurationError('CONFIG_INVALID', 'COOKIE_SECRET', 'COOKIE_SECRET must contain at least 32 characters'),
    )
  })

  it('rejects a database name that could alter the connection target', () => {
    const input = { ...validEnvironment(), DB_NAME: 'vendure;drop database rag' }

    expect(() => loadEnvironment(input)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID', field: 'DB_NAME' }),
    )
  })

  it('rejects ports outside the TCP range', () => {
    const input = { ...validEnvironment(), DB_PORT: '70000' }

    expect(() => loadEnvironment(input)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID', field: 'DB_PORT' }),
    )
  })

  it('rejects production mode while the PoC dependency audit is blocked', () => {
    const input = { ...validEnvironment(), APP_ENV: 'production' }

    expect(() => loadEnvironment(input)).toThrowError(
      new ConfigurationError(
        'CONFIG_INVALID',
        'APP_ENV',
        'production mode is disabled until the dependency security gate passes',
      ),
    )
  })
})
