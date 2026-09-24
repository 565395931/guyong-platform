const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeProduct,
  normalizeSku,
  normalizePriceRule,
  normalizeFreightRule
} = require('./catalog.validation')

test('normalizes a product and SKU for storage', () => {
  assert.deepEqual(normalizeProduct({ productCode: ' glass-coating ', name: ' 隔热涂层 ' }), {
    id: undefined,
    product_code: 'GLASS-COATING',
    name: '隔热涂层',
    description: null,
    image_media_id: null,
    image_url: null,
    status: 'active'
  })
  assert.equal(normalizeSku({ productCode: 'glass-coating', skuCode: ' coating-500ml ' }).sku_code, 'COATING-500ML')
})

test('normalizes a tiered USD price rule', () => {
  assert.deepEqual(normalizePriceRule({
    skuCode: 'COATING-500ML',
    customerType: 'retail',
    minQuantity: '1',
    maxQuantity: '',
    unit: 'kg',
    currency: 'usd',
    unitPrice: '200'
  }), {
    id: undefined,
    sku_code: 'COATING-500ML',
    customer_type: 'retail',
    min_quantity: 1,
    max_quantity: null,
    unit: 'kg',
    currency: 'USD',
    unit_price: 200,
    effective_from: null,
    effective_to: null,
    status: 'active'
  })
})

test('rejects invalid price boundaries', () => {
  assert.throws(() => normalizePriceRule({
    skuCode: 'COATING-500ML',
    customerType: 'retail',
    minQuantity: 1,
    maxQuantity: 0,
    unit: 'kg',
    currency: 'USD',
    unitPrice: 0
  }), /maxQuantity must be greater than 0|unitPrice must be greater than 0/)
})

test('normalizes manual freight confirmation', () => {
  assert.deepEqual(normalizeFreightRule({
    regionCode: 'by',
    deliveryTerm: 'ddu',
    baseWeightKg: 0.5,
    currency: 'usd',
    manualConfirmation: true
  }), {
    id: undefined,
    region_code: 'BY',
    delivery_term: 'DDU',
    base_weight_kg: 0.5,
    base_fee: null,
    incremental_weight_kg: null,
    incremental_fee: null,
    currency: 'USD',
    manual_confirmation: true,
    effective_from: null,
    effective_to: null,
    status: 'active'
  })
})
