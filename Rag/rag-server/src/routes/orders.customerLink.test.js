const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const source = readFileSync(__dirname + '/orders.js', 'utf8')

test('orders use the shared authentication contract and stable customer links', () => {
  assert.match(source, /createAuthenticate/)
  assert.doesNotMatch(source, /EFFECTIVE_JWT_SECRET|rag_secret_key_2024_dev_only/)
  assert.match(source, /customer_id/)
  assert.match(source, /resolveCustomerId/)
  assert.match(source, /normalized_account_key/)
  assert.match(source, /customer_scope\.owner_id = :viewerId/)
})
