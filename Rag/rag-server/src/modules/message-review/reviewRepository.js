const { randomUUID } = require('node:crypto')

function createRepositoryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function affectedRows(result) {
  const [first, second] = Array.isArray(result) ? result : []
  return Number(first?.affectedRows ?? second?.affectedRows ?? (typeof second === 'number' ? second : 0))
}

function parseJson(value, fallback = []) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeRow(row) {
  if (!row) return null
  return {
    ...row,
    message_ids: parseJson(row.message_ids),
    rule_hits: parseJson(row.rule_hits)
  }
}

function createReviewRepository(sequelize) {
  async function detail(id) {
    const [rows] = await sequelize.query(
      `SELECT r.*,c.channel,c.account_id,c.user_id,c.user_name,c.agent_id,
              c.pool_type,c.conv_status,c.last_message,c.last_message_time
       FROM message_review_items r
       INNER JOIN conversations c ON c.id=r.conversation_id
       WHERE r.id=:id LIMIT 1`,
      { replacements: { id } }
    )
    if (!rows[0]) throw createRepositoryError('REVIEW_NOT_FOUND', 'review item not found')
    return normalizeRow(rows[0])
  }

  async function findOpenByMessage(conversationId, messageId) {
    const [rows] = await sequelize.query(
      `SELECT * FROM message_review_items
       WHERE conversation_id=:conversationId AND status='pending'
         AND JSON_CONTAINS(message_ids,JSON_QUOTE(:messageId))
       ORDER BY created_at DESC LIMIT 1`,
      { replacements: { conversationId, messageId } }
    )
    return normalizeRow(rows[0])
  }

  async function createOrMerge(input) {
    const mergeWindowSeconds = Math.min(300, Math.max(0, Number(input.mergeWindowSeconds) || 0))
    if (mergeWindowSeconds > 0) {
      const mergeCutoff = new Date(Date.now() - mergeWindowSeconds * 1000)
      const mergeResult = await sequelize.query(
        `UPDATE message_review_items
         SET message_ids=JSON_ARRAY_APPEND(message_ids,'$',:messageId),
             risk_level=IF(risk_level='high','high',:riskLevel),
             confidence=:confidence,reason_code=:reasonCode,reason_text=:reasonText,
             recommended_action=:recommendedAction,rule_hits=:ruleHits,
             model_name=:modelName,updated_at=NOW()
         WHERE conversation_id=:conversationId AND status='pending' AND claimed_by IS NULL
           AND created_at >= :mergeCutoff
           AND NOT JSON_CONTAINS(message_ids,JSON_QUOTE(:messageId))
         ORDER BY created_at DESC LIMIT 1`,
        {
          replacements: {
            conversationId: input.conversationId,
            messageId: input.messageId,
            riskLevel: input.riskLevel,
            confidence: input.confidence ?? null,
            reasonCode: input.reasonCode,
            reasonText: input.reasonText || '',
            recommendedAction: input.recommendedAction || 'review',
            ruleHits: JSON.stringify(input.ruleHits || []),
            modelName: input.modelName || null,
            mergeCutoff
          }
        }
      )
      if (affectedRows(mergeResult) > 0) {
        return findOpenByMessage(input.conversationId, input.messageId)
      }
    }

    const id = input.id || randomUUID()
    await sequelize.query(
      `INSERT INTO message_review_items
       (id,conversation_id,primary_message_id,message_ids,status,risk_level,confidence,
        reason_code,reason_text,recommended_action,rule_hits,model_name,assigned_to)
       VALUES (:id,:conversationId,:messageId,:messageIds,'pending',:riskLevel,:confidence,
               :reasonCode,:reasonText,:recommendedAction,:ruleHits,:modelName,:assignedTo)
       ON DUPLICATE KEY UPDATE primary_message_id=VALUES(primary_message_id)`,
      {
        replacements: {
          id,
          conversationId: input.conversationId,
          messageId: input.messageId,
          messageIds: JSON.stringify([input.messageId]),
          riskLevel: input.riskLevel,
          confidence: input.confidence ?? null,
          reasonCode: input.reasonCode,
          reasonText: input.reasonText || '',
          recommendedAction: input.recommendedAction || 'review',
          ruleHits: JSON.stringify(input.ruleHits || []),
          modelName: input.modelName || null,
          assignedTo: input.assignedTo || null
        }
      }
    )

    const [rows] = await sequelize.query(
      'SELECT * FROM message_review_items WHERE primary_message_id=:messageId LIMIT 1',
      { replacements: { messageId: input.messageId } }
    )
    return normalizeRow(rows[0] || { id, status: 'pending', ...input, message_ids: [input.messageId] })
  }

  function buildScope(filters) {
    const conditions = []
    const replacements = {
      operatorId: filters.operatorId,
      limit: Math.min(100, Math.max(1, Number(filters.limit) || 20)),
      offset: Math.max(0, Number(filters.offset) || 0)
    }
    const scope = filters.scope || 'mine'

    if (scope === 'mine') {
      conditions.push('(r.assigned_to=:operatorId OR r.claimed_by=:operatorId)')
    } else if (scope === 'public') {
      conditions.push('r.assigned_to IS NULL AND r.claimed_by IS NULL')
    } else if (scope === 'all') {
      if (!['supervisor', 'admin'].includes(filters.role)) {
        throw createRepositoryError('REVIEW_FORBIDDEN', 'all review scope requires supervisor access')
      }
    } else {
      throw createRepositoryError('REVIEW_INVALID_SCOPE', 'invalid review scope')
    }

    if (filters.status) {
      conditions.push('r.status=:status')
      replacements.status = filters.status
    } else {
      conditions.push("r.status IN ('pending','claimed')")
    }
    if (filters.riskLevel) {
      conditions.push('r.risk_level=:riskLevel')
      replacements.riskLevel = filters.riskLevel
    }
    if (filters.channel) {
      conditions.push('c.channel=:channel')
      replacements.channel = filters.channel
    }
    return { where: conditions.join(' AND '), replacements }
  }

  async function list(filters = {}) {
    const { where, replacements } = buildScope(filters)
    const [rows] = await sequelize.query(
      `SELECT r.*,c.channel,c.user_name,c.last_message,c.last_message_time
       FROM message_review_items r
       INNER JOIN conversations c ON c.id=r.conversation_id
       WHERE ${where}
       ORDER BY FIELD(r.risk_level,'high','medium','low'),r.created_at ASC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    return rows.map(normalizeRow)
  }

  async function count(filters = {}) {
    const { where, replacements } = buildScope(filters)
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM message_review_items r
       INNER JOIN conversations c ON c.id=r.conversation_id WHERE ${where}`,
      { replacements }
    )
    return Number(rows[0]?.total || 0)
  }

  async function stats({ operatorId, role }) {
    const allCondition = ['supervisor', 'admin'].includes(role) ? '1=1' : 'r.assigned_to=:operatorId'
    const [rows] = await sequelize.query(
      `SELECT
         SUM(CASE WHEN r.status IN ('pending','claimed') AND r.assigned_to=:operatorId THEN 1 ELSE 0 END) AS mine,
         SUM(CASE WHEN r.status='pending' AND r.assigned_to IS NULL THEN 1 ELSE 0 END) AS public,
         SUM(CASE WHEN r.status IN ('pending','claimed') THEN 1 ELSE 0 END) AS all_count,
         SUM(CASE WHEN r.status IN ('pending','claimed') AND r.risk_level='high' AND ${allCondition} THEN 1 ELSE 0 END) AS high
       FROM message_review_items r`,
      { replacements: { operatorId } }
    )
    return {
      mine: Number(rows[0]?.mine || 0),
      public: Number(rows[0]?.public || 0),
      all: Number(rows[0]?.all_count || 0),
      high: Number(rows[0]?.high || 0)
    }
  }

  async function releaseExpiredAssignments(timeoutSeconds) {
    const safeTimeout = Math.min(3600, Math.max(30, Number(timeoutSeconds) || 300))
    const assignmentCutoff = new Date(Date.now() - safeTimeout * 1000)
    const result = await sequelize.query(
      `UPDATE message_review_items
       SET assigned_to=NULL,updated_at=NOW()
       WHERE status='pending' AND claimed_by IS NULL AND assigned_to IS NOT NULL
         AND updated_at < :assignmentCutoff`,
      { replacements: { assignmentCutoff } }
    )
    return affectedRows(result)
  }

  async function conditionalUpdate(sql, replacements) {
    const result = await sequelize.query(sql, { replacements })
    if (affectedRows(result) === 0) {
      throw createRepositoryError('REVIEW_CONFLICT', 'review item state changed')
    }
    return true
  }

  async function claim(id, operatorId, { privileged = false } = {}) {
    const assignmentCondition = privileged
      ? ''
      : 'AND (assigned_to IS NULL OR assigned_to=:operatorId)'
    return conditionalUpdate(
      `UPDATE message_review_items
       SET status='claimed',claimed_by=:operatorId,claimed_at=NOW(),updated_at=NOW()
       WHERE id=:id AND status='pending'
         ${assignmentCondition}`,
      { id, operatorId }
    )
  }

  async function release(id, operatorId, { privileged = false } = {}) {
    const ownershipCondition = privileged ? '' : 'AND claimed_by=:operatorId'
    return conditionalUpdate(
      `UPDATE message_review_items
       SET status='pending',claimed_by=NULL,claimed_at=NULL,updated_at=NOW()
       WHERE id=:id AND status='claimed' ${ownershipCondition}`,
      { id, operatorId }
    )
  }

  async function takeover(id, operatorId) {
    return conditionalUpdate(
      `UPDATE message_review_items
       SET claimed_by=:operatorId,claimed_at=NOW(),updated_at=NOW()
       WHERE id=:id AND status='claimed' AND claimed_by<>:operatorId`,
      { id, operatorId }
    )
  }

  async function resolveReply(id, operatorId, outboundMessageId) {
    return conditionalUpdate(
      `UPDATE message_review_items
       SET status='replied',resolved_by=:operatorId,resolution_reason='human_reply',
           outbound_message_id=:outboundMessageId,resolved_at=NOW(),updated_at=NOW()
       WHERE id=:id AND status='claimed' AND claimed_by=:operatorId`,
      { id, operatorId, outboundMessageId }
    )
  }

  async function resolveDismiss(id, operatorId, resolutionReason) {
    return conditionalUpdate(
      `UPDATE message_review_items
       SET status='dismissed',resolved_by=:operatorId,resolution_reason=:resolutionReason,
           resolved_at=NOW(),updated_at=NOW()
       WHERE id=:id AND status='claimed' AND claimed_by=:operatorId`,
      { id, operatorId, resolutionReason }
    )
  }

  async function hasOpenReviewForMessage(messageId) {
    if (!messageId) return false
    const [rows] = await sequelize.query(
      `SELECT id FROM message_review_items
       WHERE status IN ('pending','claimed')
         AND (primary_message_id=:messageId OR JSON_CONTAINS(message_ids,JSON_QUOTE(:messageId)))
       LIMIT 1`,
      { replacements: { messageId } }
    )
    return Boolean(rows[0])
  }

  return {
    createOrMerge,
    list,
    count,
    stats,
    releaseExpiredAssignments,
    detail,
    claim,
    takeover,
    release,
    resolveReply,
    resolveDismiss,
    hasOpenReviewForMessage
  }
}

module.exports = {
  createReviewRepository,
  createRepositoryError
}
