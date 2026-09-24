import Ajv2020, { type ErrorObject } from 'ajv/dist/2020'
import { readFileSync } from 'node:fs'
import path from 'node:path'

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

export class ContractError extends Error {
  readonly code = 'INVALID_INPUT' as const

  constructor(message: string) {
    super(message)
    this.name = 'ContractError'
  }
}

const schemaPath = path.resolve(
  process.cwd(),
  '../shared-protocol/commerce/external-order-projection-command.schema.json',
)
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validate = ajv.compile<ExternalOrderProjectionCommand>(schema)

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'command does not match the external-order schema'
  return errors.map(error => `${error.instancePath || '/'} ${error.keyword}`).join('; ')
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(item => deepFreeze(item))
    Object.freeze(value)
  }
  return value
}

export function validateExternalOrderCommand(input: unknown): Readonly<ExternalOrderProjectionCommand> {
  if (!validate(input)) throw new ContractError(formatErrors(validate.errors))
  return deepFreeze(structuredClone(input))
}
