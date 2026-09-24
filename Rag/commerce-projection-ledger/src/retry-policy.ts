import {
  ProjectionLedgerError,
  type ProjectionFailureDisposition,
  type ProjectionRetryPolicy,
} from './types'

export const DEFAULT_PROJECTION_RETRY_POLICY: ProjectionRetryPolicy = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
})

export function validateRetryPolicy(policy: ProjectionRetryPolicy): ProjectionRetryPolicy {
  const values = [policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs]
  if (!values.every(Number.isSafeInteger)) {
    throw new TypeError('Projection retry policy values must be safe integers')
  }
  if (policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new RangeError('Projection maxAttempts must be between 1 and 100')
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < policy.baseDelayMs || policy.maxDelayMs > 86_400_000) {
    throw new RangeError('Projection retry delay is outside the allowed range')
  }
  return Object.freeze({ ...policy })
}

export function createFailureDisposition(
  job: Readonly<{ attempts: number }>,
  error: ProjectionLedgerError,
  rawPolicy: ProjectionRetryPolicy,
  now: Date,
): ProjectionFailureDisposition {
  const policy = validateRetryPolicy(rawPolicy)
  const canRetry = error.retryable && job.attempts < policy.maxAttempts
  if (!canRetry) {
    return Object.freeze({ code: error.code, message: error.message, retryable: false })
  }
  const exponent = Math.max(0, job.attempts - 1)
  const delayMs = Math.min(policy.baseDelayMs * (2 ** exponent), policy.maxDelayMs)
  return Object.freeze({
    code: error.code,
    message: error.message,
    retryable: true,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  })
}
