import type { ExternalOrderProjectionCommandV2, NormalizedOrderStatus } from '@rag/commerce-protocol'

export type ProjectionErrorCode =
  | 'INVALID_INPUT'
  | 'TOTAL_MISMATCH'
  | 'ACCOUNT_MAPPING_MISSING'
  | 'SKU_MAPPING_MISSING'
  | 'STALE_EVENT'
  | 'STATE_TRANSITION_DENIED'
  | 'COMMERCE_UNAVAILABLE'

export class ProjectionLedgerError extends Error {
  constructor(
    readonly code: ProjectionErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ProjectionLedgerError'
  }
}

export class CommerceUnavailableError extends ProjectionLedgerError {
  constructor(message = 'Commerce dependency is temporarily unavailable') {
    super('COMMERCE_UNAVAILABLE', message, true)
    this.name = 'CommerceUnavailableError'
  }
}

export type OrderIdentity = Readonly<{
  channel: string
  accountId: number
  externalOrderId: string
}>

export type AccountMapping = Readonly<{
  channel: string
  accountId: number
  vendureChannelId: string
}>

export type SkuMapping = Readonly<{
  channel: string
  accountId: number
  sku: string
  vendureProductVariantId: string
}>

export type ProjectionJobStatus =
  | 'pending'
  | 'processing'
  | 'retryable_failed'
  | 'terminal_failed'
  | 'succeeded'

export type ProjectionOutcome = Readonly<{
  kind: 'created' | 'updated' | 'duplicate' | 'stale'
  jobId: string
  vendureOrderId?: string
  orderCode?: string
  normalizedStatus?: NormalizedOrderStatus
  externalVersion?: string
}>

export type ProjectionJob = Readonly<{
  id: string
  eventInboxId: string
  commandId: string
  commandRef: string
  identity: OrderIdentity
  externalVersion: string
  status: ProjectionJobStatus
  attempts: number
  nextAttemptAt?: string
  lockedAt?: string
  lastErrorCode?: ProjectionErrorCode
  lastErrorMessage?: string
  outcome?: ProjectionOutcome
}>

export type OrderLink = Readonly<{
  identity: OrderIdentity
  vendureOrderId: string
  orderCode: string
  externalVersion: string
  normalizedStatus: NormalizedOrderStatus
  lastEventInboxId: string
}>

export type NewProjectionJob = Readonly<{
  id: string
  eventInboxId: string
  commandId: string
  commandRef: string
  identity: OrderIdentity
  externalVersion: string
}>

export type VendureOrderProjectionInput = Readonly<{
  command: ExternalOrderProjectionCommandV2
  vendureChannelId: string
  variantMappings: Readonly<Record<string, string>>
  existingVendureOrderId?: string
}>

export type VendureOrderProjectionResult = Readonly<{
  vendureOrderId: string
  orderCode: string
  normalizedStatus: NormalizedOrderStatus
  totalWithTaxMinor: string
  appliedExternalVersion: string
}>

export interface VendureOrderPort {
  project(input: VendureOrderProjectionInput): Promise<VendureOrderProjectionResult>
}

export interface ProjectionLedgerStore {
  createOrGetJob(input: NewProjectionJob): Promise<Readonly<{ created: boolean; job: ProjectionJob }>>
  getAccountMapping(channel: string, accountId: number): Promise<AccountMapping | undefined>
  getSkuMappings(channel: string, accountId: number, skus: readonly string[]): Promise<Readonly<Record<string, SkuMapping>>>
  claimJob(jobId: string, now?: Date): Promise<Readonly<{ claimed: boolean; job: ProjectionJob }>>
  markFailed(jobId: string, error: ProjectionFailureDisposition): Promise<ProjectionJob>
  completeJob(jobId: string, outcome: ProjectionOutcome, link?: OrderLink): Promise<ProjectionJob>
  getOrderLink(identity: OrderIdentity): Promise<OrderLink | undefined>
  listRunnableJobs(now: Date, limit: number): Promise<readonly ProjectionJob[]>
  recoverStaleJobs(staleBefore: Date, recoveredAt: Date, limit: number): Promise<number>
}

export type ProjectionRetryPolicy = Readonly<{
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}>

export type ProjectionFailureDisposition = Readonly<{
  code: ProjectionErrorCode
  message: string
  retryable: boolean
  nextAttemptAt?: Date
}>

export type ProjectionCoordinatorOptions = Readonly<{
  store: ProjectionLedgerStore
  vendure: VendureOrderPort
  compareExternalVersions: (incoming: string, current: string) => number
  createJobId?: () => string
  now?: () => Date
  retryPolicy?: ProjectionRetryPolicy
}>
