import {
  ProjectionLedgerError,
  type AccountMapping,
  type NewProjectionJob,
  type OrderIdentity,
  type OrderLink,
  type ProjectionJob,
  type ProjectionLedgerStore,
  type ProjectionOutcome,
  type ProjectionErrorCode,
  type SkuMapping,
} from './types'

type StoreSeed = Readonly<{
  accounts?: readonly AccountMapping[]
  skus?: readonly SkuMapping[]
  links?: readonly OrderLink[]
}>

type StoreOptions = Readonly<{
  now?: () => Date
}>

type StoreState = Readonly<{
  jobs: ReadonlyMap<string, ProjectionJob>
  eventJobs: ReadonlyMap<string, string>
  accounts: ReadonlyMap<string, AccountMapping>
  skus: ReadonlyMap<string, SkuMapping>
  links: ReadonlyMap<string, OrderLink>
}>

function identityKey(identity: OrderIdentity): string {
  return JSON.stringify([identity.channel, identity.accountId, identity.externalOrderId])
}

function accountKey(channel: string, accountId: number): string {
  return `${channel}:${accountId}`
}

function skuKey(channel: string, accountId: number, sku: string): string {
  return `${channel}:${accountId}:${sku}`
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value)
  return deepFreeze(copy)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((nested) => deepFreeze(nested))
    Object.freeze(value)
  }
  return value
}

function replace<K, V>(source: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(source)
  next.set(key, value)
  return next
}

export class InMemoryProjectionLedgerStore implements ProjectionLedgerStore {
  private state: StoreState
  private readonly now: () => Date

  constructor(seed: StoreSeed = {}, options: StoreOptions = {}) {
    const accounts = new Map<string, AccountMapping>()
    const skus = new Map<string, SkuMapping>()
    const links = new Map<string, OrderLink>()
    for (const account of seed.accounts ?? []) accounts.set(accountKey(account.channel, account.accountId), freezeCopy(account))
    for (const sku of seed.skus ?? []) skus.set(skuKey(sku.channel, sku.accountId, sku.sku), freezeCopy(sku))
    for (const link of seed.links ?? []) links.set(identityKey(link.identity), freezeCopy(link))
    this.state = { jobs: new Map(), eventJobs: new Map(), accounts, skus, links }
    this.now = options.now ?? (() => new Date())
  }

  async createOrGetJob(input: NewProjectionJob): Promise<{ created: boolean; job: ProjectionJob }> {
    const existingJobId = this.state.eventJobs.get(input.eventInboxId)
    const existing = existingJobId ? this.state.jobs.get(existingJobId) : undefined
    if (existing) return { created: false, job: freezeCopy(existing) }
    if (this.state.jobs.has(input.id)) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Projection job identifier already exists')
    }

