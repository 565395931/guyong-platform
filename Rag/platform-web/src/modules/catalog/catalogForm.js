const optionalNumber = value => value === '' || value == null ? null : Number(value)

export function normalizeProductForm(input = {}) {
  return {
    id: input.id || undefined,
    productCode: String(input.productCode || input.product_code || '').trim().toUpperCase(),
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim() || null,
    status: input.status || 'active'
  }
}

export function normalizeSkuForm(input = {}) {
  return {
    id: input.id || undefined,
    productCode: String(input.productCode || input.product_code || '').trim().toUpperCase(),
    skuCode: String(input.skuCode || input.sku_code || '').trim().toUpperCase(),
    specification: String(input.specification || '').trim() || null,
    packaging: String(input.packaging || '').trim() || null,
    weightKg: optionalNumber(input.weightKg ?? input.weight_kg),
    coverageMinSqm: optionalNumber(input.coverageMinSqm ?? input.coverage_min_sqm),
    coverageMaxSqm: optionalNumber(input.coverageMaxSqm ?? input.coverage_max_sqm),
    status: input.status || 'active'
  }
}

export function normalizePriceForm(input = {}) {
  return {
    id: input.id || undefined,
    skuCode: String(input.skuCode || input.sku_code || '').trim().toUpperCase(),
    minQuantity: Number(input.minQuantity ?? input.min_quantity),
    maxQuantity: optionalNumber(input.maxQuantity ?? input.max_quantity),
    unitPrice: Number(input.unitPrice ?? input.unit_price),
    currency: String(input.currency || '').trim().toUpperCase(),
    unit: String(input.unit || '').trim().toLowerCase(),
    customerType: String(input.customerType || input.customer_type || 'all').trim().toLowerCase(),
    effectiveFrom: input.effectiveFrom || input.effective_from || null,
    effectiveTo: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

export function validatePriceForm(input = {}) {
  const errors = []
  if (!String(input.skuCode || input.sku_code || '').trim()) errors.push('SKU 不能为空')
  if (!(Number(input.minQuantity ?? input.min_quantity) > 0)) errors.push('起订数量必须大于 0')
  if (!(Number(input.unitPrice ?? input.unit_price) > 0)) errors.push('单价必须大于 0')
  if (!String(input.currency || '').trim()) errors.push('币种不能为空')
  if (!String(input.unit || '').trim()) errors.push('单位不能为空')
  return errors
}

export function normalizeFreightForm(input = {}) {
  return {
    id: input.id || undefined,
    regionCode: String(input.regionCode || input.region_code || '').trim().toUpperCase(),
    deliveryTerm: String(input.deliveryTerm || input.delivery_term || 'OTHER').trim().toUpperCase(),
    baseWeightKg: Number(input.baseWeightKg ?? input.base_weight_kg),
    baseFee: optionalNumber(input.baseFee ?? input.base_fee),
    incrementalWeightKg: optionalNumber(input.incrementalWeightKg ?? input.incremental_weight_kg),
    incrementalFee: optionalNumber(input.incrementalFee ?? input.incremental_fee),
    currency: String(input.currency || '').trim().toUpperCase(),
    manualConfirmation: input.manualConfirmation === true || Boolean(input.manual_confirmation),
    effectiveFrom: input.effectiveFrom || input.effective_from || null,
    effectiveTo: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

export function validateFreightForm(input = {}) {
  const errors = []
  if (!String(input.regionCode || input.region_code || '').trim()) errors.push('国家或区域编码不能为空')
  if (!(Number(input.baseWeightKg ?? input.base_weight_kg) > 0)) errors.push('首重必须大于 0')
  if (!String(input.currency || '').trim()) errors.push('币种不能为空')
  const manual = input.manualConfirmation === true || Boolean(input.manual_confirmation)
  if (!manual && !(Number(input.baseFee ?? input.base_fee) > 0)) errors.push('基础运费必须大于 0')
  return errors
}
