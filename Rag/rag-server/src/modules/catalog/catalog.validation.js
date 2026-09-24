const { CUSTOMER_TYPES, DELIVERY_TERMS, UNITS } = require('./catalog.constants')

function requiredText(value, field) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function optionalText(value) {
  const text = String(value || '').trim()
  return text || null
}

function positiveNumber(value, field, nullable = false) {
  if ((value === '' || value == null) && nullable) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be greater than 0`)
  }
  return number
}

function optionalPositiveNumber(value, field) {
  return positiveNumber(value, field, true)
}

function normalizeProduct(input = {}) {
  return {
    id: input.id || undefined,
    product_code: requiredText(input.productCode || input.product_code, 'productCode').toUpperCase(),
    name: requiredText(input.name, 'name'),
    description: optionalText(input.description),
    image_media_id: optionalText(input.imageMediaId || input.image_media_id),
    image_url: optionalText(input.imageUrl || input.image_url),
    status: input.status || 'active'
  }
}

function normalizeSku(input = {}) {
  return {
    id: input.id || undefined,
    product_code: requiredText(input.productCode || input.product_code, 'productCode').toUpperCase(),
    sku_code: requiredText(input.skuCode || input.sku_code, 'skuCode').toUpperCase(),
    specification: optionalText(input.specification),
    packaging: optionalText(input.packaging),
    weight_kg: optionalPositiveNumber(input.weightKg ?? input.weight_kg, 'weightKg'),
    coverage_min_sqm: optionalPositiveNumber(input.coverageMinSqm ?? input.coverage_min_sqm, 'coverageMinSqm'),
    coverage_max_sqm: optionalPositiveNumber(input.coverageMaxSqm ?? input.coverage_max_sqm, 'coverageMaxSqm'),
    status: input.status || 'active'
  }
}

function normalizePriceRule(input = {}) {
  const customerType = String(input.customerType || input.customer_type || 'all').toLowerCase()
  const unit = String(input.unit || '').toLowerCase()
  if (!CUSTOMER_TYPES.has(customerType)) throw new Error('customerType is invalid')
  if (!UNITS.has(unit)) throw new Error('unit is invalid')

  const minQuantity = positiveNumber(input.minQuantity ?? input.min_quantity, 'minQuantity')
  const maxQuantity = optionalPositiveNumber(input.maxQuantity ?? input.max_quantity, 'maxQuantity')
  if (maxQuantity !== null && maxQuantity < minQuantity) {
    throw new Error('maxQuantity must not be less than minQuantity')
  }

  return {
    id: input.id || undefined,
    sku_code: requiredText(input.skuCode || input.sku_code, 'skuCode').toUpperCase(),
    customer_type: customerType,
    min_quantity: minQuantity,
    max_quantity: maxQuantity,
    unit,
    currency: requiredText(input.currency, 'currency').toUpperCase(),
    unit_price: positiveNumber(input.unitPrice ?? input.unit_price, 'unitPrice'),
    effective_from: input.effectiveFrom || input.effective_from || null,
    effective_to: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

function normalizeFreightRule(input = {}) {
  const deliveryTerm = String(input.deliveryTerm || input.delivery_term || 'OTHER').toUpperCase()
  if (!DELIVERY_TERMS.has(deliveryTerm)) throw new Error('deliveryTerm is invalid')

  return {
    id: input.id || undefined,
    region_code: requiredText(input.regionCode || input.region_code, 'regionCode').toUpperCase(),
    delivery_term: deliveryTerm,
    base_weight_kg: positiveNumber(input.baseWeightKg ?? input.base_weight_kg, 'baseWeightKg'),
    base_fee: optionalPositiveNumber(input.baseFee ?? input.base_fee, 'baseFee'),
    incremental_weight_kg: optionalPositiveNumber(input.incrementalWeightKg ?? input.incremental_weight_kg, 'incrementalWeightKg'),
    incremental_fee: optionalPositiveNumber(input.incrementalFee ?? input.incremental_fee, 'incrementalFee'),
    currency: requiredText(input.currency, 'currency').toUpperCase(),
    manual_confirmation: input.manualConfirmation === true || input.manual_confirmation === true,
    effective_from: input.effectiveFrom || input.effective_from || null,
    effective_to: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

module.exports = {
  normalizeProduct,
  normalizeSku,
  normalizePriceRule,
  normalizeFreightRule
}
