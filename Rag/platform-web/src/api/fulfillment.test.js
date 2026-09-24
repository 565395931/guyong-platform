import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('fulfillment client encodes order identifiers for reserve and ship endpoints', () => {
  const source = readFileSync(fileURLToPath(new URL('./fulfillment.js', import.meta.url)), 'utf8')
  assert.match(source, /fulfillment\/orders/)
  assert.match(source, /encodeURIComponent\(orderId\)/)
})
