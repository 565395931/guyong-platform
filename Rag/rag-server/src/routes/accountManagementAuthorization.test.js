const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

function sourceFor(modulePath) {
  return readFileSync(require.resolve(modulePath), 'utf8')
}

test('account-management routes use the database-backed shared authenticator', () => {
  const channelAccounts = sourceFor('./channelAccounts')
  const seatBindings = sourceFor('./seatAccountBindings')
  const platformConnections = sourceFor('../modules/platform-connections/platformConnections.routes')

  for (const source of [channelAccounts, seatBindings, platformConnections]) {
    assert.match(source, /createAuthenticate/)
    assert.doesNotMatch(source, /require\(['"]jsonwebtoken['"]\)/)
  }

  assert.match(seatBindings, /normalizeRole\(seat\.role\)/)
  assert.doesNotMatch(seatBindings, /dev_only/)
})
