const { REVIEW_DEFAULTS } = require('./reviewConfig')
const { decideReview, matchHardRules } = require('./reviewPolicy')

const DISMISS_REASONS = Object.freeze([
  'spam',
  'irrelevant',
  'duplicate',
  'already_resolved',
  'other'
])

function actorDetails(actor) {
  if (actor && typeof actor === 'object') {
    return {
      id: actor.id || actor.userId,
      role: actor.role || 'agent'
    }
  }
  return { id: actor, role: 'agent' }
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  return message?.content?.text || ''
}

function createServiceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createReviewService({
  repository,
  classifier,
  getConfig,
  getConversation,
  isSeatOnline,
  getContext = async () => [],
  sendReply,
  logger = console
}) {
  if (!repository) throw new TypeError('repository is required')

  async function reviewInbound(message) {
    const enabled = await getConfig('message_review_enabled')
    if (enabled === false) return { action: 'allow' }

    const conversationId = message?.conversationId || message?.conversation_id
    const messageId = message?.id || message?.messageId
    if (!conversationId || !messageId) {
      throw createServiceError('REVIEW_INVALID_MESSAGE', 'persisted message id and conversation id are required')
    }

    const ruleHits = matchHardRules(messageText(message))
    let classifierResult = null
    let classifierError = null

    if (ruleHits.length === 0) {
      try {
        classifierResult = await classifier.classify({ conversationId, message })
      } catch (error) {
        classifierError = error
        logger.error?.('review_classifier_failed', {
          conversationId,
          messageId,
          error: error.message
        })
      }
    }

    const allowThreshold = await getConfig('message_review_allow_threshold')
    const decision = decideReview({
      ruleHits,
      classifier: classifierResult,
      classifierError,
      allowThreshold: Number.isFinite(allowThreshold)
        ? allowThreshold
        : REVIEW_DEFAULTS.message_review_allow_threshold
    })
    if (decision.action === 'allow') return { action: 'allow' }

    const conversation = await getConversation(conversationId)
    const ownerId = conversation?.claimedBy || conversation?.claimed_by || conversation?.agentId || conversation?.agent_id
    const assignedTo = ownerId && await isSeatOnline(ownerId) ? ownerId : null
    const mergeWindowSeconds = await getConfig('message_review_merge_window_seconds')
    const modelName = await getConfig('message_review_model')
    const item = await repository.createOrMerge({
      conversationId,
      messageId,
      riskLevel: decision.riskLevel === 'low' ? 'medium' : decision.riskLevel,
      confidence: classifierResult?.confidence ?? null,
      reasonCode: decision.reasonCode,
      reasonText: classifierResult?.reason || (classifierError ? 'AI classifier unavailable; human review required' : 'Hard safety rule matched'),
      recommendedAction: classifierResult?.recommendedAction || 'review',
      ruleHits,
      modelName: classifierResult ? modelName : null,
      assignedTo,
      mergeWindowSeconds: Number.isFinite(mergeWindowSeconds)
        ? mergeWindowSeconds
        : REVIEW_DEFAULTS.message_review_merge_window_seconds
    })

    logger.info?.('review_created', {
      reviewId: item.id,
      conversationId,
      messageId,
      riskLevel: item.riskLevel || item.risk_level || decision.riskLevel,
      reasonCode: decision.reasonCode
    })
    return { action: 'review', item }
  }

  async function list(filters) {
    const assignmentTimeout = await getConfig('message_review_assignment_timeout_seconds')
    await repository.releaseExpiredAssignments?.(
      Number.isFinite(assignmentTimeout)
        ? assignmentTimeout
        : REVIEW_DEFAULTS.message_review_assignment_timeout_seconds
    )
    const [items, total] = await Promise.all([
      repository.list(filters),
      repository.count(filters)
    ])
    return { items, total }
  }

  async function detail(id, actor = null) {
    const item = await repository.detail(id)
    if (actor) {
      const operator = actorDetails(actor)
      const privileged = ['supervisor', 'admin'].includes(operator.role)
      const isPublic = item.status === 'pending' && item.assigned_to == null && item.claimed_by == null
      const isOwned = [item.assigned_to, item.claimed_by, item.resolved_by]
        .filter(value => value != null)
        .some(value => Number(value) === Number(operator.id))
      if (!privileged && !isPublic && !isOwned) {
        throw createServiceError('REVIEW_FORBIDDEN', 'review item is outside the operator scope')
      }
    }
    const contextCount = await getConfig('message_review_context_count')
    const context = await getContext(
      item.conversation_id || item.conversationId,
      Number.isFinite(contextCount) ? contextCount : REVIEW_DEFAULTS.message_review_context_count
    )
    return { ...item, context: Array.isArray(context) ? context : [] }
  }

  async function claim(id, actor) {
    const operator = actorDetails(actor)
    await repository.claim(id, operator.id, { privileged: ['supervisor', 'admin'].includes(operator.role) })
    logger.info?.('review_claimed', { reviewId: id, operatorId: operator.id })
    return detail(id)
  }

  async function takeover(id, actor) {
    const operator = actorDetails(actor)
    if (!['supervisor', 'admin'].includes(operator.role)) {
      throw createServiceError('REVIEW_FORBIDDEN', 'only supervisors can take over claimed review items')
    }
    await repository.takeover(id, operator.id)
    logger.info?.('review_taken_over', { reviewId: id, operatorId: operator.id })
    return detail(id)
  }

  async function release(id, actor) {
    const operator = actorDetails(actor)
    await repository.release(id, operator.id, { privileged: ['supervisor', 'admin'].includes(operator.role) })
    logger.info?.('review_released', { reviewId: id, operatorId: operator.id })
    return detail(id)
  }

  async function reply(id, actor, text) {
    const operator = actorDetails(actor)
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 5000) {
      throw createServiceError('REVIEW_INVALID_REPLY', 'reply text is required and must not exceed 5000 characters')
    }
    const item = await repository.detail(id)
    const sendResult = await sendReply({
      reviewId: id,
      conversationId: item.conversation_id || item.conversationId,
      operatorId: operator.id,
      text: text.trim()
    })
    if (!sendResult?.success || !sendResult.messageId) {
      throw createServiceError('REVIEW_SEND_FAILED', sendResult?.message || 'outbound reply failed')
    }
    await repository.resolveReply(id, operator.id, sendResult.messageId, {
      privileged: ['supervisor', 'admin'].includes(operator.role)
    })
    logger.info?.('review_replied', {
      reviewId: id,
      operatorId: operator.id,
      outboundMessageId: sendResult.messageId
    })
    return { ...item, status: 'replied', outboundMessageId: sendResult.messageId }
  }

  async function dismiss(id, actor, input = {}) {
    const operator = actorDetails(actor)
    if (!DISMISS_REASONS.includes(input.reasonCode)) {
      throw createServiceError('REVIEW_INVALID_REASON', 'a supported no-reply reason is required')
    }
    if (input.note != null && (typeof input.note !== 'string' || input.note.length > 500)) {
      throw createServiceError('REVIEW_INVALID_REASON', 'reason note must not exceed 500 characters')
    }
    await repository.resolveDismiss(id, operator.id, input.reasonCode, {
      privileged: ['supervisor', 'admin'].includes(operator.role),
      note: input.note?.trim() || null
    })
    logger.info?.('review_dismissed', {
      reviewId: id,
      operatorId: operator.id,
      reasonCode: input.reasonCode
    })
    const item = await repository.detail(id)
    return { ...item, status: 'dismissed', resolutionReason: input.reasonCode }
  }

  function stats(actor) {
    const operator = actorDetails(actor)
    if (operator.id == null) {
      throw createServiceError('REVIEW_FORBIDDEN', 'authenticated operator id is required')
    }
    return repository.stats({ operatorId: operator.id, role: operator.role })
  }

  return {
    reviewInbound,
    list,
    stats,
    detail,
    claim,
    takeover,
    release,
    reply,
    dismiss,
    hasOpenReviewForMessage: (messageId) => repository.hasOpenReviewForMessage(messageId)
  }
}

module.exports = {
  DISMISS_REASONS,
  createReviewService,
  createServiceError
}
