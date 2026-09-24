const test = require('node:test')
const assert = require('node:assert/strict')

const { ProjectionLedgerError } = require('@rag/commerce-projection-ledger')
const { validateExternalOrderCommandV2 } = require('@rag/commerce-protocol')
const TaobaoCommerceAdapter = require('../channel-adapters/taobao-commerce/taobaoAdapter')
const {
  createChannelEventProjectionCommandSource
} = require('./commerceProjectionSource')

function command() {
  return {
    commandId: 'command-42',
    schemaVersion: 2,
    externalVersion: '2026-08-11T06:00:00.000Z',
    occurredAt: '2026-08-11T06:00:00.000Z',
    currency: { code: 'CNY', exponent: 2 },
    customer: { name: 'Synthetic Customer' },
    shippingAddress: { countryCode: 'CN', line1: 'redacted' },
    lines: [],
    shippingLines: [],
    amounts: {
      itemGross: '0.00', itemDiscount: '0.00', shippingGross: '0.00',
      shippingDiscount: '0.00', tax: '0.00', total: '0.00'
    },
    normalizedStatus: 'paid'
  }
}

test('loads only the normalized projection command and binds identity from the inbox row', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options) {
      calls.push({ sql, options })
      return [[{
        id: '42',
        channel: 'taobao',
        account_id: 7,
        business_key: 'order-1',
        payload_json: JSON.stringify({
          projectionCommand: {
            ...command(),
            channel: 'forged',
            accountId: 999,
            externalOrderId: 'forged-order',
            eventInboxId: '999',
            rawPayloadRef: 'forged:999'
          },
          rawOrder: { receiver_mobile: 'not-returned' }
        })
      }], {}]
    }
  }
  const source = createChannelEventProjectionCommandSource(sequelize)

  const result = await source.load('channel_event_inbox:42')

  assert.equal(result.channel, 'taobao')
  assert.equal(result.accountId, 7)
  assert.equal(result.externalOrderId, 'order-1')
  assert.equal(result.eventInboxId, '42')
  assert.equal(result.rawPayloadRef, 'channel_event_inbox:42')
  assert.equal(result.rawOrder, undefined)
  assert.deepEqual(calls[0].options.replacements, { eventInboxId: '42' })
  assert.doesNotMatch(calls[0].sql, /receiver_mobile/)
})

test('rejects malformed references and events without normalized commands', async () => {
  let calls = 0
  const source = createChannelEventProjectionCommandSource({
    async query() {
      calls += 1
      return [[{
        id: '42', channel: 'taobao', account_id: 7, business_key: 'order-1',
        payload_json: JSON.stringify({ rawOrder: {} })
      }], {}]
    }
  })

  await assert.rejects(
    source.load('channel_event_inbox:42 OR 1=1'),
    error => error instanceof ProjectionLedgerError && error.code === 'INVALID_INPUT'
  )
  assert.equal(calls, 0)
  await assert.rejects(
    source.load('channel_event_inbox:42'),
    error => error instanceof ProjectionLedgerError && error.code === 'INVALID_INPUT'
  )
})

test('lists projection-ready events that do not already have ledger jobs', async () => {
  const calls = []
  const source = createChannelEventProjectionCommandSource({
    async query(sql, options) {
      calls.push({ sql, options })
      return [[{ id: '42' }, { id: '43' }], {}]
    }
  })

  assert.deepEqual(await source.listPendingRefs(25), [
    'channel_event_inbox:42',
    'channel_event_inbox:43'
  ])
  assert.match(calls[0].sql, /JSON_EXTRACT\(events\.payload_json/)
  assert.match(calls[0].sql, /LEFT JOIN commerce_projection_jobs/)
  assert.deepEqual(calls[0].options.replacements, { limit: 25 })
  await assert.rejects(source.listPendingRefs(0), RangeError)
})

test('loads and validates a complete adapter command with authoritative inbox identity', async () => {
  const adapter = new TaobaoCommerceAdapter()
  const event = adapter.normalizeOrder({
    tid: 'T-chain',
    modified: '2026-08-11 14:00:00',
    buyer_open_uid: 'buyer-chain',
    projection: {
      currency: 'CNY',
      currencyExponent: 2,
      status: 'paid',
      lines: [{
        id: 'line-chain', sku: 'sku-chain', quantity: 2,
        unitAmount: '10.00', grossAmount: '20.00', discounts: [], taxes: [],
        totalAmount: '20.00'
      }],
      shipping: '5.00',
      shippingDiscounts: [],
      shippingTaxes: [],
      total: '25.00'
    }
  }, { accountId: 7 })
  const source = createChannelEventProjectionCommandSource({
    async query() {
      return [[{
        id: '88', channel: event.channel, account_id: event.accountId,
        business_key: event.businessKey, payload_json: JSON.stringify(event.payload)
      }], {}]
    }
  })

  const command = validateExternalOrderCommandV2(await source.load('channel_event_inbox:88'))

  assert.equal(command.eventInboxId, '88')
  assert.equal(command.rawPayloadRef, 'channel_event_inbox:88')
  assert.equal(command.externalOrderId, 'T-chain')
  assert.equal(command.amounts.total, '25.00')
})
