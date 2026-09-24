const crypto = require('node:crypto')
const { validateExternalOrderCommandV2 } = require('@rag/commerce-protocol')

const STATUS_VALUES = new Set(['created', 'paid', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'after_sales'])

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function projectionError(code, message) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function pathValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source)
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

function text(value, field) {
  const result = typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value).trim()
    : ''
  if (!result) throw projectionError('commerce_projection_incomplete', `${field} is required for projection`)
  return result
}

function decimal(value, field, exponent) {
  const raw = text(value, field)
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw)) {
    throw projectionError('commerce_projection_incomplete', `${field} must be a non-negative decimal`)
  }
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > exponent) {
    throw projectionError('commerce_projection_incomplete', `${field} exceeds currency precision`)
  }
  return BigInt(`${whole}${fraction.padEnd(exponent, '0')}`)
}

function amount(value, exponent) {
  const scaled = decimal(value, 'amount', exponent)
  return scaled
}

function formatAmount(value, exponent) {
  const textValue = value.toString().padStart(exponent + 1, '0')
  if (exponent === 0) return textValue
  const split = textValue.length - exponent
  return `${textValue.slice(0, split)}.${textValue.slice(split)}`
}

function readProjection(payload) {
  const projection = payload?.projection || payload?.normalizedOrder || payload?.orderProjection
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw projectionError('commerce_projection_incomplete', 'an explicit normalized order projection is required')
  }
  return projection
}

function buildLine(raw, index, exponent) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw projectionError('commerce_projection_incomplete', `line ${index} is invalid`)
  }
  const quantityValue = pathValue(raw, ['quantity', 'qty', 'num', 'count'])
  const quantity = Number(quantityValue)
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw projectionError('commerce_projection_incomplete', `line ${index} quantity is invalid`)
  }
  const unitRaw = pathValue(raw, ['unitAmount', 'unit_amount', 'unitPrice', 'unit_price', 'price'])
  const grossRaw = pathValue(raw, ['grossAmount', 'gross_amount', 'lineAmount', 'line_amount', 'amount'])
  const unit = amount(unitRaw, exponent)
  const gross = amount(grossRaw, exponent)
  if (unit * BigInt(quantity) !== gross) {
    throw projectionError('commerce_projection_total_mismatch', `line ${index} gross amount does not reconcile`)
  }
  const discounts = buildAllocations(raw.discounts ?? raw.discountAllocations, 'discount', exponent, true)
  const taxes = buildAllocations(raw.taxes ?? raw.taxAllocations, 'tax', exponent, true)
  const totalRaw = pathValue(raw, ['totalAmount', 'total_amount', 'netAmount', 'net_amount'])
  const total = totalRaw == null ? gross - sum(discounts.map(item => item.amount)) + sum(taxes.map(item => item.amount)) : amount(totalRaw, exponent)
  if (total < 0n || gross - sum(discounts.map(item => item.amount)) + sum(taxes.map(item => item.amount)) !== total) {
    throw projectionError('commerce_projection_total_mismatch', `line ${index} total amount does not reconcile`)
  }
  return {
    externalLineId: text(pathValue(raw, ['externalLineId', 'external_line_id', 'id', 'item_id', 'oid']), `line ${index} id`),
    sku: text(pathValue(raw, ['sku', 'skuId', 'sku_id', 'specId', 'spec_id', 'productId', 'product_id']), `line ${index} sku`),
    quantity,
    unitAmount: formatAmount(unit, exponent),
    grossAmount: formatAmount(gross, exponent),
    discounts: discounts.map(item => ({ ...item, amount: formatAmount(item.amount, exponent) })),
    taxes: taxes.map(item => ({ ...item, amount: formatAmount(item.amount, exponent) })),
    totalAmount: formatAmount(total, exponent)
  }
}

function buildAllocations(raw, kind, exponent, required = false) {
  if (raw == null) {
    if (required) throw projectionError('commerce_projection_incomplete', `${kind} allocations are required`)
    return []
  }
  if (!Array.isArray(raw)) throw projectionError('commerce_projection_incomplete', `${kind} allocations must be an array`)
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw projectionError('commerce_projection_incomplete', `${kind} allocation ${index} is invalid`)
    const value = amount(pathValue(entry, ['amount', 'value', 'fee']), exponent)
    return kind === 'discount'
      ? { code: text(pathValue(entry, ['code', 'id', 'type']) || `${kind}-${index + 1}`, `${kind} code`), ...(entry.description ? { description: String(entry.description) } : {}), amount: value, funding: ['platform', 'seller', 'shared', 'unknown'].includes(entry.funding) ? entry.funding : 'unknown' }
      : { code: text(pathValue(entry, ['code', 'id', 'type']) || `${kind}-${index + 1}`, `${kind} code`), rate: String(pathValue(entry, ['rate', 'taxRate']) ?? '0'), amount: value, includedInSourcePrice: entry.includedInSourcePrice === true }
  })
}

function sum(values) { return values.reduce((total, value) => total + value, 0n) }

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (!STATUS_VALUES.has(status)) throw projectionError('commerce_projection_incomplete', 'normalized status is required')
  return status
}

