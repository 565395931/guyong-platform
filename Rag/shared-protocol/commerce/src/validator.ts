import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020'
import { DecimalValidationError, toScaledInteger } from './decimal'
import type {
  DiscountAllocation,
  ExternalOrderLineV2,
  ExternalOrderProjectionCommandV2,
  ShippingLineV2,
  TaxAllocation,
} from './types'

export type ProtocolValidationErrorCode = 'INVALID_INPUT' | 'TOTAL_MISMATCH'

export class ProtocolValidationError extends Error {
  constructor(
    readonly code: ProtocolValidationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProtocolValidationError'
  }
}

const schemaPath = resolve(__dirname, '../external-order-projection-command.v2.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
const ajv = new Ajv2020({ allErrors: false, strict: true })
const validateSchema = ajv.compile<ExternalOrderProjectionCommandV2>(schema)

function structuralError(errors: ErrorObject[] | null | undefined): ProtocolValidationError {
  const details = (errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || '/'}:${error.keyword}`)
    .join(', ')

  return new ProtocolValidationError(
    'INVALID_INPUT',
    details ? `Command failed schema validation (${details})` : 'Command failed schema validation',
  )
}

function amount(value: string, exponent: number, path: string): bigint {
  try {
    return toScaledInteger(value, exponent)
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw new ProtocolValidationError('INVALID_INPUT', `${path}: ${error.message}`)
    }
    throw error
  }
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n)
}

function allocationTotal(
  allocations: readonly (DiscountAllocation | TaxAllocation)[],
  exponent: number,
  path: string,
): bigint {
  return sum(allocations.map((allocation, index) => amount(allocation.amount, exponent, `${path}/${index}/amount`)))
}

function mismatch(path: string): never {
  throw new ProtocolValidationError('TOTAL_MISMATCH', `${path}: monetary totals do not reconcile`)
}

function validateOrderLine(line: ExternalOrderLineV2, exponent: number, index: number): void {
  const path = `/lines/${index}`
  const unitAmount = amount(line.unitAmount, exponent, `${path}/unitAmount`)
  const grossAmount = amount(line.grossAmount, exponent, `${path}/grossAmount`)
  const totalAmount = amount(line.totalAmount, exponent, `${path}/totalAmount`)

  if (unitAmount * BigInt(line.quantity) !== grossAmount) {
    mismatch(`${path}/grossAmount`)
  }

  const discounts = allocationTotal(line.discounts, exponent, `${path}/discounts`)
  const taxes = allocationTotal(line.taxes, exponent, `${path}/taxes`)
  if (grossAmount - discounts + taxes !== totalAmount) {
    mismatch(`${path}/totalAmount`)
  }
}

function validateShippingLine(line: ShippingLineV2, exponent: number, index: number): void {
  const path = `/shippingLines/${index}`
  const grossAmount = amount(line.grossAmount, exponent, `${path}/grossAmount`)
  const totalAmount = amount(line.totalAmount, exponent, `${path}/totalAmount`)
  const discounts = allocationTotal(line.discounts, exponent, `${path}/discounts`)
  const taxes = allocationTotal(line.taxes, exponent, `${path}/taxes`)

  if (grossAmount - discounts + taxes !== totalAmount) {
    mismatch(`${path}/totalAmount`)
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }
  return value
}

export function validateExternalOrderCommandV2(input: unknown): ExternalOrderProjectionCommandV2 {
  if (!validateSchema(input)) {
    throw structuralError(validateSchema.errors)
  }

  const command = structuredClone(input)
  const exponent = command.currency.exponent

  command.lines.forEach((line, index) => validateOrderLine(line, exponent, index))
  command.shippingLines.forEach((line, index) => validateShippingLine(line, exponent, index))

  const itemGross = sum(command.lines.map((line, index) => amount(line.grossAmount, exponent, `/lines/${index}/grossAmount`)))
  const itemDiscount = sum(
    command.lines.map((line, index) => allocationTotal(line.discounts, exponent, `/lines/${index}/discounts`)),
  )
  const shippingGross = sum(
    command.shippingLines.map((line, index) => amount(line.grossAmount, exponent, `/shippingLines/${index}/grossAmount`)),
  )
  const shippingDiscount = sum(
    command.shippingLines.map((line, index) =>
      allocationTotal(line.discounts, exponent, `/shippingLines/${index}/discounts`),
    ),
  )
  const tax =
    sum(command.lines.map((line, index) => allocationTotal(line.taxes, exponent, `/lines/${index}/taxes`))) +
    sum(
      command.shippingLines.map((line, index) =>
        allocationTotal(line.taxes, exponent, `/shippingLines/${index}/taxes`),
      ),
    )

  const expectedAmounts = {
    itemGross,
    itemDiscount,
    shippingGross,
    shippingDiscount,
    tax,
  } as const

  for (const [key, expected] of Object.entries(expectedAmounts)) {
    if (amount(command.amounts[key as keyof typeof expectedAmounts], exponent, `/amounts/${key}`) !== expected) {
      mismatch(`/amounts/${key}`)
    }
  }

  const total = amount(command.amounts.total, exponent, '/amounts/total')
  const calculatedTotal = itemGross - itemDiscount + shippingGross - shippingDiscount + tax
  if (total !== calculatedTotal) {
    mismatch('/amounts/total')
  }

  return deepFreeze(command)
}
