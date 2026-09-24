import { describe, expect, it } from 'vitest'
import { ContractError, validateExternalOrderCommand } from './contract'

function validCommand() {
  return {
    commandId: '06f81480-bcfa-4df3-9274-a1df1df08391',
    eventInboxId: '42',
    schemaVersion: 1,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: '9223372036854775807',
    externalVersion: '2026-08-10T02:00:00.000Z',
    occurredAt: '2026-08-10T02:00:00.000Z',
    currency: 'CNY',
    customer: { name: 'Synthetic Customer', phone: '***1234' },
    shippingAddress: { countryCode: 'CN', city: 'Shanghai', line1: 'redacted' },
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
    normalizedStatus: 'paid',
    rawPayloadRef: 'channel_event_inbox:42',
  }
}

describe('validateExternalOrderCommand', () => {
  it('returns a detached, deeply immutable command', () => {
    const input = validCommand()
    const result = validateExternalOrderCommand(input)

    input.lines[0].sku = 'CHANGED'

    expect(result).not.toBe(input)
    expect(result.lines[0].sku).toBe('SKU-001')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.lines[0])).toBe(true)
  })

  it.each([
    ['numeric external order ID', { externalOrderId: 9_223_372_036_854_775_807 }],
    ['lowercase currency', { currency: 'cny' }],
    ['unsupported status', { normalizedStatus: 'unknown' }],
    ['empty lines', { lines: [] }],
    ['malformed total', { amounts: { ...validCommand().amounts, total: '44.8.0' } }],
  ])('rejects %s', (_label, override) => {
    expect(() => validateExternalOrderCommand({ ...validCommand(), ...override })).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects unknown top-level fields', () => {
    expect(() => validateExternalOrderCommand({ ...validCommand(), credential: 'must-not-pass' })).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_INPUT' }),
    )
  })
})
