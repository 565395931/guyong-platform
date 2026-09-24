const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { normalizeConversationAccountId } = require('./conversationListQuery')

test('normalizes an optional positive conversation account id', () => {
  assert.equal(normalizeConversationAccountId(undefined), null)
  assert.equal(normalizeConversationAccountId(''), null)
  assert.equal(normalizeConversationAccountId('17'), 17)
  assert.equal(normalizeConversationAccountId(['23']), 23)
})

test('rejects invalid conversation account ids', () => {
  for (const value of ['0', '-1', '1.5', 'abc', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeConversationAccountId(value),
      error => error.status === 400 && /account_id/.test(error.message)
    )
  }
})

test('conversation list route applies the normalized account filter', () => {
  const source = readFileSync(require.resolve('../../routes/conversations'), 'utf8')
  assert.match(source, /normalizeConversationAccountId\(account_id\)/)
  assert.match(source, /c\.account_id = :accountId/)
  assert.match(source, /namedReplacements\.accountId = accountId/)
})
