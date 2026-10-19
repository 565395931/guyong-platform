const { isAiReplyEligible } = require('../conversation-pool/aiReplyPolicy')
const { INTERNAL_EVENTS } = require('../websocket/events')

function resolveDependencies(overrides) {
  const queueModule = overrides.queueModule || require('../../queues')
  return {
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
    const { poolService, configService, systemLogger, queueModule, now, random } = dependencies
    const conversationId = message?.conversationId
    if (!conversationId) throw new Error('Inbound message is missing conversationId after persistence')

    const routeInfo = await poolService.routeIncomingMessage(conversationId, message, eventEmitter)
    if (context.allowAutoReply === false) {
      await queueModule.removePendingAiReplyJobs(conversationId, 'cloud shop manual-only connection')
      return { routeInfo, aiReplyQueued: false, jobMarker: null, manualOnly: true }
    }
    if (!isAiReplyEligible(routeInfo)) {
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
      aiEpoch: routeInfo?.aiEpoch ?? routeInfo?.ai_epoch ?? 0,
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
