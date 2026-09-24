const { ProjectionLedgerError } = require('@rag/commerce-projection-ledger')

function createCommerceProjectionDispatcher({ source, coordinator, batchSize = 25 }) {
  if (!source || typeof source.listPendingRefs !== 'function' || typeof source.load !== 'function') {
    throw new TypeError('Commerce projection dispatcher source is invalid')
  }
  if (!coordinator || typeof coordinator.projectExternalOrder !== 'function') {
    throw new TypeError('Commerce projection dispatcher coordinator is invalid')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new RangeError('Commerce projection dispatcher batch size is invalid')
  }

  return Object.freeze({
    async runOnce() {
      const refs = await source.listPendingRefs(batchSize)
      const results = await Promise.all(refs.map(async ref => {
        try {
          const command = await source.load(ref)
          await coordinator.projectExternalOrder(command)
          return true
        } catch (error) {
          if (error instanceof ProjectionLedgerError) return false
          throw error
        }
      }))
      const succeeded = results.filter(Boolean).length
      return Object.freeze({ listed: refs.length, succeeded, failed: refs.length - succeeded })
    }
  })
}

module.exports = { createCommerceProjectionDispatcher }

