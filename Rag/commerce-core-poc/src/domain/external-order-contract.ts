export const NORMALIZED_ORDER_STATUSES = [
  'created',
  'paid',
  'ready_to_ship',
  'shipped',
  'delivered',
  'cancelled',
  'after_sales',
] as const

export type NormalizedOrderStatus = (typeof NORMALIZED_ORDER_STATUSES)[number]

export type ExternalOrderLine = {
  externalLineId: string
  sku: string
  quantity: number
  unitAmount: string
  totalAmount: string
}

export type ExternalOrderProjectionCommand = {
  commandId: string
  eventInboxId: string | number
  schemaVersion: 1
  channel: string
  accountId: number
  externalOrderId: string
  externalVersion: string
  occurredAt: string
  currency: string
  customer: Record<string, unknown>
  shippingAddress?: Record<string, unknown>
  lines: ExternalOrderLine[]
  amounts: {
    goods: string
    discount: string
    shipping: string
    tax: string
    total: string
  }
  normalizedStatus: NormalizedOrderStatus
  rawPayloadRef: string
}

export class ProjectionContractError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ProjectionContractError'
  }
}

function invalid(message: string): never {
  throw new ProjectionContractError('INVALID_INPUT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${field} must be an object`)
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} must be a non-empty string`)
  return value.trim()
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative safe integer`)
  }
  return value
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) {
    invalid(`${field} must be an RFC 3339 UTC timestamp`)
  }
  if (Number.isNaN(Date.parse(timestamp))) invalid(`${field} must be a valid timestamp`)
  return timestamp
}

function requireDecimal(value: unknown, field: string): string {
  const decimal = requireString(value, field)
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) invalid(`${field} must be a decimal string`)
  return decimal
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(item => deepFreeze(item))
    Object.freeze(value)
  }
  return value
}

export function toMinorUnits(value: string, exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    invalid('currency exponent must be an integer between 0 and 6')
  }
  const decimal = requireDecimal(value, 'amount')
  const negative = decimal.startsWith('-')
  const unsigned = negative ? decimal.slice(1) : decimal
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > exponent) invalid('amount precision exceeds the currency exponent')
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`
  const amount = BigInt(digits || '0')
  return negative ? -amount : amount
}

export function createExternalOrderKey(
  channel: string,
  accountId: string | number,
  externalOrderId: string,
): string {
  return JSON.stringify([
    requireString(channel, 'channel'),
    requireString(String(accountId), 'accountId'),
    requireString(externalOrderId, 'externalOrderId'),
  ])
}

export function validateExternalOrderCommand(input: unknown): Readonly<ExternalOrderProjectionCommand> {
  const source = requireRecord(input, 'command')
  requireString(source.commandId, 'commandId')

  if (typeof source.eventInboxId === 'number') {
    requireSafeInteger(source.eventInboxId, 'eventInboxId')
  } else {
    requireString(source.eventInboxId, 'eventInboxId')
  }

  if (source.schemaVersion !== 1) invalid('schemaVersion must be 1')
  requireString(source.channel, 'channel')
  requireSafeInteger(source.accountId, 'accountId')
  requireString(source.externalOrderId, 'externalOrderId')
  requireString(source.externalVersion, 'externalVersion')
  requireTimestamp(source.occurredAt, 'occurredAt')

  const currency = requireString(source.currency, 'currency')
  if (!/^[A-Z]{3}$/.test(currency)) invalid('currency must be an ISO 4217 code')

  requireRecord(source.customer, 'customer')
  if (source.shippingAddress !== undefined) requireRecord(source.shippingAddress, 'shippingAddress')

  if (!Array.isArray(source.lines) || source.lines.length === 0) invalid('lines must contain at least one item')
  source.lines.forEach((lineValue, index) => {
    const line = requireRecord(lineValue, `lines[${index}]`)
    requireString(line.externalLineId, `lines[${index}].externalLineId`)
    requireString(line.sku, `lines[${index}].sku`)
    if (typeof line.quantity !== 'number' || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      invalid(`lines[${index}].quantity must be a positive safe integer`)
    }
    requireDecimal(line.unitAmount, `lines[${index}].unitAmount`)
    requireDecimal(line.totalAmount, `lines[${index}].totalAmount`)
  })

  const amounts = requireRecord(source.amounts, 'amounts')
  ;['goods', 'discount', 'shipping', 'tax', 'total'].forEach(field => {
    requireDecimal(amounts[field], `amounts.${field}`)
  })

  if (!NORMALIZED_ORDER_STATUSES.includes(source.normalizedStatus as NormalizedOrderStatus)) {
    invalid('normalizedStatus is unsupported')
  }
  requireString(source.rawPayloadRef, 'rawPayloadRef')

  const detached = structuredClone(source) as ExternalOrderProjectionCommand
  return deepFreeze(detached)
}
