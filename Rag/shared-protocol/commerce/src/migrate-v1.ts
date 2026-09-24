import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020'
import { DecimalValidationError, toScaledInteger } from './decimal'
import type {
  CustomerIdentity,
  ExternalOrderProjectionCommandV1,
  ExternalOrderProjectionCommandV2,
  ShippingAddress,
} from './types'
import { ProtocolValidationError, validateExternalOrderCommandV2 } from './validator'

export type MigrationErrorCode =
  | 'INVALID_INPUT'
  | 'TOTAL_MISMATCH'
  | 'BREAKDOWN_REQUIRED'
  | 'CURRENCY_EXPONENT_REQUIRED'

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MigrationError'
  }
}

const schemaPath = resolve(__dirname, '../external-order-projection-command.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
const ajv = new Ajv2020({ allErrors: false, strict: true })
const validateSchema = ajv.compile<ExternalOrderProjectionCommandV1>(schema)

function structuralError(errors: ErrorObject[] | null | undefined): MigrationError {
  const details = (errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || '/'}:${error.keyword}`)
    .join(', ')

  return new MigrationError(
    'INVALID_INPUT',
    details ? `Legacy command failed schema validation (${details})` : 'Legacy command failed schema validation',
  )
}

function scaledAmount(value: string, exponent: number, path: string): bigint {
  try {
    return toScaledInteger(value, exponent)
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw new MigrationError('INVALID_INPUT', `${path}: ${error.message}`)
    }
    throw error
  }
}

function mismatch(path: string): never {
  throw new MigrationError('TOTAL_MISMATCH', `${path}: monetary totals do not reconcile`)
}

function optionalString(source: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = source[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MigrationError('INVALID_INPUT', `${path}/${key}: expected a non-empty string`)
  }
  return value
}

function migrateCustomer(source: Record<string, unknown>): CustomerIdentity {
  const externalCustomerId = optionalString(source, 'externalCustomerId', '/customer')
  const name = optionalString(source, 'name', '/customer')
  const email = optionalString(source, 'email', '/customer')
  const phone = optionalString(source, 'phone', '/customer')

  return {
    ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
  }
}

function requiredString(source: Record<string, unknown>, key: string, path: string): string {
  const value = optionalString(source, key, path)
  if (value === undefined) {
    throw new MigrationError('INVALID_INPUT', `${path}/${key}: required field is missing`)
  }
  return value
}

function migrateShippingAddress(source: Record<string, unknown>): ShippingAddress {
  const recipientName = optionalString(source, 'recipientName', '/shippingAddress')
  const phone = optionalString(source, 'phone', '/shippingAddress')
  const province = optionalString(source, 'province', '/shippingAddress')
  const city = optionalString(source, 'city', '/shippingAddress')
  const postalCode = optionalString(source, 'postalCode', '/shippingAddress')
  const line2 = optionalString(source, 'line2', '/shippingAddress')

  return {
    countryCode: requiredString(source, 'countryCode', '/shippingAddress'),
    line1: requiredString(source, 'line1', '/shippingAddress'),
    ...(recipientName !== undefined ? { recipientName } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(province !== undefined ? { province } : {}),
    ...(city !== undefined ? { city } : {}),
    ...(postalCode !== undefined ? { postalCode } : {}),
    ...(line2 !== undefined ? { line2 } : {}),
  }
}

function validateLegacyTotals(command: ExternalOrderProjectionCommandV1, exponent: number): void {
  const lineTotals = command.lines.map((line, index) => {
    const unitAmount = scaledAmount(line.unitAmount, exponent, `/lines/${index}/unitAmount`)
    const totalAmount = scaledAmount(line.totalAmount, exponent, `/lines/${index}/totalAmount`)
    if (unitAmount * BigInt(line.quantity) !== totalAmount) {
      mismatch(`/lines/${index}/totalAmount`)
    }
    return totalAmount
  })

  const goods = scaledAmount(command.amounts.goods, exponent, '/amounts/goods')
  const discount = scaledAmount(command.amounts.discount, exponent, '/amounts/discount')
  const shipping = scaledAmount(command.amounts.shipping, exponent, '/amounts/shipping')
  const tax = scaledAmount(command.amounts.tax, exponent, '/amounts/tax')
  const total = scaledAmount(command.amounts.total, exponent, '/amounts/total')

  if (lineTotals.reduce((sum, value) => sum + value, 0n) !== goods) {
    mismatch('/amounts/goods')
  }

  if (discount !== 0n || tax !== 0n) {
    throw new MigrationError(
      'BREAKDOWN_REQUIRED',
      'Legacy order-level discount or tax requires source allocation details',
    )
  }

  if (goods - discount + shipping + tax !== total) {
    mismatch('/amounts/total')
  }
}

export function migrateExternalOrderCommandV1(
  input: unknown,
  currencyExponents: Readonly<Record<string, number>>,
): ExternalOrderProjectionCommandV2 {
  if (!validateSchema(input)) {
    throw structuralError(validateSchema.errors)
  }

  const command = input
  const exponent = currencyExponents[command.currency]
  if (exponent === undefined) {
    throw new MigrationError('CURRENCY_EXPONENT_REQUIRED', 'Currency exponent mapping is required')
  }
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new MigrationError('INVALID_INPUT', 'Currency exponent mapping must contain integers from 0 through 6')
  }

  validateLegacyTotals(command, exponent)

  const migrated: ExternalOrderProjectionCommandV2 = {
    commandId: command.commandId,
    eventInboxId: command.eventInboxId,
    schemaVersion: 2,
    channel: command.channel,
    accountId: command.accountId,
    externalOrderId: command.externalOrderId,
    externalVersion: command.externalVersion,
    occurredAt: command.occurredAt,
    currency: { code: command.currency, exponent },
    customer: migrateCustomer(command.customer),
    ...(command.shippingAddress !== undefined
      ? { shippingAddress: migrateShippingAddress(command.shippingAddress) }
      : {}),
    lines: command.lines.map((line) => ({
      externalLineId: line.externalLineId,
      sku: line.sku,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      grossAmount: line.totalAmount,
      discounts: [],
      taxes: [],
      totalAmount: line.totalAmount,
    })),
    shippingLines:
      scaledAmount(command.amounts.shipping, exponent, '/amounts/shipping') === 0n
        ? []
        : [
            {
              externalShippingLineId: `${command.externalOrderId}:shipping`,
              methodCode: 'external-platform',
              name: 'External platform shipping',
              grossAmount: command.amounts.shipping,
              discounts: [],
              taxes: [],
              totalAmount: command.amounts.shipping,
            },
          ],
    amounts: {
      itemGross: command.amounts.goods,
      itemDiscount: command.amounts.discount,
      shippingGross: command.amounts.shipping,
      shippingDiscount: command.amounts.discount,
      tax: command.amounts.tax,
      total: command.amounts.total,
    },
    normalizedStatus: command.normalizedStatus,
    rawPayloadRef: command.rawPayloadRef,
  }

  try {
    return validateExternalOrderCommandV2(migrated)
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new MigrationError(error.code, error.message)
    }
    throw error
  }
}
