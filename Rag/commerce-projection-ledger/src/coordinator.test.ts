import { describe, expect, it } from 'vitest'
import {
  CommerceUnavailableError,
  InMemoryProjectionLedgerStore,
  ProjectionCoordinator,
  ProjectionLedgerError,
  type VendureOrderProjectionInput,
  type VendureOrderProjectionResult,
  type VendureOrderPort,
} from './index'

function validCommand(overrides: Record<string, unknown> = {}) {
  return {
    commandId: 'command-2',
    eventInboxId: '42',
    schemaVersion: 2,
    channel: 'taobao',
    accountId: 7,
    externalOrderId: 'order-1',
    externalVersion: '2026-08-10T02:00:00.000Z',
    occurredAt: '2026-08-10T02:00:00.000Z',
    currency: { code: 'CNY', exponent: 2 },
    customer: { name: 'Synthetic Customer' },
    shippingAddress: { countryCode: 'CN', line1: 'redacted' },
    lines: [
      {
        externalLineId: 'line-1',
        sku: 'SKU-001',
        quantity: 2,
        unitAmount: '19.90',
        grossAmount: '39.80',
        discounts: [],
        taxes: [],
        totalAmount: '39.80',
      },
    ],
    shippingLines: [
      {
        externalShippingLineId: 'shipping-1',
        methodCode: 'express',
        name: 'Express',
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
    normalizedStatus: 'paid',
    rawPayloadRef: 'channel_event_inbox:42',
    ...overrides,
  }
}

class FakeVendurePort implements VendureOrderPort {
  readonly calls: VendureOrderProjectionInput[] = []
  echoCommand = true
  result: VendureOrderProjectionResult = {
    vendureOrderId: 'vendure-order-1',
    orderCode: 'A0001',
    normalizedStatus: 'paid',
    totalWithTaxMinor: '4480',
    appliedExternalVersion: '2026-08-10T02:00:00.000Z',
  }
  error?: Error

  async project(input: VendureOrderProjectionInput): Promise<VendureOrderProjectionResult> {
    this.calls.push(input)
    if (this.error) throw this.error
    return {
      ...this.result,
      normalizedStatus: this.echoCommand ? input.command.normalizedStatus : this.result.normalizedStatus,
      appliedExternalVersion: this.echoCommand ? input.command.externalVersion : this.result.appliedExternalVersion,
    }
  }
}

function createCoordinator(
  store = new InMemoryProjectionLedgerStore({
    accounts: [{ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' }],
    skus: [{ channel: 'taobao', accountId: 7, sku: 'SKU-001', vendureProductVariantId: 'variant-1' }],
  }),
  vendure = new FakeVendurePort(),
) {
  let nextJobId = 0
  return {
    coordinator: new ProjectionCoordinator({
      store,
      vendure,
      compareExternalVersions: (incoming, current) => incoming.localeCompare(current),
      createJobId: () => `job-${++nextJobId}`,
    }),
    store,
    vendure,
  }
}

describe('ProjectionCoordinator', () => {
  it('creates a projection and is idempotent for duplicate events', async () => {
    const { coordinator, vendure } = createCoordinator()

    const first = await coordinator.projectExternalOrder(validCommand())
    const duplicate = await coordinator.projectExternalOrder(validCommand())

    expect(first).toMatchObject({ kind: 'created', vendureOrderId: 'vendure-order-1' })
    expect(duplicate).toMatchObject({ kind: 'duplicate', vendureOrderId: 'vendure-order-1' })
    expect(vendure.calls).toHaveLength(1)
  })

  it('calls Vendure once when the same event is processed concurrently', async () => {
    const { coordinator, vendure } = createCoordinator()

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => coordinator.projectExternalOrder(validCommand())),
    )

    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(9)
    expect(vendure.calls).toHaveLength(1)
  })

  it('updates the same external order when the version is newer', async () => {
    const { coordinator, vendure } = createCoordinator()
    await coordinator.projectExternalOrder(validCommand())

    const updated = await coordinator.projectExternalOrder(
      validCommand({
        commandId: 'command-3',
        eventInboxId: '43',
        externalVersion: '2026-08-10T03:00:00.000Z',
        occurredAt: '2026-08-10T03:00:00.000Z',
        normalizedStatus: 'ready_to_ship',
        rawPayloadRef: 'channel_event_inbox:43',
      }),
    )

    expect(updated).toMatchObject({ kind: 'updated', vendureOrderId: 'vendure-order-1' })
    expect(vendure.calls).toHaveLength(2)
    expect(vendure.calls[1].existingVendureOrderId).toBe('vendure-order-1')
  })

  it('does not apply an older version', async () => {
    const { coordinator, vendure } = createCoordinator()
    await coordinator.projectExternalOrder(validCommand())

    const stale = await coordinator.projectExternalOrder(
      validCommand({
        commandId: 'command-1',
        eventInboxId: '41',
        externalVersion: '2026-08-10T01:00:00.000Z',
        occurredAt: '2026-08-10T01:00:00.000Z',
        rawPayloadRef: 'channel_event_inbox:41',
      }),
    )

    expect(stale).toMatchObject({ kind: 'stale', vendureOrderId: 'vendure-order-1' })
    expect(vendure.calls).toHaveLength(1)
  })

  it.each([
    ['account', new InMemoryProjectionLedgerStore({ skus: [{ channel: 'taobao', accountId: 7, sku: 'SKU-001', vendureProductVariantId: 'variant-1' }] }), 'ACCOUNT_MAPPING_MISSING'],
    ['SKU', new InMemoryProjectionLedgerStore({ accounts: [{ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' }] }), 'SKU_MAPPING_MISSING'],
  ])('blocks projection when %s mapping is missing', async (_label, store, code) => {
    const { coordinator, vendure } = createCoordinator(store)

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({ code })
    expect(vendure.calls).toHaveLength(0)
    await expect(store.getJobByEventInboxId('42')).resolves.toMatchObject({ status: 'terminal_failed', lastErrorCode: code })
  })

  it('rejects a state transition that would move a delivered order backwards', async () => {
    const store = new InMemoryProjectionLedgerStore({
      accounts: [{ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' }],
      skus: [{ channel: 'taobao', accountId: 7, sku: 'SKU-001', vendureProductVariantId: 'variant-1' }],
      links: [{
        identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
        vendureOrderId: 'vendure-order-1',
        orderCode: 'A0001',
        externalVersion: '2026-08-10T02:00:00.000Z',
        normalizedStatus: 'delivered',
        lastEventInboxId: '42',
      }],
    })
    const { coordinator, vendure } = createCoordinator(store)

    await expect(
      coordinator.projectExternalOrder(validCommand({
        eventInboxId: '43',
        commandId: 'command-3',
        externalVersion: '2026-08-10T03:00:00.000Z',
        occurredAt: '2026-08-10T03:00:00.000Z',
        normalizedStatus: 'shipped',
        rawPayloadRef: 'channel_event_inbox:43',
      })),
    ).rejects.toMatchObject<Partial<ProjectionLedgerError>>({ code: 'STATE_TRANSITION_DENIED' })
    expect(vendure.calls).toHaveLength(0)
  })

  it('rejects a new order that starts in a fulfilled state', async () => {
    const { coordinator, store, vendure } = createCoordinator()

    await expect(
      coordinator.projectExternalOrder(validCommand({ normalizedStatus: 'shipped' })),
    ).rejects.toMatchObject({ code: 'STATE_TRANSITION_DENIED' })
    expect(vendure.calls).toHaveLength(0)
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'terminal_failed' })
  })

  it('marks commerce outages retryable and succeeds on retry', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.error = new CommerceUnavailableError()

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'COMMERCE_UNAVAILABLE',
      retryable: true,
    })
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'retryable_failed', attempts: 1 })

    vendure.error = undefined
    const retried = await coordinator.projectExternalOrder(validCommand())
    expect(retried).toMatchObject({ kind: 'created', vendureOrderId: 'vendure-order-1' })
    expect(vendure.calls).toHaveLength(2)
  })

  it('classifies a Vendure total mismatch as terminal', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.result = { ...vendure.result, totalWithTaxMinor: '4481' }

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'TOTAL_MISMATCH',
      retryable: false,
    })
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'terminal_failed' })
  })

  it('classifies an unknown port error as a retryable commerce outage', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.error = new Error('transport failed')

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'COMMERCE_UNAVAILABLE',
      retryable: true,
    })
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'retryable_failed' })
  })

  it('does not persist sensitive port error details', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.error = new ProjectionLedgerError('COMMERCE_UNAVAILABLE', 'token=secret-value', true)

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'COMMERCE_UNAVAILABLE',
      message: 'Commerce dependency is temporarily unavailable',
    })
    await expect(store.getJobByEventInboxId('42')).resolves.toMatchObject({
      lastErrorMessage: 'Commerce dependency is temporarily unavailable',
    })
  })

  it('rejects an unexpected version returned by Vendure', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.echoCommand = false
    vendure.result = { ...vendure.result, appliedExternalVersion: 'unexpected-version' }

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      retryable: false,
    })
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'terminal_failed' })
  })

  it('rejects an empty Vendure order identifier', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    vendure.result = { ...vendure.result, vendureOrderId: '' }

    await expect(coordinator.projectExternalOrder(validCommand())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      retryable: false,
    })
    expect(await store.getJobByEventInboxId('42')).toMatchObject({ status: 'terminal_failed' })
  })

  it('returns a frozen duplicate while another job is processing', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    await store.createOrGetJob({
      id: 'job-1',
      eventInboxId: '42',
      commandId: 'command-2',
      commandRef: 'channel_event_inbox:42',
      identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
      externalVersion: '2026-08-10T02:00:00.000Z',
    })
    await store.claimJob('job-1')

    const duplicate = await coordinator.projectExternalOrder(validCommand())
    expect(duplicate).toMatchObject({ kind: 'duplicate', jobId: 'job-1' })
    expect(Object.isFrozen(duplicate)).toBe(true)
    expect(vendure.calls).toHaveLength(0)
  })

  it('rejects updates for unknown job identifiers in the memory store', async () => {
    const { store } = createCoordinator()

    await expect(store.claimJob('missing-job')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects a job ID collision across different events', async () => {
    const { store } = createCoordinator()
    const base = {
      id: 'job-1',
      commandId: 'command-2',
      commandRef: 'channel_event_inbox:42',
      identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
      externalVersion: '2026-08-10T02:00:00.000Z',
    }
    await store.createOrGetJob({ ...base, eventInboxId: '42' })

    await expect(store.createOrGetJob({ ...base, eventInboxId: '43' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('rejects protocol input before creating a job', async () => {
    const { coordinator, store } = createCoordinator()

    await expect(coordinator.projectExternalOrder({ ...validCommand(), externalOrderId: 42 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(store.getJobByEventInboxId('42')).resolves.toBeUndefined()
  })

  it('rejects a claimed job when its resolved command does not match the ledger identity', async () => {
    const { coordinator, store, vendure } = createCoordinator()
    const { job } = await store.createOrGetJob({
      id: 'job-1',
      eventInboxId: '42',
      commandId: 'command-2',
      commandRef: 'channel_event_inbox:42',
      identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
      externalVersion: '2026-08-10T02:00:00.000Z',
    })

    await expect(
      coordinator.projectClaimedExternalOrder(job, validCommand({ externalOrderId: 'different-order' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false })
    expect(vendure.calls).toHaveLength(0)
    await expect(store.getJobByEventInboxId('42')).resolves.toMatchObject({ status: 'terminal_failed' })
  })
})
