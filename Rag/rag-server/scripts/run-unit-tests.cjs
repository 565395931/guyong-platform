const { readdirSync, mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

// These tests intentionally use external dependencies or load deployment .env.
// Run them separately against dedicated fixtures; see docs/testing/backend-safe-tests.md.
const excludedTests = new Set([
  'warehouse.mysqlConcurrency.test.js',
  'orderFulfillment.mysql.integration.test.js',
  'customerConversationAuthorization.http.test.js',
  'localParserService.html.test.js'
])

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(file)
      return entry.isFile() && entry.name.endsWith('.test.js') && !excludedTests.has(entry.name) ? [file] : []
    })
    .sort()
}

function createTestEnvironment(source = process.env) {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase()))),
    NODE_ENV: 'test', RUN_REAL_MYSQL: '0',
    JWT_SECRET: 'isolated-unit-test-secret-not-for-deployment',
    DB_HOST: '127.0.0.1', DB_PORT: '9', DB_NAME: 'isolated_unit_tests',
    DB_USER: 'isolated_test', DB_PASSWORD: 'unused-isolated-test-password',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: '9'
  }
}

function buildTestArguments(tests, nodeHelpText = '') {
  const args = ['--test']
  if (nodeHelpText.includes('--test-timeout')) args.push('--test-timeout=30000')
  return [...args, ...tests]
}

function runTests() {
  const tests = collectTests(resolve(__dirname, '../src'))
  const workingDirectory = mkdtempSync(join(tmpdir(), 'rag-unit-tests-'))
  console.log(`Running ${tests.length} source test files; ${excludedTests.size} integration/environment files require separate execution.`)
  try {
    const nodeHelp = spawnSync(process.execPath, ['--help'], { encoding: 'utf8', windowsHide: true })
    if (nodeHelp.error) throw nodeHelp.error
    const result = spawnSync(process.execPath, buildTestArguments(tests, nodeHelp.stdout || ''), {
      cwd: workingDirectory,
      env: createTestEnvironment(),
      stdio: 'inherit',
      windowsHide: true
    })
    if (result.error) throw result.error
    return result.status ?? 1
  } finally {
    // Only the unique directory created above belongs to this test invocation.
    rmSync(workingDirectory, { recursive: true, force: true })
  }
}

if (require.main === module) process.exitCode = runTests()

module.exports = { buildTestArguments, collectTests, createTestEnvironment, runTests }
