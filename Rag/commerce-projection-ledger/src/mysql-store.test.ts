import { describe, expect, it } from 'vitest'
import { MySqlProjectionLedgerStore, type SqlExecutor, type SqlQueryOptions } from './mysql-store'
import type { NewProjectionJob, OrderLink, ProjectionOutcome } from './types'

const jobRow = {
  id: 'job-1',
  event_inbox_id: '42',
  command_id: 'command-2',
  command_ref: 'channel_event_inbox:42',
  channel: 'taobao',
  account_id: 7,
  external_order_id: 'order-1',
  external_version: '2026-08-11T01:00:00.000Z',
  status: 'processing',
  attempts: 1,
  next_attempt_at: null,
  locked_at: new Date('2026-08-11T01:00:00.000Z'),
  last_error_code: null,
  last_error_message: null,
  outcome_json: null,
}

class FakeSqlExecutor implements SqlExecutor {
  readonly calls: Array<{ sql: string; options: SqlQueryOptions }> = []
  insertMetadata: unknown = { affectedRows: 1 }
  claimMetadata: unknown = { affectedRows: 1 }
  selectedJob: Record<string, unknown> | undefined = jobRow
  accountRows: Record<string, unknown>[] = [{ channel: 'taobao', account_id: 7, vendure_channel_id: 'channel-7' }]
  skuRows: Record<string, unknown>[] = [{ channel: 'taobao', account_id: 7, external_sku: 'SKU-001', vendure_product_variant_id: 'variant-1' }]
  linkRows: Record<string, unknown>[] = [{
    channel: 'taobao',
    account_id: 7,
    external_order_id: 'order-1',
    vendure_order_id: 'vendure-order-1',
    order_code: 'A0001',
    external_version: '2026-08-11T01:00:00.000Z',
    normalized_status: 'paid',
    last_event_inbox_id: '42',
  }]

  async query(sql: string, options: SqlQueryOptions = {}): Promise<readonly [readonly Record<string, unknown>[], unknown]> {
    this.calls.push({ sql, options })
    if (/INSERT IGNORE INTO commerce_projection_jobs/i.test(sql)) return [[], this.insertMetadata]
    if (/UPDATE commerce_projection_jobs\s+SET status='processing'/i.test(sql)) return [[], this.claimMetadata]
    if (/FROM commerce_projection_jobs/i.test(sql)) return [this.selectedJob ? [this.selectedJob] : [], {}]
    if (/FROM commerce_account_mappings/i.test(sql)) return [this.accountRows, {}]
    if (/FROM commerce_sku_mappings/i.test(sql)) return [this.skuRows, {}]
    if (/FROM commerce_order_links/i.test(sql)) return [this.linkRows, {}]
    return [[], { affectedRows: 1 }]
  }

  async transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> {
    return operation('transaction-1')
  }
}

function newJob(): NewProjectionJob {
  return {
    id: 'job-1',
    eventInboxId: '42',
    commandId: 'command-2',
    commandRef: 'channel_event_inbox:42',
    identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
    externalVersion: '2026-08-11T01:00:00.000Z',
  }
}

