const crypto = require('crypto')
const { sequelize: defaultSequelize } = require('../../config/database')

function createCustomerOperationsRepository({ sequelize = defaultSequelize } = {}) {
  async function findOrCreateCustomerIdentity(identity, transaction) {
    const normalized = {
      channel: String(identity.channel || '').trim(),
      accountId: identity.accountId ?? null,
      normalizedAccountKey: identity.accountId == null ? '__none__' : String(identity.accountId),
      externalUserId: String(identity.externalUserId || '').trim(),
      phone: identity.phone ? String(identity.phone).trim() : null,
      displayName: identity.displayName ? String(identity.displayName).trim() : null
    }
    if (!normalized.channel || !normalized.externalUserId) {
      throw new Error('Customer identity requires channel and externalUserId')
    }

    const [identityRows] = await sequelize.query(
      `SELECT customer_id
       FROM customer_identities
       WHERE channel = :channel
         AND normalized_account_key = :normalizedAccountKey
         AND external_user_id = :externalUserId
       LIMIT 1`,
      {
        replacements: normalized,
        transaction
      }
    )
    if (identityRows[0]?.customer_id) return { customerId: identityRows[0].customer_id }

    let customerId = null
    if (normalized.phone) {
      const [customerRows] = await sequelize.query(
        'SELECT id FROM customers WHERE phone = :phone ORDER BY created_at ASC LIMIT 1',
        { replacements: { phone: normalized.phone }, transaction }
      )
      customerId = customerRows[0]?.id || null
    }
    if (!customerId) {
      customerId = crypto.randomUUID()
      await sequelize.query(
        `INSERT INTO customers (id, phone, display_name, created_at, updated_at)
         VALUES (:id, :phone, :displayName, NOW(), NOW())`,
        {
          replacements: {
            id: customerId,
            phone: normalized.phone || normalized.externalUserId,
            displayName: normalized.displayName
          },
          transaction
        }
      )
    }

    await sequelize.query(
      `INSERT INTO customer_identities
        (id, customer_id, channel, account_id, normalized_account_key, external_user_id, phone, display_name, created_at, updated_at)
       VALUES (:id, :customerId, :channel, :accountId, :normalizedAccountKey, :externalUserId, :phone, :displayName, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         customer_id = VALUES(customer_id),
         phone = COALESCE(VALUES(phone), phone),
         display_name = COALESCE(VALUES(display_name), display_name),
         updated_at = NOW()`,
      {
        replacements: { id: crypto.randomUUID(), customerId, ...normalized },
        transaction
      }
    )
    return { customerId }
  }

  async function upsertCommunicationDay(input, transaction) {
    const conversationIds = input.conversationId ? JSON.stringify([String(input.conversationId)]) : '[]'
    const [rows] = await sequelize.query(
      `INSERT INTO customer_communication_days
        (id, customer_id, communication_date, message_count, first_message_at, last_message_at,
         owner_id, conversation_ids, ai_pending, created_at, updated_at)
       VALUES
        (:id, :customerId, :communicationDate, :messageCount, :firstMessageAt, :lastMessageAt,
         :ownerId, CAST(:conversationIds AS JSON), 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         message_count = message_count + VALUES(message_count),
         first_message_at = LEAST(COALESCE(first_message_at, VALUES(first_message_at)), VALUES(first_message_at)),
         last_message_at = GREATEST(COALESCE(last_message_at, VALUES(last_message_at)), VALUES(last_message_at)),
         owner_id = COALESCE(VALUES(owner_id), owner_id),
         conversation_ids = CASE
           WHEN :conversationId IS NULL OR JSON_CONTAINS(conversation_ids, JSON_QUOTE(:conversationId), '$')
             THEN conversation_ids
           ELSE JSON_ARRAY_APPEND(COALESCE(conversation_ids, JSON_ARRAY()), '$', :conversationId)
         END,
         ai_pending = 1,
         updated_at = NOW()`,
      {
        replacements: {
          id: crypto.randomUUID(),
          customerId: input.customerId,
          communicationDate: input.communicationDate,
          messageCount: Number(input.messageCountDelta || 1),
          firstMessageAt: input.firstMessageAt || null,
          lastMessageAt: input.lastMessageAt || null,
          ownerId: input.ownerId ?? null,
          conversationIds,
          conversationId: input.conversationId ? String(input.conversationId) : null
        },
        transaction
      }
    )
    return rows[0] || null
  }

  async function resequenceCommunicationStages(customerId, transaction) {
    const [days] = await sequelize.query(
      `SELECT id
       FROM customer_communication_days
       WHERE customer_id = :customerId
       ORDER BY communication_date ASC, id ASC`,
      { replacements: { customerId }, transaction }
    )
    for (let index = 0; index < days.length; index += 1) {
      const communicationIndex = index + 1
      const stageLabel = communicationIndex === 1 ? 'first' : communicationIndex === 2 ? 'second' : communicationIndex === 3 ? 'third' : 'nth'
      await sequelize.query(
        `UPDATE customer_communication_days
         SET communication_index = :communicationIndex, stage_label = :stageLabel, updated_at = NOW()
         WHERE id = :id`,
        { replacements: { id: days[index].id, communicationIndex, stageLabel }, transaction }
      )
    }
    return days.length
  }

  async function createWonFollowupIfMissing(input, transaction) {
    const [rows] = await sequelize.query(
      `INSERT INTO customer_followups
        (id, customer_id, conversation_id, order_id, type, status, due_at, assigned_to, source,
         ai_reason, ai_confidence, ai_signals, created_at, updated_at)
       VALUES
        (:id, :customerId, :conversationId, :orderId, :type, 'pending', :dueAt, :assignedTo, :source,
         :aiReason, :aiConfidence, CAST(:aiSignals AS JSON), NOW(), NOW())
       ON DUPLICATE KEY UPDATE id = id, updated_at = NOW()`,
      {
        replacements: {
          id: crypto.randomUUID(),
          customerId: input.customerId,
          conversationId: input.conversationId || null,
          orderId: input.orderId || null,
          type: input.type,
          dueAt: input.dueAt,
          assignedTo: input.assignedTo ?? null,
          source: input.source || 'fallback',
          aiReason: input.aiReason || null,
          aiConfidence: input.aiConfidence ?? null,
          aiSignals: JSON.stringify(input.aiSignals || [])
        },
        transaction
      }
    )
    return rows[0] || null
  }

  async function markCustomerWon(input, transaction) {
    await sequelize.query(
      `UPDATE customers
       SET won_status = 'won', won_at = COALESCE(won_at, :wonAt), updated_at = NOW()
       WHERE id = :customerId`,
      {
        replacements: { customerId: input.customerId, wonAt: input.wonAt || new Date() },
        transaction
      }
    )
  }

  async function cancelPendingOrderFollowups(orderId, transaction) {
    if (!orderId) return
    await sequelize.query(
      `UPDATE customer_followups
       SET status = 'cancelled', updated_at = NOW()
       WHERE order_id = :orderId AND status IN ('pending', 'due')`,
      { replacements: { orderId }, transaction }
    )
  }

  async function markAiRecomputeNeeded(customerId, transaction) {
    await sequelize.query(
      `UPDATE customer_communication_days
       SET ai_pending = 1, updated_at = NOW()
       WHERE customer_id = :customerId`,
      { replacements: { customerId }, transaction }
    )
  }

  async function listPendingCommunicationDays(limit = 20, transaction) {
    const [rows] = await sequelize.query(
      `SELECT d.id, d.customer_id, d.communication_date, d.communication_index, d.stage_label,
              d.message_count, d.summary, c.phone, c.display_name, c.ai_profile
       FROM customer_communication_days d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.ai_pending = 1
       ORDER BY d.updated_at ASC
       LIMIT :limit`,
      { replacements: { limit: Math.min(Math.max(Number(limit) || 20, 1), 100) }, transaction }
    )
    return rows
  }

  async function updateCommunicationAi(input, transaction) {
    await sequelize.query(
      `UPDATE customer_communication_days
       SET summary = :summary,
           stage_label = COALESCE(:stageLabel, stage_label),
           ai_pending = 0,
           updated_at = NOW()
       WHERE id = :id`,
      {
        replacements: {
          id: input.id,
          summary: input.summary || null,
          stageLabel: input.stageLabel || null
        },
        transaction
      }
    )
  }

  async function updateCustomerAiProfile(input, transaction) {
    await sequelize.query(
      `UPDATE customers
       SET ai_profile = CAST(:profile AS JSON), ai_profile_updated_at = NOW(), updated_at = NOW()
       WHERE id = :customerId`,
      {
        replacements: {
          customerId: input.customerId,
          profile: JSON.stringify(input.profile || {})
        },
        transaction
      }
    )
  }

  async function getCustomerAiContext(customerId, transaction) {
    const replacements = { customerId }
    const [identityResult, communicationResult, messageResult, orderResult] = await Promise.all([
      sequelize.query(
        `SELECT channel, account_id AS accountId, external_user_id AS externalUserId,
                display_name AS displayName
         FROM customer_identities
         WHERE customer_id = :customerId
         ORDER BY updated_at DESC
         LIMIT 12`,
        { replacements, transaction }
      ),
      sequelize.query(
        `SELECT communication_date AS communicationDate,
                communication_index AS communicationIndex,
                stage_label AS stageLabel, message_count AS messageCount, summary
         FROM customer_communication_days
         WHERE customer_id = :customerId
         ORDER BY communication_date DESC
         LIMIT 10`,
        { replacements, transaction }
      ),
      sequelize.query(
        `SELECT pm.direction, pm.sender_type AS senderType,
                COALESCE(
                  JSON_UNQUOTE(JSON_EXTRACT(pm.content, '$.text')),
                  JSON_UNQUOTE(JSON_EXTRACT(pm.content, '$.content')),
                  LEFT(CAST(pm.content AS CHAR), 800)
                ) AS text,
                DATE_FORMAT(pm.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM customer_identities ci
         JOIN conversations cv
           ON cv.channel = ci.channel
          AND cv.account_id <=> ci.account_id
          AND cv.user_id = ci.external_user_id
         JOIN plat_messages pm ON pm.conversation_id = cv.id
         WHERE ci.customer_id = :customerId
           AND (pm.direction = 'inbound' OR pm.sender_type = 'agent')
         ORDER BY pm.created_at DESC
         LIMIT 24`,
        { replacements, transaction }
      ),
      sequelize.query(
        `SELECT o.order_no AS orderNo, o.status, o.payment_status AS paymentStatus,
                o.currency, o.deal_amount AS dealAmount,
                DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM orders o
         WHERE o.customer_id = :customerId
         ORDER BY o.created_at DESC
         LIMIT 10`,
        { replacements, transaction }
      )
    ])

    return {
      accountIdentities: identityResult[0],
      recentCommunications: communicationResult[0],
      recentMessages: [...messageResult[0]].reverse(),
      recentOrders: orderResult[0]
    }
  }

  async function listPendingFollowups(limit = 20, transaction) {
    const [rows] = await sequelize.query(
      `SELECT f.id, f.customer_id, f.order_id, f.type, f.status,
              DATE_FORMAT(f.due_at, '%Y-%m-%d %H:%i:%s') AS dueAt,
              f.assigned_to, f.ai_reason AS aiReason, f.ai_confidence AS aiConfidence,
              f.ai_signals AS aiSignals, f.overridden_by AS overriddenBy,
              c.phone, c.display_name, c.ai_profile
       FROM customer_followups f
       JOIN customers c ON c.id = f.customer_id
       WHERE f.status IN ('pending', 'due')
       ORDER BY f.due_at ASC
       LIMIT :limit`,
      { replacements: { limit: Math.min(Math.max(Number(limit) || 20, 1), 100) }, transaction }
    )
    return rows
  }

  async function updateFollowupAi(input, transaction) {
    await sequelize.query(
      `UPDATE customer_followups
       SET due_at = CASE WHEN overridden_by IS NULL THEN :dueAt ELSE due_at END,
           ai_reason = :aiReason,
           ai_confidence = :aiConfidence,
           ai_signals = CAST(:aiSignals AS JSON),
           source = :source,
           updated_at = NOW()
       WHERE id = :id`,
      {
        replacements: {
          id: input.id,
          dueAt: input.dueAt,
          aiReason: input.aiReason || null,
          aiConfidence: input.aiConfidence ?? null,
          aiSignals: JSON.stringify(input.aiSignals || []),
          source: input.source || 'ai'
        },
        transaction
      }
    )
  }

  async function markDueFollowups(transaction) {
    await sequelize.query(
      `UPDATE customer_followups
       SET status = 'due', updated_at = NOW()
       WHERE status = 'pending' AND due_at <= NOW()`,
      { transaction }
    )
  }

  async function listFollowups(customerId, visibility = {}, transaction) {
    const conditions = ['f.customer_id = :customerId']
    const replacements = { customerId, ...(visibility.replacements || {}) }
    if (visibility.sql && visibility.sql !== '1=1') {
      conditions.push(`EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = f.conversation_id AND ${visibility.sql}
      )`)
    }
    const [rows] = await sequelize.query(
      `SELECT f.* FROM customer_followups f
       WHERE ${conditions.join(' AND ')}
       ORDER BY f.due_at ASC, f.created_at DESC`,
      { replacements, transaction }
    )
    return rows
  }

  async function appendAiAuditLog(input, transaction) {
    await sequelize.query(
      `INSERT INTO customer_ai_audit_logs
        (id, customer_id, followup_id, report_date, action_type, source, input_summary, output,
         model_name, confidence, error_message, created_at)
       VALUES (:id, :customerId, :followupId, :reportDate, :actionType, :source,
         CAST(:inputSummary AS JSON), CAST(:output AS JSON), :modelName, :confidence, :errorMessage, NOW())`,
      {
        replacements: {
          id: crypto.randomUUID(),
          customerId: input.customerId || null,
          followupId: input.followupId || null,
          reportDate: input.reportDate || null,
          actionType: input.actionType,
          source: input.source,
          inputSummary: JSON.stringify(input.inputSummary || {}),
          output: JSON.stringify(input.output || {}),
          modelName: input.modelName || null,
          confidence: input.confidence ?? null,
          errorMessage: input.errorMessage || null
        },
        transaction
      }
    )
  }

  return {
    findOrCreateCustomerIdentity,
    upsertCommunicationDay,
    resequenceCommunicationStages,
    createWonFollowupIfMissing,
    markCustomerWon,
    cancelPendingOrderFollowups,
    markAiRecomputeNeeded,
    listPendingCommunicationDays,
    updateCommunicationAi,
    updateCustomerAiProfile,
    getCustomerAiContext,
    listPendingFollowups,
    updateFollowupAi,
    markDueFollowups,
    listFollowups,
    appendAiAuditLog
  }
}

module.exports = { createCustomerOperationsRepository }
