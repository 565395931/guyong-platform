import { describe, expect, it } from 'vitest'
import {
  ProjectionContractError,
  createExternalOrderKey,
  toMinorUnits,
  validateExternalOrderCommand,
} from './external-order-contract'

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
    customer: { name: 'Test Customer', phone: '***1234' },
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
  it('returns a detached immutable command for valid input', () => {
    const input = validCommand()
    const result = validateExternalOrderCommand(input)

    input.lines[0].sku = 'CHANGED'

    expect(result).not.toBe(input)
    expect(result.lines[0].sku).toBe('SKU-001')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.lines)).toBe(true)
    expect(Object.isFrozen(result.lines[0])).toBe(true)
  })

  it('rejects an unsafe numeric external order identifier', () => {
    const input = { ...validCommand(), externalOrderId: Number.MAX_SAFE_INTEGER + 1 }

    expect(() => validateExternalOrderCommand(input)).toThrowError(
      new ProjectionContractError('INVALID_INPUT', 'externalOrderId must be a non-empty string'),
    )
  })

  it('rejects unsupported normalized states', () => {
    const input = { ...validCommand(), normalizedStatus: 'unknown' }

    expect(() => validateExternalOrderCommand(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects a line without a mapped SKU reference', () => {
    const input = validCommand()
    input.lines = [{ ...input.lines[0], sku: '' }]

    expect(() => validateExternalOrderCommand(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects malformed decimal amounts', () => {
    const input = validCommand()
    input.amounts.total = '44.8.0'

    expect(() => validateExternalOrderCommand(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})

describe('toMinorUnits', () => {
  it('converts decimal strings without floating-point arithmetic', () => {
    expect(toMinorUnits('19.90', 2)).toBe(1990n)
    expect(toMinorUnits('-0.01', 2)).toBe(-1n)
    expect(toMinorUnits('100', 0)).toBe(100n)
  })

  it('rejects precision that exceeds the currency exponent', () => {
    expect(() => toMinorUnits('1.001', 2)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})

describe('createExternalOrderKey', () => {
  it('creates deterministic collision-resistant compound keys', () => {
    expect(createExternalOrderKey('taobao', 1, '2:3')).toBe(createExternalOrderKey('taobao', 1, '2:3'))
    expect(createExternalOrderKey('taobao', 1, '2:3')).not.toBe(createExternalOrderKey('taobao', '1:2', '3'))
  })
})
