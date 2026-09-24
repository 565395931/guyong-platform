import type { NormalizedOrderStatus } from '@rag/commerce-protocol'
import {
  ProjectionLedgerError,
  type AccountMapping,
  type NewProjectionJob,
  type OrderIdentity,
  type OrderLink,
  type ProjectionErrorCode,
  type ProjectionFailureDisposition,
  type ProjectionJob,
  type ProjectionJobStatus,
  type ProjectionLedgerStore,
  type ProjectionOutcome,
  type SkuMapping,
} from './types'

export type SqlQueryOptions = Readonly<{
  replacements?: Readonly<Record<string, unknown>>
  transaction?: unknown
}>

export interface SqlExecutor {
  query(
    sql: string,
    options?: SqlQueryOptions,
  ): Promise<readonly [readonly Record<string, unknown>[], unknown]>
  transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T>
}

const JOB_STATUSES = new Set<ProjectionJobStatus>([
  'pending',
  'processing',
  'retryable_failed',
  'terminal_failed',
  'succeeded',
])
const ORDER_STATUSES = new Set<NormalizedOrderStatus>([
  'created',
  'paid',
  'ready_to_ship',
  'shipped',
  'delivered',
  'cancelled',
  'after_sales',
])
const ERROR_CODES = new Set<ProjectionErrorCode>([
  'INVALID_INPUT',
  'TOTAL_MISMATCH',
  'ACCOUNT_MAPPING_MISSING',
  'SKU_MAPPING_MISSING',
  'STALE_EVENT',
  'STATE_TRANSITION_DENIED',
  'COMMERCE_UNAVAILABLE',
])
const UINT64_MAX = 18_446_744_073_709_551_615n

function invalid(message: string): never {
  throw new ProjectionLedgerError('INVALID_INPUT', message)
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    invalid(`${field} is invalid`)
  }
  return value
}

function accountId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('accountId is invalid')
  return value
}

function eventInboxId(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) > UINT64_MAX) {
    invalid('eventInboxId is invalid')
  }
  return text
}

function affectedRows(metadata: unknown): number {
  if (typeof metadata === 'number') return metadata
  if (metadata && typeof metadata === 'object' && 'affectedRows' in metadata) {
    const value = (metadata as { affectedRows?: unknown }).affectedRows
    return typeof value === 'number' ? value : 0
  }
  return 0
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(`${field} is invalid`)
  return new Date(value.getTime())
}

function batchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) invalid('Projection batch limit is invalid')
  return value
}

function storedTimestamp(value: unknown, field: string): string | undefined {
  if (value == null) return undefined
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) invalid(`${field} is invalid`)
  return parsed.toISOString()
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((nested) => deepFreeze(nested))
    Object.freeze(value)
  }
  return value
}

function freezeCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function parseOutcome(value: unknown): ProjectionOutcome | undefined {
  if (value == null) return undefined
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' ? freezeCopy(parsed as ProjectionOutcome) : undefined
  } catch {
    invalid('Stored projection outcome is invalid')
  }
}

