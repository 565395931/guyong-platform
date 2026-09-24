const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/

export class DecimalValidationError extends Error {
  readonly code = 'INVALID_INPUT'

  constructor(message: string) {
    super(message)
    this.name = 'DecimalValidationError'
  }
}

export function toScaledInteger(value: string, exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new DecimalValidationError('Currency exponent must be an integer from 0 through 6')
  }

  if (value.length > 64) {
    throw new DecimalValidationError('Amount exceeds the maximum supported length')
  }

  if (!DECIMAL_PATTERN.test(value)) {
    throw new DecimalValidationError('Amount must be a non-negative decimal string')
  }

  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > exponent) {
    throw new DecimalValidationError('Amount precision exceeds the currency exponent')
  }

  return BigInt(`${whole}${fraction.padEnd(exponent, '0')}`)
}
