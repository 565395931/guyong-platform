const test = require('node:test')
const assert = require('node:assert/strict')

const { createPendingReviewGuard } = require('./aiReplyReviewGuard')

test('skips AI generation when the queued message has an open review', async () => {
  const calls = []
  const guard = createPendingReviewGuard({
    reviewService: {
      hasOpenReviewForMessage: async (messageId) => {
        calls.push(messageId)
        return true
      }
    },
    logger: { info: (...args) => calls.push(args) }
  })

  assert.deepEqual(await guard({ id: 'm1' }, 'c1'), {
    skipped: true,
    reason: 'message_review_pending'
  })
  assert.equal(calls[0], 'm1')
})

test('allows jobs without a pending review', async () => {
  const guard = createPendingReviewGuard({
    reviewService: { hasOpenReviewForMessage: async () => false },
    logger: { info() {} }
  })
  assert.equal(await guard({ id: 'm1' }, 'c1'), null)
})

test('fails closed when review state cannot be checked', async () => {
  const guard = createPendingReviewGuard({
    reviewService: { hasOpenReviewForMessage: async () => { throw new Error('database down') } },
    logger: { error() {} }
  })
  assert.deepEqual(await guard({ id: 'm1' }, 'c1'), {
    skipped: true,
    reason: 'message_review_check_failed'
  })
})
