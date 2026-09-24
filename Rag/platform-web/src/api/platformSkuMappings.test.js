import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('platform SKU mapping client exposes scoped list and status operations', () => {
  const source = readFileSync(fileURLToPath(new URL('./platformSkuMappings.js', import.meta.url)), 'utf8')
  assert.match(source, /platform-sku-mappings/)
  assert.match(source, /patch\(`/)
})
