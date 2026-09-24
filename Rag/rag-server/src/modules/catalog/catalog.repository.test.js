const test = require('node:test')
const assert = require('node:assert/strict')
const { createRepository } = require('./catalog.repository')

test('repository upserts products with named replacements', async () => {
  const calls = []
  const repository = createRepository({
    query: async (sql, options = {}) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), options })
      return [[], undefined]
    },
    transaction: async fn => fn({ id: 'tx' })
  })

  const result = await repository.upsertProduct('v1', {
    product_code: 'P1', name: 'Product', description: null, status: 'active'
  })

  assert.equal(result.version_id, 'v1')
  assert.match(calls[0].sql, /INSERT INTO catalog_products/)
  assert.equal(calls[0].options.replacements.product_code, 'P1')
})

test('repository rejects unknown entity names before building SQL', async () => {
  const repository = createRepository({
    query: async () => [[], undefined],
    transaction: async fn => fn({})
  })
  await assert.rejects(() => repository.listVersioned('unknown', 'v1'), /unsupported catalog entity/)
})
