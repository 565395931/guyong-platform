import { randomUUID } from 'node:crypto'
import {
  ProtocolValidationError,
  toScaledInteger,
  validateExternalOrderCommandV2,
  type ExternalOrderProjectionCommandV2,
  type NormalizedOrderStatus,
} from '@rag/commerce-protocol'
import { createFailureDisposition, DEFAULT_PROJECTION_RETRY_POLICY, validateRetryPolicy } from './retry-policy'
import {
  CommerceUnavailableError,
  ProjectionLedgerError,
  type OrderIdentity,
  type OrderLink,
  type ProjectionCoordinatorOptions,
  type ProjectionJob,
  type ProjectionOutcome,
  type ProjectionRetryPolicy,
  type VendureOrderProjectionResult,
} from './types'

const ALLOWED_TRANSITIONS: Readonly<Record<NormalizedOrderStatus, readonly NormalizedOrderStatus[]>> = {
  created: ['created', 'paid', 'ready_to_ship', 'cancelled'],
  paid: ['paid', 'ready_to_ship', 'shipped', 'cancelled', 'after_sales'],
  ready_to_ship: ['ready_to_ship', 'shipped', 'cancelled', 'after_sales'],
  shipped: ['shipped', 'delivered', 'after_sales'],
  delivered: ['delivered', 'after_sales'],
  cancelled: ['cancelled', 'after_sales'],
  after_sales: ['after_sales'],
}

const INITIAL_STATUSES = new Set<NormalizedOrderStatus>(['created', 'paid', 'ready_to_ship', 'cancelled'])

function identityOf(command: ExternalOrderProjectionCommandV2): OrderIdentity {
  return { channel: command.channel, accountId: command.accountId, externalOrderId: command.externalOrderId }
}

function errorFromProtocol(error: ProtocolValidationError): ProjectionLedgerError {
  return new ProjectionLedgerError(error.code, error.message)
}

function ensureTransition(current: NormalizedOrderStatus, incoming: NormalizedOrderStatus): void {
  if (!ALLOWED_TRANSITIONS[current].includes(incoming)) {
    throw new ProjectionLedgerError('STATE_TRANSITION_DENIED', 'Order state transition is not allowed')
  }
}

function safeErrorMessage(code: ProjectionLedgerError['code']): string {
  const messages: Readonly<Record<ProjectionLedgerError['code'], string>> = {
    INVALID_INPUT: 'Projection input or dependency response is invalid',
    TOTAL_MISMATCH: 'Projection totals do not reconcile',
    ACCOUNT_MAPPING_MISSING: 'Account mapping is missing',
    SKU_MAPPING_MISSING: 'SKU mapping is missing',
    STALE_EVENT: 'Projection event is older than the current order version',
    STATE_TRANSITION_DENIED: 'Order state transition is not allowed',
    COMMERCE_UNAVAILABLE: 'Commerce dependency is temporarily unavailable',
  }
  return messages[code]
}

function outcomeFromResult(
  jobId: string,
  kind: ProjectionOutcome['kind'],
  result: VendureOrderProjectionResult,
): ProjectionOutcome {
  return Object.freeze({
    kind,
    jobId,
    vendureOrderId: result.vendureOrderId,
    orderCode: result.orderCode,
    normalizedStatus: result.normalizedStatus,
    externalVersion: result.appliedExternalVersion,
  })
}

function classifyPortError(error: unknown): ProjectionLedgerError {
  if (error instanceof ProjectionLedgerError) {
    return new ProjectionLedgerError(error.code, safeErrorMessage(error.code), error.retryable)
  }
  return new CommerceUnavailableError()
}

export class ProjectionCoordinator {
  private readonly options: ProjectionCoordinatorOptions
  private readonly now: () => Date
  private readonly retryPolicy: ProjectionRetryPolicy

  constructor(options: ProjectionCoordinatorOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.retryPolicy = validateRetryPolicy(options.retryPolicy ?? {
      ...DEFAULT_PROJECTION_RETRY_POLICY,
      baseDelayMs: 0,
    })
  }

  async projectExternalOrder(input: unknown): Promise<ProjectionOutcome> {
    const command = this.validateCommand(input)
    const identity = identityOf(command)
    const createdJob = await this.options.store.createOrGetJob({
      id: this.options.createJobId?.() ?? randomUUID(),
      eventInboxId: String(command.eventInboxId),
      commandId: command.commandId,
      commandRef: command.rawPayloadRef,
      identity,
      externalVersion: command.externalVersion,
    })

    if (!createdJob.created) {
      const existingOutcome = this.handleExistingJob(createdJob.job)
      if (existingOutcome) return existingOutcome
      const claimed = await this.options.store.claimJob(createdJob.job.id, this.now())
      if (!claimed.claimed) {
        return this.handleExistingJob(claimed.job)
          ?? Object.freeze({ kind: 'duplicate' as const, jobId: claimed.job.id })
      }
      return this.projectCommand(claimed.job, command)
    }
    return this.projectCommand(createdJob.job, command)
  }

  async projectClaimedExternalOrder(job: ProjectionJob, input: unknown): Promise<ProjectionOutcome> {
    if (job.status !== 'processing') {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Projection job is not claimed')
    }
    let command: ExternalOrderProjectionCommandV2
    try {
      command = this.validateCommand(input)
      this.assertJobMatchesCommand(job, command)
    } catch (error) {
      const failure = error instanceof ProjectionLedgerError
        ? error
        : new ProjectionLedgerError('INVALID_INPUT', 'External order command is invalid')
      return this.fail(job, failure)
    }
    return this.projectCommand(job, command)
  }