    const job = freezeCopy({
      ...input,
      status: 'processing' as const,
      attempts: 1,
      lockedAt: this.now().toISOString(),
    })
    this.state = {
      ...this.state,
      jobs: replace(this.state.jobs, input.id, job),
      eventJobs: replace(this.state.eventJobs, input.eventInboxId, input.id),
    }
    return { created: true, job: freezeCopy(job) }
  }

  async getAccountMapping(channel: string, accountId: number): Promise<AccountMapping | undefined> {
    const account = this.state.accounts.get(accountKey(channel, accountId))
    return account ? freezeCopy(account) : undefined
  }

  async getSkuMappings(channel: string, accountId: number, skus: readonly string[]): Promise<Record<string, SkuMapping>> {
    const result: Record<string, SkuMapping> = {}
    for (const sku of skus) {
      const mapping = this.state.skus.get(skuKey(channel, accountId, sku))
      if (mapping) result[sku] = freezeCopy(mapping)
    }
    return freezeCopy(result)
  }

  async claimJob(jobId: string, now = this.now()): Promise<{ claimed: boolean; job: ProjectionJob }> {
    const job = this.requireJob(jobId)
    if (!['pending', 'retryable_failed'].includes(job.status)) {
      return { claimed: false, job: freezeCopy(job) }
    }
    if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() > now.getTime()) {
      return { claimed: false, job: freezeCopy(job) }
    }
    const next = freezeCopy({
      ...job,
      status: 'processing' as const,
      attempts: job.attempts + 1,
      nextAttemptAt: undefined,
      lockedAt: now.toISOString(),
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    })
    this.state = { ...this.state, jobs: replace(this.state.jobs, jobId, next) }
    return { claimed: true, job: freezeCopy(next) }
  }

  async markFailed(
    jobId: string,
    error: Readonly<{
      code: ProjectionErrorCode
      message: string
      retryable: boolean
      nextAttemptAt?: Date
    }>,
  ): Promise<ProjectionJob> {
    const job = this.requireJob(jobId)
    const next = freezeCopy({
      ...job,
      status: error.retryable ? ('retryable_failed' as const) : ('terminal_failed' as const),
      nextAttemptAt: error.retryable ? error.nextAttemptAt?.toISOString() : undefined,
      lockedAt: undefined,
      lastErrorCode: error.code,
      lastErrorMessage: error.message.slice(0, 500),
    })
    this.state = { ...this.state, jobs: replace(this.state.jobs, jobId, next) }
    return freezeCopy(next)
  }

  async completeJob(jobId: string, outcome: ProjectionOutcome, link?: OrderLink): Promise<ProjectionJob> {
    const job = this.requireJob(jobId)
    const next = freezeCopy({
      ...job,
      status: 'succeeded' as const,
      nextAttemptAt: undefined,
      lockedAt: undefined,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      outcome,
    })
    this.state = {
      ...this.state,
      jobs: replace(this.state.jobs, jobId, next),
      links: link ? replace(this.state.links, identityKey(link.identity), freezeCopy(link)) : this.state.links,
    }
    return freezeCopy(next)
  }

  async getOrderLink(identity: OrderIdentity): Promise<OrderLink | undefined> {
    const link = this.state.links.get(identityKey(identity))
    return link ? freezeCopy(link) : undefined
  }

  async listRunnableJobs(now: Date, limit: number): Promise<readonly ProjectionJob[]> {
    validateBatchLimit(limit)
    return Object.freeze([...this.state.jobs.values()]
      .filter((job) => ['pending', 'retryable_failed'].includes(job.status))
      .filter((job) => !job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() <= now.getTime())
      .slice(0, limit)
      .map((job) => freezeCopy(job)))
  }

  async recoverStaleJobs(staleBefore: Date, recoveredAt: Date, limit: number): Promise<number> {
    validateBatchLimit(limit)
    const recoverable = [...this.state.jobs.values()]
      .filter((job) => job.status === 'processing' && Boolean(job.lockedAt))
      .filter((job) => new Date(job.lockedAt as string).getTime() < staleBefore.getTime())
      .slice(0, limit)
    let jobs = this.state.jobs
    for (const job of recoverable) {
      const recovered = freezeCopy({
        ...job,
        status: 'retryable_failed' as const,
        nextAttemptAt: recoveredAt.toISOString(),
        lockedAt: undefined,
        lastErrorCode: 'COMMERCE_UNAVAILABLE' as const,
        lastErrorMessage: 'Commerce dependency is temporarily unavailable',
      })
      jobs = replace(jobs, job.id, recovered)
    }
    this.state = { ...this.state, jobs }
    return recoverable.length
  }

  async getJobByEventInboxId(eventInboxId: string): Promise<ProjectionJob | undefined> {
    const jobId = this.state.eventJobs.get(eventInboxId)
    const job = jobId ? this.state.jobs.get(jobId) : undefined
    return job ? freezeCopy(job) : undefined
  }

  private requireJob(jobId: string): ProjectionJob {
    const job = this.state.jobs.get(jobId)
    if (!job) throw new ProjectionLedgerError('INVALID_INPUT', 'Projection job does not exist')
    return job
  }
}

function validateBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Projection batch limit must be between 1 and 1000')
  }
}

export { identityKey as createOrderIdentityKey }
