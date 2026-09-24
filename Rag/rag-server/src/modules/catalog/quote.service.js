function normalizeQuoteInput(input = {}) {
  const skuCode = String(input.skuCode || '').trim().toUpperCase()
  const quantity = Number(input.quantity)
  const currency = String(input.currency || '').trim().toUpperCase()
  const customerType = String(input.customerType || 'retail').trim().toLowerCase()
  if (!skuCode) throw new Error('skuCode is required')
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('quantity must be greater than 0')
  if (!currency) throw new Error('currency is required')
  return {
    ...input,
    skuCode,
    quantity,
    currency,
    customerType,
    regionCode: input.regionCode ? String(input.regionCode).trim().toUpperCase() : null,
    deliveryTerm: String(input.deliveryTerm || 'OTHER').trim().toUpperCase(),
    weightKg: input.weightKg == null || input.weightKg === '' ? null : Number(input.weightKg)
  }
}

function selectPrice(input, rules = []) {
  return rules
    .filter(rule => rule.sku_code === input.skuCode)
    .filter(rule => String(rule.currency).toUpperCase() === input.currency)
    .filter(rule => rule.customer_type === input.customerType || rule.customer_type === 'all')
    .filter(rule => input.quantity >= Number(rule.min_quantity))
    .filter(rule => rule.max_quantity == null || input.quantity <= Number(rule.max_quantity))
    .sort((a, b) => {
      const specificity = Number(b.customer_type === input.customerType) - Number(a.customer_type === input.customerType)
      return specificity || Number(b.min_quantity) - Number(a.min_quantity)
    })[0] || null
}

function selectFreight(input, rules = []) {
  if (!input.regionCode) return null
  return rules
    .filter(rule => String(rule.currency).toUpperCase() === input.currency)
    .filter(rule => String(rule.delivery_term).toUpperCase() === input.deliveryTerm)
    .filter(rule => rule.region_code === input.regionCode || rule.region_code === 'DEFAULT')
    .sort((a, b) => Number(b.region_code === input.regionCode) - Number(a.region_code === input.regionCode))[0] || null
}

function calculateFreight(weightKg, rule) {
  const numericWeight = Number(weightKg)
  if (rule.base_fee == null || !Number.isFinite(numericWeight) || numericWeight <= 0) return null
  const baseWeight = Number(rule.base_weight_kg)
  const extraWeight = Math.max(0, numericWeight - baseWeight)
  const incrementWeight = Number(rule.incremental_weight_kg || 0)
  if (extraWeight > 0 && incrementWeight <= 0) return null
  const steps = extraWeight === 0 ? 0 : Math.ceil(extraWeight / incrementWeight)
  return Number((Number(rule.base_fee) + steps * Number(rule.incremental_fee || 0)).toFixed(2))
}

function resolveQuote(rawInput, catalog) {
  const input = normalizeQuoteInput(rawInput)
  const price = selectPrice(input, catalog.priceRules)
  if (!price) {
    return { status: 'manual_confirmation', reason: 'no_active_price_rule' }
  }

  const goodsAmount = Number((input.quantity * Number(price.unit_price)).toFixed(2))
  const common = {
    versionId: catalog.versionId,
    priceRuleId: price.id,
    currency: String(price.currency).toUpperCase(),
    unitPrice: Number(price.unit_price),
    quantity: input.quantity,
    goodsAmount
  }

  if (!input.regionCode) {
    return {
      status: 'quoted',
      ...common,
      freightRuleId: null,
      freightAmount: null,
      totalAmount: goodsAmount
    }
  }

  const freight = selectFreight(input, catalog.freightRules)
  if (!freight) {
    return {
      status: 'manual_confirmation',
      reason: 'no_active_freight_rule',
      ...common
    }
  }
  if (Boolean(freight.manual_confirmation)) {
    return {
      status: 'manual_confirmation',
      reason: 'freight_requires_confirmation',
      ...common,
      freightRuleId: freight.id
    }
  }

  const freightAmount = calculateFreight(input.weightKg, freight)
  if (freightAmount == null) {
    return {
      status: 'manual_confirmation',
      reason: 'freight_weight_required',
      ...common,
      freightRuleId: freight.id
    }
  }

  return {
    status: 'quoted',
    ...common,
    freightRuleId: freight.id,
    freightAmount,
    totalAmount: Number((goodsAmount + freightAmount).toFixed(2))
  }
}

function createQuoteService({ repository, now = () => new Date() }) {
  return {
    async resolveAndRecord(rawInput, userId) {
      const input = normalizeQuoteInput(rawInput)
      const catalog = await repository.loadPublishedCatalog(now())
      const result = catalog
        ? resolveQuote(input, catalog)
        : { status: 'manual_confirmation', reason: 'no_published_catalog' }
      await repository.createQuoteRecord({ ...input, result, createdBy: userId })
      return result
    }
  }
}

module.exports = {
  normalizeQuoteInput,
  selectPrice,
  selectFreight,
  calculateFreight,
  resolveQuote,
  createQuoteService
}
