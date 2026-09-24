const test = require('node:test')
const assert = require('node:assert/strict')
const { ensureCatalogSchema } = require('./catalog.schema')

test('creates every catalog table with idempotent SQL', async () => {
  const statements = []
  await ensureCatalogSchema({
    query: async sql => statements.push(sql.replace(/\s+/g, ' ').trim())
  })

  for (const table of [
    'catalog_versions',
    'catalog_products',
    'catalog_skus',
    'catalog_price_rules',
    'catalog_freight_rules',
    'catalog_import_jobs',
    'catalog_audit_logs',
    'quote_records'
  ]) {
    assert.ok(
      statements.some(sql => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
      `missing ${table}`
    )
  }
})

test('catalog schema declares lookup and uniqueness indexes', async () => {
  const statements = []
  await ensureCatalogSchema({ query: async sql => statements.push(sql) })
  const sql = statements.join('\n')
  assert.match(sql, /uk_catalog_product_version_code/)
  assert.match(sql, /uk_catalog_sku_version_code/)
  assert.match(sql, /image_media_id/)
  assert.match(sql, /image_url/)
  assert.match(sql, /idx_catalog_price_lookup/)
  assert.match(sql, /idx_catalog_freight_lookup/)
})
