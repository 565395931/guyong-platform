import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  CommerceUnavailableError,
  ProjectionLedgerError,
  type VendureOrderPort,
  type VendureOrderProjectionInput,
  type VendureOrderProjectionResult,
} from './types'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type HttpCommerceOrderPortOptions = Readonly<{
  endpoint: string
  keyId: string
  sharedSecret: string
  timeoutMs?: number
  allowInsecureHttp?: boolean
  now?: () => Date
  fetch?: FetchLike
}>

export type CommerceProjectionSignatureInput = Readonly<{
  authorization: string
  timestamp: string
  idempotencyKey: string
  method: string
  path: string
  body: string
  expectedKeyId: string
  sharedSecret: string
  now: Date
  maxClockSkewMs?: number
}>

const AUTH_PATTERN = /^RAG-HMAC-SHA256 keyId=([A-Za-z0-9._-]{1,64}),signature=([a-f0-9]{64})$/
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const NORMALIZED_STATUSES = new Set([
  'created',
  'paid',
  'ready_to_ship',
  'shipped',
  'delivered',
  'cancelled',
  'after_sales',
])

function canonicalRequest(
  method: string,
  path: string,
  idempotencyKey: string,
  timestamp: string,
  body: string,
): string {
  return [method.toUpperCase(), path, idempotencyKey, timestamp, body].join('\n')
}

function signature(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProjectionLedgerError('INVALID_INPUT', `${field} is invalid`)
  }
  return value
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new ProjectionLedgerError('INVALID_INPUT', `Commerce response ${field} is invalid`)
  }
  return value
}

function validateResult(value: unknown): VendureOrderProjectionResult {
  if (!value || typeof value !== 'object') {
    throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce response is invalid')
  }
  const result = value as Record<string, unknown>
  const normalizedStatus = requiredString(result.normalizedStatus, 'normalizedStatus', 30)
  if (!NORMALIZED_STATUSES.has(normalizedStatus)) {
    throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce response normalizedStatus is invalid')
  }
  return Object.freeze({
    vendureOrderId: requiredString(result.vendureOrderId, 'vendureOrderId', 512),
    orderCode: requiredString(result.orderCode, 'orderCode', 512),
    normalizedStatus: normalizedStatus as VendureOrderProjectionResult['normalizedStatus'],
    totalWithTaxMinor: requiredString(result.totalWithTaxMinor, 'totalWithTaxMinor', 100),
    appliedExternalVersion: requiredString(result.appliedExternalVersion, 'appliedExternalVersion', 100),
  })
}

function serializeInput(input: VendureOrderProjectionInput): string {
  return JSON.stringify({ schemaVersion: 1, ...input }, (_key, value) => (
    typeof value === 'bigint' ? value.toString() : value
  ))
}

export function verifyCommerceProjectionSignature(input: CommerceProjectionSignatureInput): boolean {
  try {
    const match = AUTH_PATTERN.exec(input.authorization)
    if (!match || match[1] !== input.expectedKeyId) return false
    const timestamp = new Date(input.timestamp)
    if (!Number.isFinite(timestamp.getTime())) return false
    const maxSkew = input.maxClockSkewMs ?? 300_000
    if (!Number.isSafeInteger(maxSkew) || maxSkew < 1_000 || maxSkew > 900_000) return false
    if (Math.abs(input.now.getTime() - timestamp.getTime()) > maxSkew) return false
    if (input.idempotencyKey.trim() === '' || input.idempotencyKey.length > 191) return false
    const expected = signature(input.sharedSecret, canonicalRequest(
      input.method,
      input.path,
      input.idempotencyKey,
      input.timestamp,
      input.body,
    ))
    const suppliedBuffer = Buffer.from(match[2], 'hex')
    const expectedBuffer = Buffer.from(expected, 'hex')
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer)
  } catch {
    return false
  }
}

export class HttpCommerceOrderPort implements VendureOrderPort {
  private readonly endpoint: URL
  private readonly keyId: string
  private readonly sharedSecret: string
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly fetch: FetchLike

  constructor(options: HttpCommerceOrderPortOptions) {
    let endpoint: URL
    try {
      endpoint = new URL(options.endpoint)
    } catch {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce endpoint is invalid')
    }
    const protocolAllowed = endpoint.protocol === 'https:'
      || (options.allowInsecureHttp === true && endpoint.protocol === 'http:')
    if (!protocolAllowed || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce endpoint must use HTTPS without credentials or query data')
    }
    if (!KEY_ID_PATTERN.test(options.keyId)) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce signing key identifier is invalid')
    }
    if (options.sharedSecret.length < 32 || options.sharedSecret.length > 4_096) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce signing secret is invalid')
    }
    this.endpoint = endpoint
    this.keyId = options.keyId
    this.sharedSecret = options.sharedSecret
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 'Commerce timeout', 100, 120_000)
    this.now = options.now ?? (() => new Date())
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async project(input: VendureOrderProjectionInput): Promise<VendureOrderProjectionResult> {
    const body = serializeInput(input)
    const timestamp = this.now().toISOString()
    const idempotencyKey = input.command.commandId
    const digest = signature(this.sharedSecret, canonicalRequest(
      'POST',
      this.endpoint.pathname,
      idempotencyKey,
      timestamp,
      body,
    ))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `RAG-HMAC-SHA256 keyId=${this.keyId},signature=${digest}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-rag-timestamp': timestamp,
        },
        body,
        signal: controller.signal,
      })
    } catch {
      throw new CommerceUnavailableError()
    } finally {
      clearTimeout(timeout)
    }

    if ([408, 425, 429].includes(response.status) || response.status >= 500) {
      throw new CommerceUnavailableError()
    }
    if (!response.ok) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce rejected the projection request')
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw new CommerceUnavailableError()
    }
    if (text.length > 65_536) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce response is too large')
    }
    try {
      const payload = JSON.parse(text) as { data?: unknown }
      return validateResult(payload.data)
    } catch (error) {
      if (error instanceof ProjectionLedgerError) throw error
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce response is invalid')
    }
  }
}
