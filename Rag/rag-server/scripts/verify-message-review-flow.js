const assert = require('node:assert/strict')
const { createReviewService } = require('../src/modules/message-review/reviewService')

async function main() {
  const items = new Map()
  let sequence = 0
  const repository = {
    async createOrMerge(input) {
      const item = {
        id: `review-${++sequence}`,
        status: 'pending',
        conversation_id: input.conversationId,
        assigned_to: input.assignedTo,
        claimed_by: null,
        ...input
      }
      items.set(item.id, item)
      return item
    },
    async detail(id) {
      const item = items.get(id)
      if (!item) throw new Error('review item missing')
      return item
    },
    async claim(id, operatorId) {
      Object.assign(items.get(id), { status: 'claimed', claimed_by: operatorId })
    },
    async resolveReply(id, operatorId, outboundMessageId) {
      Object.assign(items.get(id), {
        status: 'replied', resolved_by: operatorId, outbound_message_id: outboundMessageId
      })
    },
    async resolveDismiss(id, operatorId, resolutionReason) {
      Object.assign(items.get(id), {
        status: 'dismissed', resolved_by: operatorId, resolution_reason: resolutionReason
      })
    },
    async list() { return [] },
    async count() { return 0 },
    async stats() { return { mine: 0, public: 0, all: 0, high: 0 } },
    async hasOpenReviewForMessage() { return false }
  }
  const classifier = {
    async classify({ message }) {
      const text = message.content.text
      if (text.includes('no reply')) {
        return {
          riskLevel: 'high', confidence: 0.98, recommendedAction: 'no_reply',
          reasonCode: 'abusive', reason: 'Potential abuse'
        }
      }
      if (text.includes('unclear')) {
        return {
          riskLevel: 'medium', confidence: 0.6, recommendedAction: 'review',
          reasonCode: 'ambiguous', reason: 'Unclear intent'
        }
      }
      return {
        riskLevel: 'low', confidence: 0.96, recommendedAction: 'allow',
        reasonCode: 'other', reason: 'Routine request'
      }
    }
  }
  const config = {
    message_review_enabled: true,
    message_review_allow_threshold: 0.85,
    message_review_merge_window_seconds: 30,
    message_review_model: 'test-review-model',
    message_review_context_count: 6
  }
  const service = createReviewService({
    repository,
    classifier,
    getConfig: async key => config[key],
    getConversation: async () => ({ agentId: 7 }),
    isSeatOnline: async () => true,
    getContext: async () => [],
    sendReply: async () => ({ success: true, messageId: 'outbound-1' }),
    logger: { info() {}, error() {} }
  })

  const normalMessage = await service.reviewInbound({
    id: 'message-normal', conversationId: 'conversation-1', content: { text: 'delivery time' }
  })
  assert.equal(normalMessage.action, 'allow')

  const noReplySuggestion = await service.reviewInbound({
    id: 'message-no-reply', conversationId: 'conversation-1', content: { text: 'no reply candidate' }
  })
  assert.equal(noReplySuggestion.action, 'review')
  assert.equal(noReplySuggestion.item.recommendedAction, 'no_reply')

  await service.claim(noReplySuggestion.item.id, 7)
  const humanReply = await service.reply(noReplySuggestion.item.id, 7, 'Human-reviewed response')
  assert.equal(humanReply.status, 'replied')

  const dismissCandidate = await service.reviewInbound({
    id: 'message-dismiss', conversationId: 'conversation-2', content: { text: 'unclear request' }
  })
  await service.claim(dismissCandidate.item.id, 7)
  const humanDismiss = await service.dismiss(dismissCandidate.item.id, 7, { reasonCode: 'irrelevant' })
  assert.equal(humanDismiss.status, 'dismissed')
  assert.ok(items.get(dismissCandidate.item.id).resolved_by)
  assert.ok(items.get(dismissCandidate.item.id).resolution_reason)

  console.log('4 review flows verified')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