function buildCommerceProjectionDraft(event) {
  const projection = readProjection(event?.payload)
  const currencyValue = projection.currency
  const currencyCode = typeof currencyValue === 'object' ? currencyValue.code : currencyValue
  const exponentValue = typeof currencyValue === 'object' ? currencyValue.exponent : projection.currencyExponent
  const exponent = Number(exponentValue)
  if (!/^[A-Z]{3}$/.test(String(currencyCode || '')) || !Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    throw projectionError('commerce_projection_incomplete', 'currency definition is invalid')
  }
  const linesSource = projection.lines || projection.items || projection.orderLines
  if (!Array.isArray(linesSource) || linesSource.length === 0) throw projectionError('commerce_projection_incomplete', 'at least one order line is required')
  const lines = linesSource.map((line, index) => buildLine(line, index, exponent))
  const shippingGross = amount(projection.shipping ?? projection.shippingAmount ?? projection.postFee, exponent)
  const shippingDiscounts = buildAllocations(projection.shippingDiscounts, 'discount', exponent, true)
  const shippingTaxes = buildAllocations(projection.shippingTaxes, 'tax', exponent, true)
  const shippingTotal = shippingGross - sum(shippingDiscounts.map(item => item.amount)) + sum(shippingTaxes.map(item => item.amount))
  if (shippingTotal < 0n) throw projectionError('commerce_projection_total_mismatch', 'shipping total cannot be negative')
  const itemGross = sum(lines.map(line => amount(line.grossAmount, exponent)))
  const itemDiscount = sum(lines.flatMap(line => line.discounts.map(item => amount(item.amount, exponent))))
  const tax = sum(lines.flatMap(line => line.taxes.map(item => amount(item.amount, exponent)))) + sum(shippingTaxes.map(item => item.amount))
  const shippingDiscount = sum(shippingDiscounts.map(item => item.amount))
  const calculatedTotal = itemGross - itemDiscount + shippingGross - shippingDiscount + tax
  const declaredTotal = amount(projection.total ?? projection.orderAmount ?? projection.payAmount, exponent)
  if (declaredTotal !== calculatedTotal) throw projectionError('commerce_projection_total_mismatch', 'order total does not reconcile')
  const externalOrderId = text(
    projection.externalOrderId || pathValue(event?.payload, ['order_id', 'orderId', 'order_sn', 'tid']) || event?.businessKey,
    'external order id'
  )
  const externalVersion = text(projection.externalVersion || event?.occurredAt, 'external order version')
  const commandIdentity = text(event?.externalEventId, 'external event id')
  const commandId = `commerce:${event.channel}:${event.accountId}:${externalOrderId}:${commandIdentity}`
  return validateExternalOrderCommandV2({
    commandId: commandId.length <= 512 ? commandId : `commerce:${crypto.createHash('sha256').update(commandId).digest('hex')}`,
    eventInboxId: 0,
    schemaVersion: 2,
    channel: text(event.channel, 'channel'),
    accountId: Number(event.accountId),
    externalOrderId,
    externalVersion,
    occurredAt: text(event.occurredAt, 'occurredAt'),
    currency: { code: String(currencyCode), exponent },
    customer: { ...(projection.customerId || event.payload.buyer_open_uid ? { externalCustomerId: String(projection.customerId || event.payload.buyer_open_uid) } : {}) },
    ...(projection.shippingAddress ? { shippingAddress: projection.shippingAddress } : {}),
    lines,
    shippingLines: [{ externalShippingLineId: 'shipping', methodCode: String(projection.shippingMethodCode || 'default'), name: String(projection.shippingMethodName || 'Shipping'), grossAmount: formatAmount(shippingGross, exponent), discounts: shippingDiscounts.map(item => ({ ...item, amount: formatAmount(item.amount, exponent) })), taxes: shippingTaxes.map(item => ({ ...item, amount: formatAmount(item.amount, exponent) })), totalAmount: formatAmount(shippingTotal, exponent) }].filter(line => line.grossAmount !== formatAmount(0n, exponent) || line.discounts.length || line.taxes.length),
    amounts: { itemGross: formatAmount(itemGross, exponent), itemDiscount: formatAmount(itemDiscount, exponent), shippingGross: formatAmount(shippingGross, exponent), shippingDiscount: formatAmount(shippingDiscount, exponent), tax: formatAmount(tax, exponent), total: formatAmount(declaredTotal, exponent) },
    normalizedStatus: normalizeStatus(projection.status || projection.normalizedStatus),
    rawPayloadRef: 'channel_event_inbox:0'
  })
}

function attachCommerceProjection(event) {
  if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return event
  let projectionCommand
  try {
    projectionCommand = buildCommerceProjectionDraft(event)
  } catch (error) {
    if (error?.code === 'commerce_projection_incomplete') return event
    throw error
  }
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload, projectionCommand })
  })
}

function applyCommerceProjectionMapper(event, mapper) {
  if (typeof mapper !== 'function') throw new TypeError('Commerce projection mapper must be a function')
  if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return event

  const input = deepFreeze(cloneValue(event.payload))
  const projection = mapper(input)
  if (projection == null) return event
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw projectionError('commerce_projection_incomplete', 'connector projection must be an object')
  }

  const mappedEvent = {
    ...event,
    payload: {
      ...cloneValue(event.payload),
      projection: cloneValue(projection)
    }
  }
  const projectionCommand = buildCommerceProjectionDraft(mappedEvent)
  const { projection: _projection, ...payload } = mappedEvent.payload
  return Object.freeze({
    ...mappedEvent,
    payload: Object.freeze({ ...payload, projectionCommand })
  })
}

module.exports = { applyCommerceProjectionMapper, attachCommerceProjection, buildCommerceProjectionDraft }
