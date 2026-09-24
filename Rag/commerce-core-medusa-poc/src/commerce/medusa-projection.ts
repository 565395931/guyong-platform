import type { CreateOrderWorkflowInput } from '@medusajs/medusa/core-flows'
import {
  type ExternalOrderProjectionCommand,
  validateExternalOrderCommand,
} from './contract'

export type ProjectionErrorCode =
  | 'CHANNEL_NOT_MAPPED'
  | 'SKU_NOT_MAPPED'
  | 'TOTAL_MISMATCH'
  | 'DISCOUNT_BREAKDOWN_REQUIRED'
  | 'TAX_BREAKDOWN_REQUIRED'

export class ProjectionError extends Error {
  constructor(public readonly code: ProjectionErrorCode, message: string) {
    super(message)
    this.name = 'ProjectionError'
  }
}

type ChannelMapping = Readonly<{
  salesChannelId: string
  regionId: string
  locationId: string
  shippingOptionId?: string
  currency: string
  currencyExponent: number
}>

type SkuMapping = Readonly<{
  variantId: string
  inventoryItemId: string
  title: string
  requiresShipping: boolean
}>

export type ProjectionMappings = Readonly<{
  channels: Readonly<Record<string, ChannelMapping>>
  skus: Readonly<Record<string, SkuMapping>>
}>

export type ReservationTemplate = Readonly<{
  externalLineId: string
  inventoryItemId: string
  locationId: string
  quantity: number
}>

export type MedusaProjectionPlan = Readonly<{
  order: Readonly<CreateOrderWorkflowInput>
  reservationTemplates: readonly ReservationTemplate[]
}>

function fail(code: ProjectionErrorCode, message: string): never {
  throw new ProjectionError(code, message)
}

function mappingKey(channel: string, accountId: number): string {
  return JSON.stringify([channel, String(accountId)])
}

function toScaledInteger(value: string, exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    return fail('TOTAL_MISMATCH', 'currency exponent is unsupported')
  }
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > exponent) return fail('TOTAL_MISMATCH', 'amount precision exceeds currency exponent')
  const result = BigInt(`${whole}${fraction.padEnd(exponent, '0')}`)
  return negative ? -result : result
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(item => deepFreeze(item))
    Object.freeze(value)
  }
  return value
}

function shippingAddress(command: Readonly<ExternalOrderProjectionCommand>) {
  const address = command.shippingAddress
  if (!address) return undefined

  const result: Record<string, string> = {}
  if (typeof address.line1 === 'string') result.address_1 = address.line1
  if (typeof address.city === 'string') result.city = address.city
  if (typeof address.countryCode === 'string') result.country_code = address.countryCode.toLowerCase()
  return Object.keys(result).length ? result : undefined
}

function verifyTotals(command: Readonly<ExternalOrderProjectionCommand>, exponent: number): void {
  const goods = toScaledInteger(command.amounts.goods, exponent)
  const discount = toScaledInteger(command.amounts.discount, exponent)
  const shipping = toScaledInteger(command.amounts.shipping, exponent)
  const tax = toScaledInteger(command.amounts.tax, exponent)
  const total = toScaledInteger(command.amounts.total, exponent)

  const lineTotal = command.lines.reduce((sum, line) => {
    const unit = toScaledInteger(line.unitAmount, exponent)
    const expectedLineTotal = unit * BigInt(line.quantity)
    const actualLineTotal = toScaledInteger(line.totalAmount, exponent)
    if (expectedLineTotal !== actualLineTotal) fail('TOTAL_MISMATCH', 'line total does not match unit amount')
    return sum + actualLineTotal
  }, 0n)

  if (lineTotal !== goods) fail('TOTAL_MISMATCH', 'goods total does not match line totals')
  if (goods - discount + shipping + tax !== total) fail('TOTAL_MISMATCH', 'order total is inconsistent')
  if (discount !== 0n) fail('DISCOUNT_BREAKDOWN_REQUIRED', 'line-level discount breakdown is required')
  if (tax !== 0n) fail('TAX_BREAKDOWN_REQUIRED', 'tax rate breakdown is required')
}

export function mapExternalOrderToMedusa(
  input: unknown,
  mappings: ProjectionMappings,
): MedusaProjectionPlan {
  const command = validateExternalOrderCommand(input)
  const channel = mappings.channels[mappingKey(command.channel, command.accountId)]
  if (!channel || channel.currency !== command.currency) {
    return fail('CHANNEL_NOT_MAPPED', 'channel account and currency mapping is missing')
  }

  verifyTotals(command, channel.currencyExponent)

  const resolvedLines = command.lines.map(line => {
    const sku = mappings.skus[line.sku]
    if (!sku) return fail('SKU_NOT_MAPPED', 'one or more order SKUs are not mapped')
    return { line, sku }
  })

  const order: CreateOrderWorkflowInput = {
    region_id: channel.regionId,
    sales_channel_id: channel.salesChannelId,
    status: 'pending',
    currency_code: command.currency.toLowerCase(),
    no_notification: true,
    shipping_address: shippingAddress(command),
    items: resolvedLines.map(({ line, sku }) => ({
      title: sku.title,
      quantity: line.quantity,
      unit_price: line.unitAmount,
      variant_id: sku.variantId,
      variant_sku: line.sku,
      requires_shipping: sku.requiresShipping,
      metadata: { external_line_id: line.externalLineId },
    })),
    shipping_methods:
      toScaledInteger(command.amounts.shipping, channel.currencyExponent) === 0n
        ? []
        : [
            {
              name: 'External platform shipping',
              amount: command.amounts.shipping,
              shipping_option_id: channel.shippingOptionId,
              data: { raw_payload_ref: command.rawPayloadRef },
            },
          ],
    metadata: {
      source_channel: command.channel,
      source_account_id: String(command.accountId),
      external_order_id: command.externalOrderId,
      external_version: command.externalVersion,
      external_status: command.normalizedStatus,
      command_id: command.commandId,
      raw_payload_ref: command.rawPayloadRef,
    },
  }

  const reservationTemplates = resolvedLines.map(({ line, sku }) => ({
    externalLineId: line.externalLineId,
    inventoryItemId: sku.inventoryItemId,
    locationId: channel.locationId,
    quantity: line.quantity,
  }))

  return deepFreeze(structuredClone({ order, reservationTemplates }))
}
