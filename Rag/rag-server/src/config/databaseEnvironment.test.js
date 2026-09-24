const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveAdminSeedPassword,
  resolveDatabaseEnvironment
} = require('./databaseEnvironment')

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DB_HOST: 'db.internal',
    DB_PORT: '3306',
    DB_NAME: 'rag_customer_service',
    DB_USER: 'rag_service',
    DB_PASSWORD: 'database-password-at-least-16',
    ...overrides
  }
}

test('requires production database credentials without embedded fallbacks', () => {
  const environment = productionEnvironment()
  delete environment.DB_PASSWORD

  assert.throws(
    () => resolveDatabaseEnvironment(environment),
    error => error.code === 'CONFIG_MISSING' && error.field === 'DB_PASSWORD'
  )
})

test('validates production database names and ports before SQL construction', () => {
  assert.throws(
    () => resolveDatabaseEnvironment(productionEnvironment({ DB_NAME: 'rag;DROP DATABASE mysql' })),
    error => error.code === 'CONFIG_INVALID' && error.field === 'DB_NAME'
  )
  assert.throws(
    () => resolveDatabaseEnvironment(productionEnvironment({ DB_PORT: '70000' })),
    error => error.code === 'CONFIG_INVALID' && error.field === 'DB_PORT'
  )
})

test('does not seed an administrator unless an explicit strong password is supplied', () => {
  assert.equal(resolveAdminSeedPassword({ NODE_ENV: 'production' }), null)
  assert.throws(
    () => resolveAdminSeedPassword({ NODE_ENV: 'production', ADMIN_SEED_PASSWORD: '111111' }),
    error => error.code === 'CONFIG_INVALID' && error.field === 'ADMIN_SEED_PASSWORD'
  )
  assert.equal(
    resolveAdminSeedPassword({ ADMIN_SEED_PASSWORD: 'one-time-admin-password-strong' }),
    'one-time-admin-password-strong'
  )
})

test('keeps local connection defaults but never supplies a default password', () => {
  assert.deepEqual(resolveDatabaseEnvironment({ NODE_ENV: 'test' }), {
    host: 'localhost',
    port: 3306,
    name: 'rag_customer_service',
    user: 'root',
    password: ''
  })
})

