import { createFailureDisposition, validateRetryPolicy } from './retry-policy'
import {
  CommerceUnavailableError,
  ProjectionLedgerError,
  type ProjectionJob,
  type ProjectionLedgerStore,
  type ProjectionRetryPolicy,
} from './types'
import type { ProjectionCoordinator } from './coordinator'

export interface ProjectionCommandSource {
  load(commandRef: string): Promise<unknown>
}

export type ProjectionWorkerSummary = Readonly<{
  recovered: number
  listed: number
  claimed: number
  succeeded: number
  failed: number
  skipped: number
}>

export type ProjectionWorkerOptions = Readonly<{
  store: ProjectionLedgerStore
  coordinator: ProjectionCoordinator
  commandSource: ProjectionCommandSource
  retryPolicy: ProjectionRetryPolicy
  now?: () => Date
  batchSize?: number
  leaseTimeoutMs?: number
}>

type JobRunResult = Readonly<{
  claimed: number
  succeeded: number
  failed: number
  skipped: number
}>

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export class ProjectionWorker {
  private readonly options: ProjectionWorkerOptions
  private readonly now: () => Date
  private readonly batchSize: number
  private readonly leaseTimeoutMs: number
  private readonly retryPolicy: ProjectionRetryPolicy

  constructor(options: ProjectionWorkerOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.batchSize = boundedInteger(options.batchSize ?? 25, 'Projection batchSize', 1, 1_000)
    this.leaseTimeoutMs = boundedInteger(
      options.leaseTimeoutMs ?? 300_000,
      'Projection leaseTimeoutMs',
      1_000,
      86_400_000,
    )
    this.retryPolicy = validateRetryPolicy(options.retryPolicy)
  }

  async runOnce(): Promise<ProjectionWorkerSummary> {
    const now = this.now()
    const staleBefore = new Date(now.getTime() - this.leaseTimeoutMs)
    const recovered = await this.options.store.recoverStaleJobs(staleBefore, now, this.batchSize)
    const jobs = await this.options.store.listRunnableJobs(now, this.batchSize)
    const results = await Promise.all(jobs.map((job) => this.runJob(job, now)))
    return Object.freeze(results.reduce<ProjectionWorkerSummary>((summary, result) => ({
      ...summary,
      claimed: summary.claimed + result.claimed,
      succeeded: summary.succeeded + result.succeeded,
      failed: summary.failed + result.failed,
      skipped: summary.skipped + result.skipped,
    }), {
      recovered,
      listed: jobs.length,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }))
  }

  private async runJob(job: ProjectionJob, now: Date): Promise<JobRunResult> {
    const claim = await this.options.store.claimJob(job.id, now)
    if (!claim.claimed) return Object.freeze({ claimed: 0, succeeded: 0, failed: 0, skipped: 1 })

    let command: unknown
    try {
      command = await this.options.commandSource.load(claim.job.commandRef)
    } catch (sourceError) {
      const error = sourceError instanceof ProjectionLedgerError && !sourceError.retryable
        ? new ProjectionLedgerError(
          sourceError.code,
          sourceError.code === 'INVALID_INPUT'
            ? 'Projection input or dependency response is invalid'
            : 'Projection dependency rejected the command',
        )
        : new CommerceUnavailableError()
      const disposition = createFailureDisposition(claim.job, error, this.retryPolicy, now)
      await this.options.store.markFailed(claim.job.id, disposition)
      return Object.freeze({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 })
    }

    try {
      await this.options.coordinator.projectClaimedExternalOrder(claim.job, command)
      return Object.freeze({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 })
    } catch (error) {
      if (!(error instanceof ProjectionLedgerError)) throw error
      return Object.freeze({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 })
    }
  }
}
