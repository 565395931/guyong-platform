const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveQuote, createQuoteService } = require('./quote.service')

const catalog = {
  versionId: 'v1',
  priceRules: [
    { id: 'r1', sku_code: 'COATING-1KG', customer_type: 'retail', min_quantity: 1, max_quantity: 9, currency: 'USD', unit_price: 200 },
    { id: 'r2', sku_code: 'COATING-1KG', customer_type: 'wholesale', min_quantity: 10, max_quantity: 49, currency: 'USD', unit_price: 160 },
    { id: 'r3', sku_code: 'COATING-1KG', customer_type: 'wholesale', min_quantity: 50, max_quantity: null, currency: 'USD', unit_price: 140 }
  ],
  freightRules: [
    { id: 'f-default', region_code: 'DEFAULT', delivery_term: 'OTHER', currency: 'USD', base_weight_kg: 0.5, base_fee: 85, incremental_weight_kg: 0.5, incremental_fee: 15, manual_confirmation: false },
    { id: 'f-us', region_code: 'US', delivery_term: 'OTHER', currency: 'USD', base_weight_kg: 0.5, base_fee: 40, incremental_weight_kg: 0.5, incremental_fee: 10, manual_confirmation: false },
    { id: 'f-by', region_code: 'BY', delivery_term: 'OTHER', currency: 'USD', base_weight_kg: 0.5, base_fee: null, incremental_weight_kg: null, incremental_fee: null, manual_confirmation: true }
  ]
}

test('selects the exact quantity tier and country freight rule', () => {
  const result = resolveQuote({
    skuCode: 'COATING-1KG', quantity: 50, currency: 'USD',
    customerType: 'wholesale', regionCode: 'US', weightKg: 1
  }, catalog)

  assert.equal(result.status, 'quoted')
  assert.equal(result.priceRuleId, 'r3')
  assert.equal(result.freightRuleId, 'f-us')
  assert.equal(result.goodsAmount, 7000)
  assert.equal(result.freightAmount, 50)
  assert.equal(result.totalAmount, 7050)
})

test('never invents a price when no rule matches', () => {
  assert.deepEqual(resolveQuote({
    skuCode: 'UNKNOWN', quantity: 1, currency: 'USD', customerType: 'retail'
  }, catalog), {
    status: 'manual_confirmation',
    reason: 'no_active_price_rule'
  })
})

test('returns manual confirmation when freight is not authoritative', () => {
  const result = resolveQuote({
    skuCode: 'COATING-1KG', quantity: 1, currency: 'USD',
    customerType: 'retail', regionCode: 'BY', weightKg: 0.5
  }, catalog)
  assert.equal(result.status, 'manual_confirmation')
  assert.equal(result.reason, 'freight_requires_confirmation')
  assert.equal(result.priceRuleId, 'r1')
})

test('quote service records outcomes against the published catalog', async () => {
  const records = []
  const service = createQuoteService({
    repository: {
      loadPublishedCatalog: async () => catalog,
      createQuoteRecord: async row => records.push(row)
    }
  })
  const result = await service.resolveAndRecord({
    skuCode: 'COATING-1KG', quantity: 10, currency: 'USD', customerType: 'wholesale'
  }, 9)
  assert.equal(result.priceRuleId, 'r2')
  assert.equal(records[0].createdBy, 9)
})
