const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const source = readFileSync(__dirname + '/customers.js', 'utf8')

test('customer routes use the shared authentication middleware without a fallback secret', () => {
  assert.match(source, /createAuthenticate/)
  assert.doesNotMatch(source, /EFFECTIVE_JWT_SECRET|rag_secret_key_2024_dev_only/)
})

test('customer update applies object-level visibility to the update statement', () => {
  const updateBlock = source.match(/router\.put\('\/:id',[\s\S]*?router\.delete\('\/:id'/)?.[0] || ''
  assert.match(updateBlock, /customerVisibility\(req, 'c'\)/)
  assert.match(updateBlock, /WHERE c?\.?id = :id AND \$\{visibility\.sql\}/)
  assert.match(updateBlock, /visibility\.replacements/)
})

test('customer delete keeps object visibility on the final delete statement', () => {
  const deleteBlock = source.match(/router\.delete\('\/:id',[\s\S]*?module\.exports/)?.[0] || ''
  assert.match(deleteBlock, /DELETE c FROM customers c/)
  assert.match(deleteBlock, /WHERE c\.id = :id AND \$\{visibility\.sql\}/)
  assert.match(deleteBlock, /visibility\.replacements/)
})
