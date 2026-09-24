function createPendingReviewGuard({ reviewService, logger = console }) {
  if (!reviewService || typeof reviewService.hasOpenReviewForMessage !== 'function') {
    throw new TypeError('reviewService.hasOpenReviewForMessage is required')
  }

  return async function checkPendingReview(message, conversationId) {
    const messageId = message?.id || message?.messageId
    if (!messageId) return null

    try {
      if (!await reviewService.hasOpenReviewForMessage(messageId)) return null

      logger.info?.('message.ai_reply_skipped', {
        conversationId,
        messageId,
        reason: 'message_review_pending'
      })
      return { skipped: true, reason: 'message_review_pending' }
    } catch (error) {
      logger.error?.('message.review_state_check_failed', {
        conversationId,
        messageId,
        error: error.message
      })
      return { skipped: true, reason: 'message_review_check_failed' }
    }
  }
}

module.exports = { createPendingReviewGuard }
