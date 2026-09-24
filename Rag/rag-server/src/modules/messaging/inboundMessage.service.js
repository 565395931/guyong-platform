const { POOL_TYPE } = require('../conversation-pool/constants')
const { INTERNAL_EVENTS } = require('../websocket/events')

function resolveDependencies(overrides) {
  const queueModule = overrides.queueModule || require('../../queues')
  return {
    reviewService: overrides.reviewService || require('../message-review').reviewService,
    poolService: overrides.poolService || require('../conversation-pool/pool.service'),
    configService: overrides.configService || require('../../services/configService'),
    systemLogger: overrides.systemLogger || require('../../utils/systemLogger'),
    queueModule,
    now: overrides.now || Date.now,
    random: overrides.random || Math.random
  }
}

function createInboundMessagePostProcessor(overrides = {}) {
  let dependencies = null

  return async function processInboundMessageAfterStore(message, eventEmitter, context = {}) {
    dependencies ||= resolveDependencies(overrides)
    const { reviewService, poolService, configService, systemLogger, queueModule, now, random } = dependencies
    const conversationId = message?.conversationId
    if (!conversationId) throw new Error('Inbound message is missing conversationId after persistence')

    const review = await reviewService.reviewInbound(message, context)
    if (review.action === 'review') {
      try {
        await queueModule.removePendingAiReplyJobs(conversationId, 'message awaiting human review')
      } catch (error) {
        systemLogger.error?.('message.review_ai_job_cleanup_failed', {
          conversationId,
          reviewId: review.item.id,
          error: error.message
        })
      }
      return {
        reviewQueued: true,
        reviewId: review.item.id,
        aiReplyQueued: false,
        jobMarker: null
      }
    }

    const routeInfo = await poolService.routeIncomingMessage(conversationId, message, eventEmitter)
    if (routeInfo.poolType !== POOL_TYPE.AI_SELF) {
      return { routeInfo, aiReplyQueued: false, jobMarker: null }
    }

    await queueModule.removePendingAiReplyJobs(conversationId, '新客户消息到达，保留最新AI回复任务')

    const enqueuedAt = now()
    const jobMarker = `${enqueuedAt}-${random().toString(36).slice(2, 8)}`
    const debounceMs = await configService.getConfig('ai_reply_debounce_ms')
    await queueModule.markLatestAiReplyJob(conversationId, jobMarker)
    const job = await queueModule.aiReplyQueue.add('ai-reply', {
      conversationId,
      message,
      enqueuedAt,
      jobMarker,
      eventId: context.eventId || null,
      source: context.source || 'unknown'
    }, {
      jobId: `ai-${conversationId}-${jobMarker}`,
      delay: debounceMs
    })

    eventEmitter?.emit(INTERNAL_EVENTS.AI_REPLY_STATUS, {
      conversationId,
      status: 'queued',
      jobId: job?.id || null,
      jobMarker
    })
    systemLogger.info('message.ai_reply_queued', {
      conversationId,
      channel: message.channel || null,
      accountId: message.accountId || null,
      channelMessageId: message.channelMessageId || null,
      eventId: context.eventId || null,
      source: context.source || 'unknown',
      jobId: job?.id || null,
      jobMarker
    })

    return { routeInfo, aiReplyQueued: true, jobId: job?.id || null, jobMarker }
  }
}

const processInboundMessageAfterStore = createInboundMessagePostProcessor()

module.exports = {
  createInboundMessagePostProcessor,
  processInboundMessageAfterStore
}