  private validateCommand(input: unknown): ExternalOrderProjectionCommandV2 {
    try {
      return validateExternalOrderCommandV2(input)
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw errorFromProtocol(error)
      throw new ProjectionLedgerError('INVALID_INPUT', 'External order command is invalid')
    }
  }

  private assertJobMatchesCommand(job: ProjectionJob, command: ExternalOrderProjectionCommandV2): void {
    const identity = identityOf(command)
    const matches = job.eventInboxId === String(command.eventInboxId)
      && job.commandId === command.commandId
      && job.commandRef === command.rawPayloadRef
      && job.externalVersion === command.externalVersion
      && job.identity.channel === identity.channel
      && job.identity.accountId === identity.accountId
      && job.identity.externalOrderId === identity.externalOrderId
    if (!matches) throw new ProjectionLedgerError('INVALID_INPUT', 'Resolved command does not match projection job')
  }

  private async projectCommand(
    job: ProjectionJob,
    command: ExternalOrderProjectionCommandV2,
  ): Promise<ProjectionOutcome> {
    const identity = identityOf(command)
    const account = await this.options.store.getAccountMapping(command.channel, command.accountId)
    if (!account) return this.fail(job, new ProjectionLedgerError('ACCOUNT_MAPPING_MISSING', 'Account mapping is missing'))

    const skus = command.lines.map((line) => line.sku)
    const mappings = await this.options.store.getSkuMappings(command.channel, command.accountId, skus)
    if (skus.some((sku) => mappings[sku] === undefined)) {
      return this.fail(job, new ProjectionLedgerError('SKU_MAPPING_MISSING', 'SKU mapping is missing'))
    }

    const link = await this.options.store.getOrderLink(identity)
    if (link) {
      if (this.options.compareExternalVersions(command.externalVersion, link.externalVersion) <= 0) {
        const stale = outcomeFromResult(job.id, 'stale', {
          vendureOrderId: link.vendureOrderId,
          orderCode: link.orderCode,
          normalizedStatus: link.normalizedStatus,
          totalWithTaxMinor: '0',
          appliedExternalVersion: link.externalVersion,
        })
        await this.options.store.completeJob(job.id, stale)
        return stale
      }
      try {
        ensureTransition(link.normalizedStatus, command.normalizedStatus)
      } catch (error) {
        return this.fail(job, error instanceof ProjectionLedgerError
          ? error
          : new ProjectionLedgerError('STATE_TRANSITION_DENIED', 'Order state transition is not allowed'))
      }
    } else if (!INITIAL_STATUSES.has(command.normalizedStatus)) {
      return this.fail(job, new ProjectionLedgerError('STATE_TRANSITION_DENIED', 'New order cannot start in the requested state'))
    }

    const portInput = {
      command,
      vendureChannelId: account.vendureChannelId,
      variantMappings: Object.fromEntries(
        Object.entries(mappings).map(([sku, mapping]) => [sku, mapping.vendureProductVariantId]),
      ),
      ...(link ? { existingVendureOrderId: link.vendureOrderId } : {}),
    }

    let result: VendureOrderProjectionResult
    try {
      result = await this.options.vendure.project(portInput)
    } catch (error) {
      return this.fail(job, classifyPortError(error))
    }

    try {
      this.validatePortResult(command, result)
    } catch (error) {
      return this.fail(job, error instanceof ProjectionLedgerError
        ? error
        : new ProjectionLedgerError('INVALID_INPUT', 'Commerce response is invalid'))
    }

    const outcome = outcomeFromResult(job.id, link ? 'updated' : 'created', result)
    const nextLink: OrderLink = {
      identity,
      vendureOrderId: result.vendureOrderId,
      orderCode: result.orderCode,
      externalVersion: result.appliedExternalVersion,
      normalizedStatus: result.normalizedStatus,
      lastEventInboxId: String(command.eventInboxId),
    }
    await this.options.store.completeJob(job.id, outcome, nextLink)
    return outcome
  }

  private handleExistingJob(job: ProjectionJob): ProjectionOutcome | undefined {
    if (job.status === 'succeeded' && job.outcome) {
      return Object.freeze({ ...job.outcome, kind: 'duplicate' as const, jobId: job.id })
    }
    if (job.status === 'processing') return Object.freeze({ kind: 'duplicate' as const, jobId: job.id })
    if (job.status === 'terminal_failed') {
      throw new ProjectionLedgerError(job.lastErrorCode ?? 'INVALID_INPUT', job.lastErrorMessage ?? 'Projection permanently failed')
    }
    return undefined
  }

  private async fail(job: ProjectionJob, error: ProjectionLedgerError): Promise<never> {
    const safeError = new ProjectionLedgerError(error.code, safeErrorMessage(error.code), error.retryable)
    const disposition = createFailureDisposition(job, safeError, this.retryPolicy, this.now())
    await this.options.store.markFailed(job.id, disposition)
    throw safeError
  }

  private validatePortResult(command: ExternalOrderProjectionCommandV2, result: VendureOrderProjectionResult): void {
    if (result.vendureOrderId.trim() === '' || result.vendureOrderId.length > 512) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce order identifier is invalid')
    }
    if (result.orderCode.trim() === '' || result.orderCode.length > 512) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce order code is invalid')
    }
    const expectedMinor = toScaledInteger(command.amounts.total, command.currency.exponent).toString()
    if (result.totalWithTaxMinor !== expectedMinor) {
      throw new ProjectionLedgerError('TOTAL_MISMATCH', 'Commerce total does not match the external order total')
    }
    if (result.appliedExternalVersion !== command.externalVersion || result.normalizedStatus !== command.normalizedStatus) {
      throw new ProjectionLedgerError('INVALID_INPUT', 'Commerce response does not match the requested projection')
    }
  }
}
