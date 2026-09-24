const test = require('node:test')
const assert = require('node:assert/strict')
const { createCatalogService } = require('./catalog.service')

function createFakeRepository(versionStatus = 'draft') {
  const calls = []
  return {
    calls,
    repository: {
      getVersion: async id => ({ id, status: versionStatus }),
      listVersions: async () => [],
      createDraftFromPublished: async () => ({ id: 'draft-1', status: 'draft' }),
      listProducts: async () => [],
      listSkus: async () => [],
      listPriceRules: async () => [],
      listFreightRules: async () => [],
      upsertProduct: async (versionId, input) => ({ id: 'product-1', version_id: versionId, ...input }),
      upsertSku: async (versionId, input) => ({ id: 'sku-1', version_id: versionId, ...input }),
      upsertPriceRule: async (versionId, input) => ({ id: input.id || 'price-1', version_id: versionId, ...input }),
      upsertFreightRule: async (versionId, input) => ({ id: input.id || 'freight-1', version_id: versionId, ...input }),
      transaction: async fn => fn({ id: 'tx' }),
      retirePublished: async tx => calls.push(['retire', tx.id]),
      publishVersion: async (id, userId, tx) => calls.push(['publish', id, userId, tx.id]),
      writeAudit: async row => calls.push(['audit', row.entityType, row.action, row.afterJson])
    }
  }
}

test('publishing a draft retires the old version atomically', async () => {
  const { calls, repository } = createFakeRepository()
  const service = createCatalogService({ repository, now: () => new Date('2026-07-24T00:00:00Z') })

  await service.publishVersion('draft-1', 9)

  assert.deepEqual(calls.map(row => row[0]), ['retire', 'publish', 'audit'])
})

test('published versions cannot be edited', async () => {
  const { repository } = createFakeRepository('published')
  const service = createCatalogService({ repository })
  await assert.rejects(
    () => service.upsertProduct('v1', { productCode: 'P1', name: 'Product' }, 9),
    /draft version/
  )
})

test('price writes are normalized and audited', async () => {
  const { calls, repository } = createFakeRepository()
  const service = createCatalogService({ repository })
  const result = await service.upsertPriceRule('v1', {
    skuCode: 'coat-1kg',
    customerType: 'wholesale',
    minQuantity: '10',
    unit: 'kg',
    currency: 'usd',
    unitPrice: '160'
  }, 9)

  assert.equal(result.sku_code, 'COAT-1KG')
  assert.equal(result.unit_price, 160)
  assert.deepEqual(calls[0].slice(0, 3), ['audit', 'price', 'upsert'])
})