function mapJob(row: Record<string, unknown>): ProjectionJob {
  const status = boundedString(row.status, 'job status', 30) as ProjectionJobStatus
  if (!JOB_STATUSES.has(status)) invalid('Stored projection job status is invalid')
  const attempts = Number(row.attempts)
  if (!Number.isSafeInteger(attempts) || attempts < 0) invalid('Stored projection attempts are invalid')
  const outcome = parseOutcome(row.outcome_json)
  const lastErrorCode = row.last_error_code ? String(row.last_error_code) as ProjectionErrorCode : undefined
  if (lastErrorCode && !ERROR_CODES.has(lastErrorCode)) invalid('Stored projection error code is invalid')

  return freezeCopy({
    id: boundedString(row.id, 'job id', 36),
    eventInboxId: eventInboxId(String(row.event_inbox_id)),
    commandId: boundedString(row.command_id, 'command id', 191),
    commandRef: boundedString(row.command_ref, 'command ref', 512),
    identity: {
      channel: boundedString(row.channel, 'channel', 30),
      accountId: accountId(Number(row.account_id)),
      externalOrderId: boundedString(row.external_order_id, 'external order id', 160),
    },
    externalVersion: boundedString(row.external_version, 'external version', 100),
    status,
    attempts,
    ...(storedTimestamp(row.next_attempt_at, 'next attempt timestamp') ? {
      nextAttemptAt: storedTimestamp(row.next_attempt_at, 'next attempt timestamp'),
    } : {}),
    ...(storedTimestamp(row.locked_at, 'lock timestamp') ? {
      lockedAt: storedTimestamp(row.locked_at, 'lock timestamp'),
    } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    ...(row.last_error_message ? { lastErrorMessage: boundedString(String(row.last_error_message), 'error message', 500) } : {}),
    ...(outcome ? { outcome } : {}),
  })
}

function mapOrderLink(row: Record<string, unknown>): OrderLink {
  const normalizedStatus = boundedString(row.normalized_status, 'normalized status', 30) as NormalizedOrderStatus
  if (!ORDER_STATUSES.has(normalizedStatus)) invalid('Stored order status is invalid')
  return freezeCopy({
    identity: {
      channel: boundedString(row.channel, 'channel', 30),
      accountId: accountId(Number(row.account_id)),
      externalOrderId: boundedString(row.external_order_id, 'external order id', 160),
    },
    vendureOrderId: boundedString(row.vendure_order_id, 'Vendure order id', 64),
    orderCode: boundedString(row.order_code, 'order code', 64),
    externalVersion: boundedString(row.external_version, 'external version', 100),
    normalizedStatus,
    lastEventInboxId: eventInboxId(String(row.last_event_inbox_id)),
  })
}

function validateJobInput(input: NewProjectionJob): NewProjectionJob {
  return {
    id: boundedString(input.id, 'job id', 36),
    eventInboxId: eventInboxId(input.eventInboxId),
    commandId: boundedString(input.commandId, 'command id', 191),
    commandRef: boundedString(input.commandRef, 'command ref', 512),
    identity: {
      channel: boundedString(input.identity.channel, 'channel', 30),
      accountId: accountId(input.identity.accountId),
      externalOrderId: boundedString(input.identity.externalOrderId, 'external order id', 160),
    },
    externalVersion: boundedString(input.externalVersion, 'external version', 100),
  }
}

export class MySqlProjectionLedgerStore implements ProjectionLedgerStore {
  constructor(private readonly executor: SqlExecutor) {}

  async createOrGetJob(input: NewProjectionJob): Promise<Readonly<{ created: boolean; job: ProjectionJob }>> {
    const job = validateJobInput(input)
    const [, metadata] = await this.executor.query(
      `INSERT IGNORE INTO commerce_projection_jobs
        (id, event_inbox_id, command_id, command_ref, channel, account_id,
         external_order_id, external_version, status, attempts, locked_at, created_at, updated_at)
       VALUES
        (:id, :eventInboxId, :commandId, :commandRef, :channel, :accountId,
         :externalOrderId, :externalVersion, 'processing', 1, NOW(), NOW(), NOW())`,
      {
        replacements: {
          id: job.id,
          eventInboxId: job.eventInboxId,
          commandId: job.commandId,
          commandRef: job.commandRef,
          channel: job.identity.channel,
          accountId: job.identity.accountId,
          externalOrderId: job.identity.externalOrderId,
          externalVersion: job.externalVersion,
        },
      },
    )
    const created = affectedRows(metadata) === 1
    const stored = await this.findJobByEventInboxId(job.eventInboxId)
    if (!stored) invalid('Projection job identity conflicts with an existing record')
    return freezeCopy({ created, job: stored })
  }

  async getAccountMapping(channel: string, rawAccountId: number): Promise<AccountMapping | undefined> {
    const identity = { channel: boundedString(channel, 'channel', 30), accountId: accountId(rawAccountId) }
    const [rows] = await this.executor.query(
      `SELECT channel, account_id, vendure_channel_id
         FROM commerce_account_mappings
        WHERE channel=:channel AND account_id=:accountId AND status='active'
        LIMIT 1`,
      { replacements: identity },
    )
    const row = rows[0]
    if (!row) return undefined
    return freezeCopy({
      channel: boundedString(row.channel, 'channel', 30),
      accountId: accountId(Number(row.account_id)),
      vendureChannelId: boundedString(row.vendure_channel_id, 'Vendure channel id', 64),
    })
  }

  async getSkuMappings(channel: string, rawAccountId: number, rawSkus: readonly string[]): Promise<Readonly<Record<string, SkuMapping>>> {
    const normalizedChannel = boundedString(channel, 'channel', 30)
    const normalizedAccountId = accountId(rawAccountId)
    const skus = [...new Set(rawSkus.map((sku) => boundedString(sku, 'SKU', 191)))]
    if (skus.length === 0) return Object.freeze({})
    if (skus.length > 10_000) invalid('SKU mapping batch is too large')
    const [rows] = await this.executor.query(
      `SELECT channel, account_id, external_sku, vendure_product_variant_id
         FROM commerce_sku_mappings
        WHERE channel=:channel AND account_id=:accountId
          AND external_sku IN (:skus) AND status='active'`,
      { replacements: { channel: normalizedChannel, accountId: normalizedAccountId, skus } },
    )
    const mappings = Object.fromEntries(rows.map((row) => {
      const sku = boundedString(row.external_sku, 'SKU', 191)
      return [sku, {
        channel: boundedString(row.channel, 'channel', 30),
        accountId: accountId(Number(row.account_id)),
        sku,
        vendureProductVariantId: boundedString(row.vendure_product_variant_id, 'Vendure variant id', 64),
      }]
    }))
    return freezeCopy(mappings)
  }

  async claimJob(jobId: string, rawNow = new Date()): Promise<Readonly<{ claimed: boolean; job: ProjectionJob }>> {
    const id = boundedString(jobId, 'job id', 36)
    const now = validDate(rawNow, 'claim timestamp')
    const [, metadata] = await this.executor.query(
      `UPDATE commerce_projection_jobs
          SET status='processing', attempts=attempts+1, locked_at=:now, next_attempt_at=NULL,
              last_error_code=NULL, last_error_message=NULL, updated_at=NOW()
        WHERE id=:id AND status IN ('pending','retryable_failed')
          AND (next_attempt_at IS NULL OR next_attempt_at<=:now)`,
      { replacements: { id, now } },
    )
    const job = await this.requireJob(id)
    return freezeCopy({ claimed: affectedRows(metadata) === 1, job })
  }

  async markFailed(
    jobId: string,
    error: ProjectionFailureDisposition,
  ): Promise<ProjectionJob> {
    const id = boundedString(jobId, 'job id', 36)
    const status = error.retryable ? 'retryable_failed' : 'terminal_failed'
    await this.executor.query(
      `UPDATE commerce_projection_jobs
          SET status=:status, next_attempt_at=:nextAttemptAt, locked_at=NULL,
              last_error_code=:errorCode, last_error_message=:errorMessage, updated_at=NOW()
        WHERE id=:id`,
      {
        replacements: {
          id,
          status,
          retryable: error.retryable ? 1 : 0,
          nextAttemptAt: error.retryable && error.nextAttemptAt
            ? validDate(error.nextAttemptAt, 'next attempt timestamp')
            : null,
          errorCode: error.code,
          errorMessage: String(error.message).slice(0, 500),
        },
      },
    )
    return this.requireJob(id)
  }

  async completeJob(jobId: string, outcome: ProjectionOutcome, link?: OrderLink): Promise<ProjectionJob> {
    const id = boundedString(jobId, 'job id', 36)
    return this.executor.transaction(async (transaction) => {
      if (link) await this.upsertOrderLink(link, transaction)
      await this.executor.query(
        `UPDATE commerce_projection_jobs
            SET status='succeeded', locked_at=NULL, next_attempt_at=NULL,
                last_error_code=NULL, last_error_message=NULL,
                outcome_json=CAST(:outcomeJson AS JSON), updated_at=NOW()
          WHERE id=:id`,
        { replacements: { id, outcomeJson: JSON.stringify(outcome) }, transaction },
      )
      return this.requireJob(id, transaction)
    })
  }

  async getOrderLink(identity: OrderIdentity): Promise<OrderLink | undefined> {
    const normalized = {
      channel: boundedString(identity.channel, 'channel', 30),
      accountId: accountId(identity.accountId),
      externalOrderId: boundedString(identity.externalOrderId, 'external order id', 160),
    }
    const [rows] = await this.executor.query(
      `SELECT channel, account_id, external_order_id, vendure_order_id, order_code,
              external_version, normalized_status, last_event_inbox_id
         FROM commerce_order_links
        WHERE channel=:channel AND account_id=:accountId AND external_order_id=:externalOrderId
        LIMIT 1`,
      { replacements: normalized },
    )
    return rows[0] ? mapOrderLink(rows[0]) : undefined
  }

  async listRunnableJobs(rawNow: Date, rawLimit: number): Promise<readonly ProjectionJob[]> {
    const now = validDate(rawNow, 'list timestamp')
    const limit = batchLimit(rawLimit)
    const [rows] = await this.executor.query(
      `SELECT id, event_inbox_id, command_id, command_ref, channel, account_id,
              external_order_id, external_version, status, attempts, next_attempt_at, locked_at,
              last_error_code, last_error_message, outcome_json
         FROM commerce_projection_jobs
        WHERE status IN ('pending','retryable_failed')
          AND (next_attempt_at IS NULL OR next_attempt_at<=:now)
        ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
        LIMIT :limit`,
      { replacements: { now, limit } },
    )
    return Object.freeze(rows.map((row) => mapJob(row)))
  }

  async recoverStaleJobs(rawStaleBefore: Date, rawRecoveredAt: Date, rawLimit: number): Promise<number> {
    const staleBefore = validDate(rawStaleBefore, 'stale threshold')
    const recoveredAt = validDate(rawRecoveredAt, 'recovery timestamp')
    const limit = batchLimit(rawLimit)
    const [, metadata] = await this.executor.query(
      `UPDATE commerce_projection_jobs
          SET status='retryable_failed', next_attempt_at=:recoveredAt, locked_at=NULL,
              last_error_code='COMMERCE_UNAVAILABLE',
              last_error_message='Commerce dependency is temporarily unavailable', updated_at=NOW()
        WHERE status='processing' AND locked_at<:staleBefore
        ORDER BY locked_at, id
        LIMIT :limit`,
      { replacements: { staleBefore, recoveredAt, limit } },
    )
    return affectedRows(metadata)
  }

  private async upsertOrderLink(link: OrderLink, transaction: unknown): Promise<void> {
    const normalized = mapOrderLink({
      channel: link.identity.channel,
      account_id: link.identity.accountId,
      external_order_id: link.identity.externalOrderId,
      vendure_order_id: link.vendureOrderId,
      order_code: link.orderCode,
      external_version: link.externalVersion,
      normalized_status: link.normalizedStatus,
      last_event_inbox_id: link.lastEventInboxId,
    })
    await this.executor.query(
      `INSERT INTO commerce_order_links
        (channel, account_id, external_order_id, vendure_order_id, order_code,
         external_version, normalized_status, last_event_inbox_id, created_at, updated_at)
       VALUES
        (:channel, :accountId, :externalOrderId, :vendureOrderId, :orderCode,
         :externalVersion, :normalizedStatus, :lastEventInboxId, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         vendure_order_id=VALUES(vendure_order_id), order_code=VALUES(order_code),
         external_version=VALUES(external_version), normalized_status=VALUES(normalized_status),
         last_event_inbox_id=VALUES(last_event_inbox_id), updated_at=NOW()`,
      {
        replacements: {
          channel: normalized.identity.channel,
          accountId: normalized.identity.accountId,
          externalOrderId: normalized.identity.externalOrderId,
          vendureOrderId: normalized.vendureOrderId,
          orderCode: normalized.orderCode,
          externalVersion: normalized.externalVersion,
          normalizedStatus: normalized.normalizedStatus,
          lastEventInboxId: normalized.lastEventInboxId,
        },
        transaction,
      },
    )
  }

  private async findJobByEventInboxId(rawEventInboxId: string, transaction?: unknown): Promise<ProjectionJob | undefined> {
    const [rows] = await this.executor.query(
      `SELECT id, event_inbox_id, command_id, command_ref, channel, account_id,
              external_order_id, external_version, status, attempts,
              next_attempt_at, locked_at, last_error_code, last_error_message, outcome_json
         FROM commerce_projection_jobs
        WHERE event_inbox_id=:eventInboxId
        LIMIT 1`,
      { replacements: { eventInboxId: rawEventInboxId }, transaction },
    )
    return rows[0] ? mapJob(rows[0]) : undefined
  }

  private async requireJob(id: string, transaction?: unknown): Promise<ProjectionJob> {
    const [rows] = await this.executor.query(
      `SELECT id, event_inbox_id, command_id, command_ref, channel, account_id,
              external_order_id, external_version, status, attempts,
              next_attempt_at, locked_at, last_error_code, last_error_message, outcome_json
         FROM commerce_projection_jobs
        WHERE id=:id
        LIMIT 1`,
      { replacements: { id }, transaction },
    )
    if (!rows[0]) invalid('Projection job does not exist')
    return mapJob(rows[0])
  }
}
