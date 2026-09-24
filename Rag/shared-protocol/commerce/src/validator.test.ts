import { describe, expect, it } from 'vitest'
import { ProtocolValidationError, validateExternalOrderCommandV2 } from './index'

function validV2Command() {
  return {
    commandId: 'command-2',
    eventInboxId: '42',
    schemaVersion: 2,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: '9223372036854775807',
    externalVersion: '2026-08-10T02:00:00.000Z',
    occurredAt: '2026-08-10T02:00:00.000Z',
    currency: { code: 'CNY', exponent: 2 },
    customer: { externalCustomerId: 'customer-1', name: 'Synthetic Customer' },
    shippingAddress: {
      recipientName: 'Synthetic Customer',
      countryCode: 'CN',
      city: 'Shanghai',
      line1: 'redacted',
    },
    lines: [
      {
        externalLineId: 'line-1',
        sku: 'SKU-001',
        quantity: 2,
        unitAmount: '50.00',
        grossAmount: '100.00',
        discounts: [
          { code: 'SELLER10', amount: '10.00', funding: 'seller' },
          { code: 'PLATFORM5', amount: '5.00', funding: 'platform' },
        ],
        taxes: [{ code: 'VAT', rate: '0.13', amount: '11.05', includedInSourcePrice: false }],
        totalAmount: '96.05',
      },
    ],
    shippingLines: [
      {
        externalShippingLineId: 'shipping-1',
        methodCode: 'express',
        name: 'Express',
        grossAmount: '10.00',
        discounts: [{ code: 'SHIP2', amount: '2.00', funding: 'platform' }],
        taxes: [{ code: 'SHIP_VAT', rate: '0.06', amount: '0.48', includedInSourcePrice: false }],
        totalAmount: '8.48',
      },
    ],
    amounts: {
      itemGross: '100.00',
      itemDiscount: '15.00',
      shippingGross: '10.00',
      shippingDiscount: '2.00',
      tax: '11.53',
      total: '104.53',
    },
    normalizedStatus: 'paid',
    rawPayloadRef: 'channel_event_inbox:42',
  }
}

describe('validateExternalOrderCommandV2', () => {
  it('returns a detached deeply immutable command with complete allocations', () => {
    const input = validV2Command()
    const result = validateExternalOrderCommandV2(input)

    input.lines[0].sku = 'CHANGED'

    expect(result.lines[0].sku).toBe('SKU-001')
    expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.lines[0].discounts[0])).toBe(true)
    expect(Object.isFrozen(result.shippingLines[0].taxes[0])).toBe(true)
  })

  it.each([
    ['unknown top-level field', { credential: 'must-not-pass' }],
    ['numeric external order ID', { externalOrderId: 9_223_372_036_854_775_807 }],
    ['empty lines', { lines: [] }],
  ])('rejects %s', (_label, override) => {
    expect(() => validateExternalOrderCommandV2({ ...validV2Command(), ...override })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects negative allocations at the schema boundary', () => {
    const input = validV2Command()
    input.lines[0].discounts[0].amount = '-0.01'

    expect(() => validateExternalOrderCommandV2(input)).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects precision beyond the declared currency exponent', () => {
    const input = validV2Command()
    input.lines[0].unitAmount = '50.001'

    expect(() => validateExternalOrderCommandV2(input)).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it.each([
    ['amount', { amounts: { ...validV2Command().amounts, total: '1'.repeat(65) } }],
    ['protocol string', { rawPayloadRef: 'x'.repeat(513) }],
  ])('rejects an oversized %s at the schema boundary', (_label, override) => {
    expect(() => validateExternalOrderCommandV2({ ...validV2Command(), ...override })).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it.each([
    ['line gross', (input: ReturnType<typeof validV2Command>) => (input.lines[0].grossAmount = '100.01')],
    ['line total', (input: ReturnType<typeof validV2Command>) => (input.lines[0].totalAmount = '96.04')],
    ['shipping total', (input: ReturnType<typeof validV2Command>) => (input.shippingLines[0].totalAmount = '8.47')],
    ['item summary', (input: ReturnType<typeof validV2Command>) => (input.amounts.itemGross = '100.01')],
    ['shipping summary', (input: ReturnType<typeof validV2Command>) => (input.amounts.shippingGross = '10.01')],
    ['tax summary', (input: ReturnType<typeof validV2Command>) => (input.amounts.tax = '11.52')],
    ['order total', (input: ReturnType<typeof validV2Command>) => (input.amounts.total = '104.52')],
  ])('rejects a %s mismatch', (_label, mutate) => {
    const input = validV2Command()
    mutate(input)

    expect(() => validateExternalOrderCommandV2(input)).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'TOTAL_MISMATCH' }),
    )
  })
})
