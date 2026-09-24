import { describe, expect, it } from 'vitest'
import { validateExternalOrderCommand } from './contract'
import {
  ProjectionError,
  type ProjectionMappings,
  mapExternalOrderToMedusa,
} from './medusa-projection'

function validCommand() {
  return validateExternalOrderCommand({
    commandId: '06f81480-bcfa-4df3-9274-a1df1df08391',
    eventInboxId: '42',
    schemaVersion: 1,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: '9223372036854775807',
    externalVersion: '2026-08-10T02:00:00.000Z',
    occurredAt: '2026-08-10T02:00:00.000Z',
    currency: 'CNY',
    customer: { name: 'Synthetic Customer' },
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
  })
}

function mappings(): ProjectionMappings {
  return {
    channels: {
      '["taobao","7"]': {
        salesChannelId: 'sc_taobao_7',
        regionId: 'reg_cn',
        locationId: 'sloc_shanghai',
        shippingOptionId: 'so_external',
        currency: 'CNY',
        currencyExponent: 2,
      },
    },
    skus: {
      'SKU-001': {
        variantId: 'variant_001',
        inventoryItemId: 'iitem_001',
        title: 'Synthetic Item',
        requiresShipping: true,
      },
    },
  }
}

describe('mapExternalOrderToMedusa', () => {
  it('creates an immutable order input and post-order reservation templates', () => {
    const command = validCommand()
    const result = mapExternalOrderToMedusa(command, mappings())

    expect(result.order).toEqual({
      region_id: 'reg_cn',
      sales_channel_id: 'sc_taobao_7',
      status: 'pending',
      currency_code: 'cny',
      no_notification: true,
      shipping_address: {
        address_1: 'redacted',
        city: 'Shanghai',
        country_code: 'cn',
      },
      items: [
        {
          title: 'Synthetic Item',
          quantity: 2,
          unit_price: '19.90',
          variant_id: 'variant_001',
          variant_sku: 'SKU-001',
          requires_shipping: true,
          metadata: { external_line_id: 'line-1' },
        },
      ],
      shipping_methods: [
        {
          name: 'External platform shipping',
          amount: '5.00',
          shipping_option_id: 'so_external',
          data: { raw_payload_ref: 'channel_event_inbox:42' },
        },
      ],
      metadata: {
        source_channel: 'taobao',
        source_account_id: '7',
        external_order_id: '9223372036854775807',
        external_version: '2026-08-10T02:00:00.000Z',
        external_status: 'paid',
        command_id: '06f81480-bcfa-4df3-9274-a1df1df08391',
        raw_payload_ref: 'channel_event_inbox:42',
      },
    })
    expect(result.reservationTemplates).toEqual([
      {
        externalLineId: 'line-1',
        inventoryItemId: 'iitem_001',
        locationId: 'sloc_shanghai',
        quantity: 2,
      },
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.order.items?.[0])).toBe(true)
    expect(Object.isFrozen(command)).toBe(true)
  })

  it('rejects an unmapped channel account', () => {
    expect(() => mapExternalOrderToMedusa(validCommand(), { ...mappings(), channels: {} })).toThrowError(
      expect.objectContaining<Partial<ProjectionError>>({ code: 'CHANNEL_NOT_MAPPED' }),
    )
  })

  it('rejects an unmapped SKU before producing an order', () => {
    expect(() => mapExternalOrderToMedusa(validCommand(), { ...mappings(), skus: {} })).toThrowError(
      expect.objectContaining<Partial<ProjectionError>>({ code: 'SKU_NOT_MAPPED' }),
    )
  })

  it('rejects inconsistent goods and order totals', () => {
    const command = { ...validCommand(), amounts: { ...validCommand().amounts, total: '44.81' } }

    expect(() => mapExternalOrderToMedusa(command, mappings())).toThrowError(
      expect.objectContaining<Partial<ProjectionError>>({ code: 'TOTAL_MISMATCH' }),
    )
  })

  it('omits shipping methods when the external shipping amount is zero', () => {
    const base = validCommand()
    const command = {
      ...base,
      amounts: { ...base.amounts, shipping: '0.00', total: '39.80' },
    }

    expect(mapExternalOrderToMedusa(command, mappings()).order.shipping_methods).toEqual([])
  })

  it('rejects a mapping with an unsupported currency exponent', () => {
    const current = mappings()
    const channels = {
      ...current.channels,
      '["taobao","7"]': { ...current.channels['["taobao","7"]'], currencyExponent: 7 },
    }

    expect(() => mapExternalOrderToMedusa(validCommand(), { ...current, channels })).toThrowError(
      expect.objectContaining<Partial<ProjectionError>>({ code: 'TOTAL_MISMATCH' }),
    )
  })

  it.each([
    ['discount', { discount: '1.00', total: '43.80' }, 'DISCOUNT_BREAKDOWN_REQUIRED'],
    ['tax', { tax: '1.00', total: '45.80' }, 'TAX_BREAKDOWN_REQUIRED'],
  ] as const)('requires a line-level %s breakdown', (_label, amountOverrides, code) => {
    const base = validCommand()
    const command = { ...base, amounts: { ...base.amounts, ...amountOverrides } }

    expect(() => mapExternalOrderToMedusa(command, mappings())).toThrowError(
      expect.objectContaining<Partial<ProjectionError>>({ code }),
    )
  })
})
