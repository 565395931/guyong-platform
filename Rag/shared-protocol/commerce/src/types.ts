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

export type ExternalOrderProjectionCommandV1 = {
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
  lines: Array<{
    externalLineId: string
    sku: string
    quantity: number
    unitAmount: string
    totalAmount: string
  }>
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

export type CurrencyDefinition = Readonly<{
  code: string
  exponent: number
}>

export type CustomerIdentity = Readonly<{
  externalCustomerId?: string
  name?: string
  email?: string
  phone?: string
}>

export type ShippingAddress = Readonly<{
  recipientName?: string
  phone?: string
  countryCode: string
  province?: string
  city?: string
  postalCode?: string
  line1: string
  line2?: string
}>

export type DiscountFunding = 'platform' | 'seller' | 'shared' | 'unknown'

export type DiscountAllocation = Readonly<{
  code: string
  description?: string
  amount: string
  funding: DiscountFunding
}>

export type TaxAllocation = Readonly<{
  code: string
  rate: string
  amount: string
  includedInSourcePrice: boolean
}>

export type ExternalOrderLineV2 = Readonly<{
  externalLineId: string
  sku: string
  quantity: number
  unitAmount: string
  grossAmount: string
  discounts: readonly DiscountAllocation[]
  taxes: readonly TaxAllocation[]
  totalAmount: string
}>

export type ShippingLineV2 = Readonly<{
  externalShippingLineId: string
  methodCode: string
  name: string
  grossAmount: string
  discounts: readonly DiscountAllocation[]
  taxes: readonly TaxAllocation[]
  totalAmount: string
}>

export type ExternalOrderProjectionCommandV2 = Readonly<{
  commandId: string
  eventInboxId: string | number
  schemaVersion: 2
  channel: string
  accountId: number
  externalOrderId: string
  externalVersion: string
  occurredAt: string
  currency: CurrencyDefinition
  customer: CustomerIdentity
  shippingAddress?: ShippingAddress
  lines: readonly ExternalOrderLineV2[]
  shippingLines: readonly ShippingLineV2[]
  amounts: Readonly<{
    itemGross: string
    itemDiscount: string
    shippingGross: string
    shippingDiscount: string
    tax: string
    total: string
  }>
  normalizedStatus: NormalizedOrderStatus
  rawPayloadRef: string
}>
