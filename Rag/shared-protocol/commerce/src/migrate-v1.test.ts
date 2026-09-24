import { describe, expect, it } from 'vitest'
import { MigrationError, migrateExternalOrderCommandV1 } from './index'

function validV1Command() {
  return {
    commandId: 'command-1',
    eventInboxId: '41',
    schemaVersion: 1 as const,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: '9223372036854775807',
    externalVersion: '2026-08-10T01:00:00.000Z',
    occurredAt: '2026-08-10T01:00:00.000Z',
    currency: 'CNY',
    customer: {
      externalCustomerId: 'customer-1',
      name: 'Synthetic Customer',
      email: 'customer@example.invalid',
      platformMetadata: 'must-not-migrate',
    },
    shippingAddress: {
      recipientName: 'Synthetic Customer',
      countryCode: 'CN',
      city: 'Shanghai',
      line1: 'redacted',
      platformMetadata: 'must-not-migrate',
    },
    lines: [
      {
        externalLineId: 'line-1',
        sku: 'SKU-001',
        quantity: 2,
        unitAmount: '19.90',
        totalAmount: '39.80',
      },
    ],
    amounts: {
      goods: '39.80',
      discount: '0.00',
      shipping: '5.00',
      tax: '0.00',
      total: '44.80',
    },
    normalizedStatus: 'paid' as const,
    rawPayloadRef: 'channel_event_inbox:41',
  }
}

describe('migrateExternalOrderCommandV1', () => {
  it('migrates a reconciling zero-discount, zero-tax command to v2', () => {
    const input = validV1Command()
    const result = migrateExternalOrderCommandV1(input, { CNY: 2 })

    input.lines[0].sku = 'CHANGED'

    expect(result).toMatchObject({
      schemaVersion: 2,
      currency: { code: 'CNY', exponent: 2 },
      customer: {
        externalCustomerId: 'customer-1',
        name: 'Synthetic Customer',
        email: 'customer@example.invalid',
      },
      lines: [
        {
          grossAmount: '39.80',
          discounts: [],
          taxes: [],
          totalAmount: '39.80',
        },
      ],
      shippingLines: [
        {
          externalShippingLineId: '9223372036854775807:shipping',
          methodCode: 'external-platform',
          name: 'External platform shipping',
          grossAmount: '5.00',
          discounts: [],
          taxes: [],
          totalAmount: '5.00',
        },
      ],
      amounts: {
        itemGross: '39.80',
        itemDiscount: '0.00',
        shippingGross: '5.00',
        shippingDiscount: '0.00',
        tax: '0.00',
        total: '44.80',
      },
    })
    expect(result.customer).not.toHaveProperty('platformMetadata')
    expect(result.shippingAddress).not.toHaveProperty('platformMetadata')
    expect(result.lines[0].sku).toBe('SKU-001')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.lines[0])).toBe(true)
  })

  it('omits the synthetic shipping line when shipping is zero', () => {
    const input = validV1Command()
    input.amounts.shipping = '0.00'
    input.amounts.total = '39.80'

    expect(migrateExternalOrderCommandV1(input, { CNY: 2 }).shippingLines).toEqual([])
  })

  it('supports legacy commands without a shipping address', () => {
    const input = validV1Command()
    delete input.shippingAddress

    expect(migrateExternalOrderCommandV1(input, { CNY: 2 })).not.toHaveProperty('shippingAddress')
  })

  it.each([
    ['discount', (input: ReturnType<typeof validV1Command>) => (input.amounts.discount = '1.00')],
    ['tax', (input: ReturnType<typeof validV1Command>) => (input.amounts.tax = '1.00')],
  ])('requires source-level allocation details for nonzero %s', (_label, mutate) => {
    const input = validV1Command()
    mutate(input)

    expect(() => migrateExternalOrderCommandV1(input, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'BREAKDOWN_REQUIRED' }),
    )
  })

  it('requires an explicit currency exponent mapping', () => {
    expect(() => migrateExternalOrderCommandV1(validV1Command(), {})).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'CURRENCY_EXPONENT_REQUIRED' }),
    )
  })

  it('rejects an invalid currency exponent mapping', () => {
    expect(() => migrateExternalOrderCommandV1(validV1Command(), { CNY: 1.5 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it.each([
    ['unknown top-level field', { secret: 'must-not-pass' }],
    ['numeric external order ID', { externalOrderId: 9_223_372_036_854_775_807 }],
    ['negative amount', { amounts: { ...validV1Command().amounts, shipping: '-1.00' } }],
    ['oversized amount', { amounts: { ...validV1Command().amounts, shipping: '1'.repeat(65) } }],
  ])('rejects %s as invalid input', (_label, override) => {
    expect(() => migrateExternalOrderCommandV1({ ...validV1Command(), ...override }, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects an incomplete legacy shipping address instead of silently dropping it', () => {
    const input = validV1Command()
    input.shippingAddress = { city: 'Shanghai' } as typeof input.shippingAddress

    expect(() => migrateExternalOrderCommandV1(input, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects a malformed known customer field while ignoring unknown fields', () => {
    const input = validV1Command()
    input.customer.name = 42

    expect(() => migrateExternalOrderCommandV1(input, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('maps v2 schema failures back to a migration error', () => {
    const input = validV1Command()
    input.customer.name = 'x'.repeat(513)

    expect(() => migrateExternalOrderCommandV1(input, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it.each([
    ['line total', (input: ReturnType<typeof validV1Command>) => (input.lines[0].totalAmount = '39.79')],
    ['goods summary', (input: ReturnType<typeof validV1Command>) => (input.amounts.goods = '39.79')],
    ['order total', (input: ReturnType<typeof validV1Command>) => (input.amounts.total = '44.79')],
  ])('rejects a %s mismatch', (_label, mutate) => {
    const input = validV1Command()
    mutate(input)

    expect(() => migrateExternalOrderCommandV1(input, { CNY: 2 })).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({ code: 'TOTAL_MISMATCH' }),
    )
  })
})
