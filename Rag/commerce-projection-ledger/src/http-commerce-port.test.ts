import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CommerceUnavailableError,
  HttpCommerceOrderPort,
  ProjectionLedgerError,
  verifyCommerceProjectionSignature,
  type VendureOrderProjectionInput,
} from './index'

const NOW = new Date('2026-08-11T05:00:00.000Z')
const SECRET = 'commerce-shared-secret-with-32-characters'

function input(): VendureOrderProjectionInput {
  return {
    command: {
      commandId: 'command-2',
      eventInboxId: 42n,
      schemaVersion: 2,
      channel: 'taobao',
      accountId: 7,
      externalOrderId: 'order-1',
      externalVersion: '2026-08-11T05:00:00.000Z',
      occurredAt: '2026-08-11T05:00:00.000Z',
      currency: { code: 'CNY', exponent: 2 },
      customer: { name: 'Synthetic Customer' },
      shippingAddress: { countryCode: 'CN', line1: 'redacted' },
      lines: [{
        externalLineId: 'line-1',
        sku: 'SKU-001',
        quantity: 1,
        unitAmount: '10.00',
        grossAmount: '10.00',
        discounts: [],
        taxes: [],
        totalAmount: '10.00',
      }],
      shippingLines: [],
      amounts: {
        itemGross: '10.00',
        itemDiscount: '0.00',
        shippingGross: '0.00',
        shippingDiscount: '0.00',
        tax: '0.00',
        total: '10.00',
      },
      normalizedStatus: 'paid',
      rawPayloadRef: 'channel_event_inbox:42',
    },
    vendureChannelId: 'channel-7',
    variantMappings: { 'SKU-001': 'variant-1' },
  }
}

const successResult = {
  vendureOrderId: 'vendure-order-1',
  orderCode: 'A0001',
  normalizedStatus: 'paid',
  totalWithTaxMinor: '1000',
  appliedExternalVersion: '2026-08-11T05:00:00.000Z',
}

describe('HttpCommerceOrderPort', () => {
  it('posts a signed idempotent request and validates the response', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const port = new HttpCommerceOrderPort({
      endpoint: 'https://commerce.internal.example/internal/v1/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
      now: () => NOW,
      fetch: async (url, init) => {
        captured = { url: String(url), init: init ?? {} }
        return new Response(JSON.stringify({ data: successResult }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(port.project(input())).resolves.toEqual(successResult)
    expect(captured?.url).toBe('https://commerce.internal.example/internal/v1/order-projections')
    expect(captured?.init.method).toBe('POST')
    const headers = new Headers(captured?.init.headers)
    expect(headers.get('idempotency-key')).toBe('command-2')
    expect(headers.get('x-rag-timestamp')).toBe(NOW.toISOString())
    expect(verifyCommerceProjectionSignature({
      authorization: headers.get('authorization') ?? '',
      timestamp: headers.get('x-rag-timestamp') ?? '',
      idempotencyKey: headers.get('idempotency-key') ?? '',
      method: 'POST',
      path: '/internal/v1/order-projections',
      body: String(captured?.init.body),
      expectedKeyId: 'rag-worker',
      sharedSecret: SECRET,
      now: NOW,
    })).toBe(true)
  })

  it('rejects a tampered body and stale timestamp during signature verification', () => {
    const body = '{"hello":"world"}'
    const digest = createHmac('sha256', SECRET)
      .update(`POST\n/internal/v1/order-projections\ncommand-2\n${NOW.toISOString()}\n${body}`)
      .digest('hex')
    const authorization = `RAG-HMAC-SHA256 keyId=rag-worker,signature=${digest}`
    const base = {
      authorization,
      timestamp: NOW.toISOString(),
      idempotencyKey: 'command-2',
      method: 'POST',
      path: '/internal/v1/order-projections',
      expectedKeyId: 'rag-worker',
      sharedSecret: SECRET,
    }

    expect(verifyCommerceProjectionSignature({ ...base, body, now: NOW })).toBe(true)
    expect(verifyCommerceProjectionSignature({ ...base, body: '{}', now: NOW })).toBe(false)
    expect(verifyCommerceProjectionSignature({
      ...base,
      body,
      now: new Date(NOW.getTime() + 300_001),
    })).toBe(false)
  })

  it('blocks plaintext endpoints unless explicitly enabled for local tests', () => {
    expect(() => new HttpCommerceOrderPort({
      endpoint: 'http://commerce.internal/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
    })).toThrow(ProjectionLedgerError)
  })

  it.each([429, 500, 503])('classifies HTTP %s as retryable without leaking the response body', async (status) => {
    const port = new HttpCommerceOrderPort({
      endpoint: 'https://commerce.internal/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
      fetch: async () => new Response('token=do-not-persist', { status }),
    })

    await expect(port.project(input())).rejects.toEqual(new CommerceUnavailableError())
  })

  it('classifies a semantic rejection and malformed success as terminal input failures', async () => {
    const rejected = new HttpCommerceOrderPort({
      endpoint: 'https://commerce.internal/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
      fetch: async () => new Response('{}', { status: 422 }),
    })
    const malformed = new HttpCommerceOrderPort({
      endpoint: 'https://commerce.internal/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
      fetch: async () => new Response(JSON.stringify({ data: { orderCode: 'missing-fields' } }), { status: 200 }),
    })

    await expect(rejected.project(input())).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false })
    await expect(malformed.project(input())).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false })
  })

  it('turns a transport failure into a sanitized retryable outage', async () => {
    const port = new HttpCommerceOrderPort({
      endpoint: 'https://commerce.internal/order-projections',
      keyId: 'rag-worker',
      sharedSecret: SECRET,
      fetch: async () => { throw new Error('connect ECONNREFUSED secret-host') },
    })

    await expect(port.project(input())).rejects.toEqual(new CommerceUnavailableError())
  })
})