describe('MySqlProjectionLedgerStore', () => {
  it('creates and atomically claims a new event using replacements', async () => {
    const db = new FakeSqlExecutor()
    const store = new MySqlProjectionLedgerStore(db)

    const result = await store.createOrGetJob(newJob())

    expect(result).toMatchObject({ created: true, job: { id: 'job-1', status: 'processing', attempts: 1 } })
    expect(Object.isFrozen(result.job)).toBe(true)
    expect(db.calls[0].sql).toMatch(/INSERT IGNORE INTO commerce_projection_jobs/)
    expect(db.calls[0].sql).not.toContain('order-1')
    expect(db.calls[0].options.replacements).toMatchObject({ externalOrderId: 'order-1', eventInboxId: '42' })
  })

  it('returns the existing job for a duplicate event', async () => {
    const db = new FakeSqlExecutor()
    db.insertMetadata = { affectedRows: 0 }
    const store = new MySqlProjectionLedgerStore(db)

    await expect(store.createOrGetJob(newJob())).resolves.toMatchObject({ created: false, job: { id: 'job-1' } })
  })

  it('rejects an insert ignored because of a conflicting job ID', async () => {
    const db = new FakeSqlExecutor()
    db.insertMetadata = { affectedRows: 0 }
    db.selectedJob = undefined
    const store = new MySqlProjectionLedgerStore(db)

    await expect(store.createOrGetJob(newJob())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('loads account and SKU mappings without interpolating values', async () => {
    const db = new FakeSqlExecutor()
    const store = new MySqlProjectionLedgerStore(db)

    const account = await store.getAccountMapping('taobao', 7)
    const skus = await store.getSkuMappings('taobao', 7, ['SKU-001'])

    expect(account).toEqual({ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' })
    expect(skus).toEqual({
      'SKU-001': { channel: 'taobao', accountId: 7, sku: 'SKU-001', vendureProductVariantId: 'variant-1' },
    })
    const mappingCalls = db.calls.filter((call) => /commerce_(account|sku)_mappings/.test(call.sql))
    expect(mappingCalls.every((call) => !call.sql.includes('SKU-001'))).toBe(true)
  })

  it('claims a retryable job only when the conditional update wins', async () => {
    const db = new FakeSqlExecutor()
    db.selectedJob = { ...jobRow, attempts: 2 }
    const store = new MySqlProjectionLedgerStore(db)

    await expect(store.claimJob('job-1')).resolves.toMatchObject({ claimed: true, job: { attempts: 2 } })

    db.claimMetadata = { affectedRows: 0 }
    await expect(store.claimJob('job-1')).resolves.toMatchObject({ claimed: false })
  })

  it('records a bounded safe failure through replacements', async () => {
    const db = new FakeSqlExecutor()
    db.selectedJob = { ...jobRow, status: 'terminal_failed', last_error_code: 'INVALID_INPUT' }
    const store = new MySqlProjectionLedgerStore(db)

    await store.markFailed('job-1', { code: 'INVALID_INPUT', message: 'x'.repeat(600), retryable: false })

    const update = db.calls.find((call) => /last_error_code/.test(call.sql) && /UPDATE commerce_projection_jobs/.test(call.sql))
    expect(update?.options.replacements).toMatchObject({ errorCode: 'INVALID_INPUT', status: 'terminal_failed' })
    expect(String(update?.options.replacements?.errorMessage)).toHaveLength(500)
  })

  it('completes a job and upserts its order link in one transaction', async () => {
    const db = new FakeSqlExecutor()
    db.selectedJob = { ...jobRow, status: 'succeeded', outcome_json: JSON.stringify({ kind: 'created', jobId: 'job-1' }) }
    const store = new MySqlProjectionLedgerStore(db)
    const outcome: ProjectionOutcome = { kind: 'created', jobId: 'job-1', vendureOrderId: 'vendure-order-1' }
    const link: OrderLink = {
      identity: { channel: 'taobao', accountId: 7, externalOrderId: 'order-1' },
      vendureOrderId: 'vendure-order-1',
      orderCode: 'A0001',
      externalVersion: '2026-08-11T01:00:00.000Z',
      normalizedStatus: 'paid',
      lastEventInboxId: '42',
    }

    await expect(store.completeJob('job-1', outcome, link)).resolves.toMatchObject({ status: 'succeeded' })

    const upsert = db.calls.find((call) => /INSERT INTO commerce_order_links/.test(call.sql))
    const completed = db.calls.find((call) => /outcome_json/.test(call.sql) && /UPDATE commerce_projection_jobs/.test(call.sql))
    expect(upsert?.sql).toMatch(/ON DUPLICATE KEY UPDATE/)
    expect(upsert?.options.transaction).toBe('transaction-1')
    expect(completed?.options.replacements?.outcomeJson).toBe(JSON.stringify(outcome))
  })

  it('maps an order link row to an immutable domain object', async () => {
    const db = new FakeSqlExecutor()
    const store = new MySqlProjectionLedgerStore(db)

    const link = await store.getOrderLink({ channel: 'taobao', accountId: 7, externalOrderId: 'order-1' })

    expect(link).toMatchObject({ vendureOrderId: 'vendure-order-1', normalizedStatus: 'paid' })
    expect(Object.isFrozen(link)).toBe(true)
    expect(Object.isFrozen(link?.identity)).toBe(true)
  })

  it('supports numeric affected-row metadata returned by Sequelize dialects', async () => {
    const db = new FakeSqlExecutor()
    db.insertMetadata = 1

    await expect(new MySqlProjectionLedgerStore(db).createOrGetJob(newJob())).resolves.toMatchObject({ created: true })
  })

  it.each([
    ['empty job ID', (job: NewProjectionJob) => ({ ...job, id: '' })],
    ['invalid event inbox ID', (job: NewProjectionJob) => ({ ...job, eventInboxId: '-1' })],
    ['negative account ID', (job: NewProjectionJob) => ({ ...job, identity: { ...job.identity, accountId: -1 } })],
    ['oversized order ID', (job: NewProjectionJob) => ({ ...job, identity: { ...job.identity, externalOrderId: 'x'.repeat(161) } })],
  ])('rejects %s before issuing SQL', async (_label, mutate) => {
    const db = new FakeSqlExecutor()

    await expect(new MySqlProjectionLedgerStore(db).createOrGetJob(mutate(newJob()))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(db.calls).toHaveLength(0)
  })

  it.each([
    ['unknown status', { status: 'unknown' }],
    ['negative attempts', { attempts: -1 }],
    ['malformed outcome JSON', { outcome_json: '{' }],
    ['unknown error code', { last_error_code: 'UNKNOWN_FAILURE' }],
  ])('rejects a stored job with %s', async (_label, override) => {
    const db = new FakeSqlExecutor()
    db.selectedJob = { ...jobRow, ...override }

    await expect(new MySqlProjectionLedgerStore(db).createOrGetJob(newJob())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('returns empty mapping results without fabricating records', async () => {
    const db = new FakeSqlExecutor()
    db.accountRows = []
    db.skuRows = []
    db.linkRows = []
    const store = new MySqlProjectionLedgerStore(db)

    await expect(store.getAccountMapping('taobao', 7)).resolves.toBeUndefined()
    await expect(store.getSkuMappings('taobao', 7, [])).resolves.toEqual({})
    await expect(store.getOrderLink({ channel: 'taobao', accountId: 7, externalOrderId: 'order-1' })).resolves.toBeUndefined()
  })

  it('records retryable failure state and completes without an order-link upsert', async () => {
    const db = new FakeSqlExecutor()
    const store = new MySqlProjectionLedgerStore(db)

    db.selectedJob = { ...jobRow, status: 'retryable_failed' }
    await store.markFailed('job-1', { code: 'COMMERCE_UNAVAILABLE', message: 'safe', retryable: true })
    const failure = db.calls.find((call) => /last_error_code/.test(call.sql) && /UPDATE commerce_projection_jobs/.test(call.sql))
    expect(failure?.options.replacements).toMatchObject({ status: 'retryable_failed', retryable: 1 })

    db.selectedJob = { ...jobRow, status: 'succeeded', outcome_json: { kind: 'stale', jobId: 'job-1' } }
    await store.completeJob('job-1', { kind: 'stale', jobId: 'job-1' })
    expect(db.calls.filter((call) => /INSERT INTO commerce_order_links/.test(call.sql))).toHaveLength(0)
  })

  it('lists only due jobs using bounded parameterized inputs', async () => {
    const db = new FakeSqlExecutor()
    db.selectedJob = {
      ...jobRow,
      status: 'retryable_failed',
      next_attempt_at: new Date('2026-08-11T01:00:01.000Z'),
      locked_at: null,
    }
    const store = new MySqlProjectionLedgerStore(db)
    const now = new Date('2026-08-11T01:00:02.000Z')

    const jobs = await store.listRunnableJobs(now, 25)

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ nextAttemptAt: '2026-08-11T01:00:01.000Z' })
    const query = db.calls.find((call) => /ORDER BY COALESCE\(next_attempt_at/.test(call.sql))
    expect(query?.options.replacements).toEqual({ now, limit: 25 })
    expect(query?.sql).toContain('LIMIT :limit')
  })

  it('recovers expired leases with a bounded conditional update', async () => {
    const db = new FakeSqlExecutor()
    const store = new MySqlProjectionLedgerStore(db)
    const staleBefore = new Date('2026-08-11T01:00:00.000Z')
    const recoveredAt = new Date('2026-08-11T01:01:00.000Z')

    await expect(store.recoverStaleJobs(staleBefore, recoveredAt, 10)).resolves.toBe(1)

    const update = db.calls.find((call) => /locked_at<:staleBefore/.test(call.sql))
    expect(update?.options.replacements).toEqual({ staleBefore, recoveredAt, limit: 10 })
    expect(update?.sql).toContain("status='processing'")
  })
})
