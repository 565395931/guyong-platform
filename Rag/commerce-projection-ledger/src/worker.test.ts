import { describe, expect, it } from 'vitest'
import {
  CommerceUnavailableError,
  InMemoryProjectionLedgerStore,
  ProjectionCoordinator,
  ProjectionLedgerError,
  ProjectionWorker,
  createFailureDisposition,
  type ProjectionCommandSource,
  type VendureOrderPort,
} from './index'

const START = new Date('2026-08-11T04:00:00.000Z')

function validCommand() {
  return {
    commandId: 'command-2',
    eventInboxId: '42',
    schemaVersion: 2,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: 'order-1',
    externalVersion: '2026-08-11T04:00:00.000Z',
    occurredAt: '2026-08-11T04:00:00.000Z',
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
  }
}

function createHarness(source?: ProjectionCommandSource) {
  let now = START
  const store = new InMemoryProjectionLedgerStore({
    accounts: [{ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' }],
    skus: [{ channel: 'taobao', accountId: 7, sku: 'SKU-001', vendureProductVariantId: 'variant-1' }],
  }, { now: () => now })
  let calls = 0
  const vendure: VendureOrderPort = {
    async project(input) {
      calls += 1
      return {
        vendureOrderId: 'vendure-order-1',
        orderCode: 'A0001',
        normalizedStatus: input.command.normalizedStatus,
        totalWithTaxMinor: '1000',
        appliedExternalVersion: input.command.externalVersion,
      }
    },
  }
  const coordinator = new ProjectionCoordinator({
    store,
    vendure,
    compareExternalVersions: (incoming, current) => incoming.localeCompare(current),
    now: () => now,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_500 },
  })
  const worker = new ProjectionWorker({
    store,
    coordinator,
    commandSource: source ?? { load: async () => validCommand() },
    now: () => now,
    batchSize: 10,
    leaseTimeoutMs: 30_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_500 },
  })
  return {
    store,
    worker,
    getCalls: () => calls,
    setNow: (value: Date) => { now = value },
  }
}

async function seedRetryable(store: InMemoryProjectionLedgerStore, nextAttemptAt = START) {
  const created = await store.createOrGetJob({
    id: 'job-1',
    eventInboxId: '42',
    commandId: 'command-2',
    commandRef: 'channel_event_inbox:42',
    identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
    externalVersion: '2026-08-11T04:00:00.000Z',
  })
  await store.markFailed(created.job.id, {
    code: 'COMMERCE_UNAVAILABLE',
    message: 'Commerce dependency is temporarily unavailable',
    retryable: true,
    nextAttemptAt,
  })
}

describe('projection retry policy', () => {
  it('uses capped exponential backoff and dead-letters exhausted work', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_500 }
    const error = new CommerceUnavailableError()

    expect(createFailureDisposition({ attempts: 1 }, error, policy, START)).toMatchObject({
      retryable: true,
      nextAttemptAt: new Date('2026-08-11T04:00:01.000Z'),
    })
    expect(createFailureDisposition({ attempts: 2 }, error, policy, START)).toMatchObject({
      retryable: true,
      nextAttemptAt: new Date('2026-08-11T04:00:01.500Z'),
    })
    const exhausted = createFailureDisposition({ attempts: 3 }, error, policy, START)
    expect(exhausted).toMatchObject({ retryable: false })
    expect(exhausted).not.toHaveProperty('nextAttemptAt')
  })
})

describe('ProjectionWorker', () => {
  it('claims due work and completes it through the coordinator', async () => {
    const harness = createHarness()
    await seedRetryable(harness.store)

    const summary = await harness.worker.runOnce()

    expect(summary).toEqual({ recovered: 0, listed: 1, claimed: 1, succeeded: 1, failed: 0, skipped: 0 })
    expect(harness.getCalls()).toBe(1)
    await expect(harness.store.getJobByEventInboxId('42')).resolves.toMatchObject({ status: 'succeeded', attempts: 2 })
  })

  it('does not claim a job before its retry time', async () => {
    const harness = createHarness()
    await seedRetryable(harness.store, new Date(START.getTime() + 1_000))

    await expect(harness.worker.runOnce()).resolves.toMatchObject({ listed: 0, claimed: 0 })
    expect(harness.getCalls()).toBe(0)
  })

  it('lets only one concurrent worker execute the same job', async () => {
    const harness = createHarness()
    await seedRetryable(harness.store)

    const summaries = await Promise.all([harness.worker.runOnce(), harness.worker.runOnce()])

    expect(summaries.reduce((total, value) => total + value.claimed, 0)).toBe(1)
    expect(harness.getCalls()).toBe(1)
  })

  it('backs off a sanitized command-source outage', async () => {
    const harness = createHarness({ load: async () => { throw new Error('password=secret') } })
    await seedRetryable(harness.store)

    await expect(harness.worker.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 })
    await expect(harness.store.getJobByEventInboxId('42')).resolves.toMatchObject({
      status: 'retryable_failed',
      attempts: 2,
      lastErrorMessage: 'Commerce dependency is temporarily unavailable',
      nextAttemptAt: '2026-08-11T04:00:02.000Z',
    })
  })

  it('recovers an expired processing lease before running work', async () => {
    const harness = createHarness()
    await harness.store.createOrGetJob({
      id: 'job-1',
      eventInboxId: '42',
      commandId: 'command-2',
      commandRef: 'channel_event_inbox:42',
      identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
      externalVersion: '2026-08-11T04:00:00.000Z',
    })
    harness.setNow(new Date(START.getTime() + 31_000))

    await expect(harness.worker.runOnce()).resolves.toMatchObject({ recovered: 1, claimed: 1, succeeded: 1 })
    expect(harness.getCalls()).toBe(1)
  })

  it('moves exhausted command-source work to terminal failure', async () => {
    const harness = createHarness({ load: async () => { throw new Error('upstream unavailable') } })
    await seedRetryable(harness.store)

    await harness.worker.runOnce()
    harness.setNow(new Date(START.getTime() + 2_000))
    await harness.worker.runOnce()

    await expect(harness.store.getJobByEventInboxId('42')).resolves.toMatchObject({
      status: 'terminal_failed',
      attempts: 3,
      lastErrorCode: 'COMMERCE_UNAVAILABLE',
    })
  })

  it('keeps a command-source validation error terminal', async () => {
    const harness = createHarness({
      load: async () => { throw new ProjectionLedgerError('INVALID_INPUT', 'invalid normalized command') },
    })
    await seedRetryable(harness.store)

    await harness.worker.runOnce()

    await expect(harness.store.getJobByEventInboxId('42')).resolves.toMatchObject({
      status: 'terminal_failed',
      attempts: 2,
      lastErrorCode: 'INVALID_INPUT',
      lastErrorMessage: 'Projection input or dependency response is invalid',
    })
  })

  it('rejects unsafe worker bounds at construction', () => {
    const harness = createHarness()
    expect(() => new ProjectionWorker({
      store: harness.store,
      coordinator: {} as ProjectionCoordinator,
      commandSource: { load: async () => validCommand() },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_500 },
      batchSize: 0,
    })).toThrow(RangeError)
  })
})
