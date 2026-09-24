const test = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { buildTestArguments, collectTests, createTestEnvironment } = require('../../scripts/run-unit-tests.cjs')

test('default test discovery is limited to reviewed source tests', () => {
  const sourceRoot = resolve(__dirname, '..')
  const tests = collectTests(sourceRoot)
  assert.ok(tests.length > 100)
  assert.ok(tests.every(file => file.startsWith(sourceRoot) && file.endsWith('.test.js')))
  assert.ok(tests.includes(resolve(__dirname, '../modules/rag/legacyAdmin.routes.test.js')))
  assert.ok(tests.every(file => !/mysqlConcurrency|mysql\.integration|customerConversationAuthorization\.http|localParserService\.html/.test(file)))
})

test('default test process cannot inherit live credentials or enable real MySQL tests', () => {
  const environment = createTestEnvironment({
    PATH: 'test-path', SystemRoot: 'test-system', NODE_ENV: 'production', RUN_REAL_MYSQL: '1',
    DB_PASSWORD: 'live-password', OPENAI_API_KEY: 'live-key', CLOUD_GATEWAY_TOKEN: 'live-token',
    NODE_OPTIONS: '--require dangerous-preload'
  })
  assert.equal(environment.PATH, 'test-path')
  assert.equal(environment.NODE_ENV, 'test')
  assert.equal(environment.RUN_REAL_MYSQL, '0')
  assert.equal(environment.DB_PORT, '9')
  assert.equal(environment.REDIS_PORT, '9')
  assert.notEqual(environment.DB_PASSWORD, 'live-password')
  assert.equal(environment.OPENAI_API_KEY, undefined)
  assert.equal(environment.CLOUD_GATEWAY_TOKEN, undefined)
  assert.equal(environment.NODE_OPTIONS, undefined)
})

test('test timeout flag is enabled only when the installed Node supports it', () => {
  const tests = ['one.test.js']
  assert.deepEqual(buildTestArguments(tests, '  --test-timeout=...'), [
    '--test', '--test-timeout=30000', 'one.test.js'
  ])
  assert.deepEqual(buildTestArguments(tests, '  --test-only'), [
    '--test', 'one.test.js'
  ])
})
