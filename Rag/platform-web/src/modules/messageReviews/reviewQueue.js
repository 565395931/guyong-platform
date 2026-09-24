const RISK_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 })

function parseArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeReview(item = {}) {
  return {
    ...item,
    conversationId: item.conversationId || item.conversation_id,
    primaryMessageId: item.primaryMessageId || item.primary_message_id,
    messageIds: parseArray(item.messageIds || item.message_ids),
    riskLevel: item.riskLevel || item.risk_level || 'medium',
    confidence: item.confidence == null ? null : Number(item.confidence),
    reasonCode: item.reasonCode || item.reason_code || 'other',
    reasonText: item.reasonText || item.reason_text || '',
    recommendedAction: item.recommendedAction || item.recommended_action || 'review',
    ruleHits: parseArray(item.ruleHits || item.rule_hits),
    modelName: item.modelName || item.model_name || '',
    assignedTo: item.assignedTo ?? item.assigned_to ?? null,
    claimedBy: item.claimedBy ?? item.claimed_by ?? null,
    createdAt: item.createdAt || item.created_at,
    updatedAt: item.updatedAt || item.updated_at,
    userName: item.userName || item.user_name || '',
    lastMessage: item.lastMessage || item.last_message || ''
  }
}

export function sortReviewItems(items = []) {
  return items.map(normalizeReview).sort((left, right) => {
    const risk = (RISK_ORDER[left.riskLevel] ?? 9) - (RISK_ORDER[right.riskLevel] ?? 9)
    if (risk !== 0) return risk
    return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
  })
}

export function validateReply(text) {
  const errors = []
  if (typeof text !== 'string' || text.trim().length === 0) errors.push('请输入回复内容')
  if (typeof text === 'string' && text.length > 5000) errors.push('回复内容不能超过 5000 字')
  return errors
}

export function validateDismiss(input = {}) {
  const errors = []
  if (!input.reasonCode) errors.push('请选择不回复原因')
  if (input.note && input.note.length > 500) errors.push('备注不能超过 500 字')
  return errors
}

export function isReviewConflict(error) {
  return error?.response?.status === 409 || error?.code === 'REVIEW_CONFLICT'
}

export function canTakeOverReview(item, actor = {}) {
  return item?.status === 'claimed' &&
    ['supervisor', 'admin'].includes(actor.role) &&
    Number(item.claimedBy ?? item.claimed_by) !== Number(actor.id ?? actor.userId)
}
