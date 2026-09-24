const { sequelize } = require('../../config/database')

const MAX_RESPONSE_SECONDS = 24 * 60 * 60
const QUERY_CACHE_TTL_MS = 10 * 1000
let schemaReadyPromise = null
const overviewCache = new Map()
const agentPerformanceCache = new Map()

async function ensureStatisticsSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      try {
        await sequelize.query(
          `ALTER TABLE plat_messages ADD COLUMN sender_id INT NULL COMMENT '发送人用户ID：人工客服消息记录坐席ID，AI/客户/系统为空' AFTER sender_type`
        )
        console.log('[Statistics] plat_messages.sender_id 字段已补齐')
      } catch (err) {
        if (!String(err.message || '').includes('Duplicate column')) {
          console.warn('[Statistics] 检查 sender_id 字段时跳过:', err.message)
        }
      }

      try {
        await sequelize.query(
          'ALTER TABLE plat_messages ADD INDEX idx_sender_id_created (sender_id, created_at)'
        )
        console.log('[Statistics] plat_messages.idx_sender_id_created 索引已补齐')
      } catch (err) {
        const message = String(err.message || '')
        if (!message.includes('Duplicate key name') && !message.includes('already exists')) {
          console.warn('[Statistics] 检查 sender_id 索引时跳过:', err.message)
        }
      }

      const statisticsIndexes = [
        {
          name: 'idx_stats_msg_created_direction_sender',
          sql: 'ALTER TABLE plat_messages ADD INDEX idx_stats_msg_created_direction_sender (created_at, direction, sender_type)'
        },
        {
          name: 'idx_stats_msg_conv_created_direction_sender',
          sql: 'ALTER TABLE plat_messages ADD INDEX idx_stats_msg_conv_created_direction_sender (conversation_id, created_at, direction, sender_type)'
        },
        {
          name: 'idx_stats_msg_customer_lifecycle',
          sql: 'ALTER TABLE plat_messages ADD INDEX idx_stats_msg_customer_lifecycle (channel, account_id, user_id, direction, sender_type, created_at)'
        },
        {
          name: 'idx_stats_pool_action_created_conv',
          sql: 'ALTER TABLE conversation_pool_logs ADD INDEX idx_stats_pool_action_created_conv (action, created_at, conversation_id)'
        },
        {
          name: 'idx_stats_conv_account_pool_claimed',
          sql: 'ALTER TABLE conversations ADD INDEX idx_stats_conv_account_pool_claimed (account_id, pool_type, claimed_by)'
        }
      ]

      for (const { name, sql } of statisticsIndexes) {
        try {
          await sequelize.query(sql)
          console.log(`[Statistics] ${name} 索引已补齐`)
        } catch (err) {
          const message = String(err.message || '')
          if (!message.includes('Duplicate key name') && !message.includes('already exists')) {
            console.warn(`[Statistics] 检查 ${name} 索引时跳过:`, err.message)
          }
        }
      }
    })()
  }
  return schemaReadyPromise
}

function cacheKeyForQuery(query = {}) {
  return Object.keys(query)
    .sort()
    .map(key => `${key}:${query[key] ?? ''}`)
    .join('|')
}

function getCached(cache, query) {
  const key = cacheKeyForQuery(query)
  const hit = cache.get(key)
  if (!hit || Date.now() - hit.createdAt > QUERY_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.data
}

function setCached(cache, query, data) {
  cache.set(cacheKeyForQuery(query), { data, createdAt: Date.now() })
  if (cache.size > 100) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }
}

function formatChinaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function chinaDateToUtcMysql(dateText, endOfDay = false) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))
    ? dateText
    : formatChinaDate()
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000'
  return new Date(`${safeDate}T${time}+08:00`).toISOString().slice(0, 19).replace('T', ' ')
}

function normalizeRange(query = {}) {
  const today = formatChinaDate()
  const startDate = query.start_date || query.startDate || today
  const endDate = query.end_date || query.endDate || startDate
  return {
    startDate,
    endDate,
    startAt: chinaDateToUtcMysql(startDate, false),
    endAt: chinaDateToUtcMysql(endDate, true)
  }
}

function buildMessageWhere(alias, params, options = {}) {
  const conditions = [`${alias}.created_at BETWEEN :startAt AND :endAt`]
  if (params.channel) conditions.push(`${alias}.channel = :channel`)
  if (params.account_id) conditions.push(`${alias}.account_id = :accountId`)
  if (options.senderType) conditions.push(`${alias}.sender_type = :senderType`)
  if (options.direction) conditions.push(`${alias}.direction = :direction`)
  if (params.visibility_user_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM conversations visible_c
      WHERE visible_c.id = ${alias}.conversation_id
        AND visible_c.account_id IN (
          SELECT account_id FROM seat_account_bindings
          WHERE seat_id = :visibilityUserId AND status = 'active'
        )
        AND (
          visible_c.pool_type IN ('ai_self', 'pending_human', 'public')
          OR (visible_c.pool_type IN ('private', 'long_term') AND visible_c.claimed_by = :visibilityUserId)
        )
    )`)
  }
  if (params.agent_id) {
    if (options.senderType === 'agent' && options.direction === 'outbound') {
      conditions.push(`COALESCE(${alias}.sender_id, c.claimed_by, c.agent_id) = :senderId`)
    } else {
      conditions.push(`EXISTS (
        SELECT 1 FROM plat_messages scope_pm
        LEFT JOIN conversations scope_c ON scope_c.id = scope_pm.conversation_id
        WHERE scope_pm.conversation_id = ${alias}.conversation_id
          AND scope_pm.sender_type = 'agent'
          AND COALESCE(scope_pm.sender_id, scope_c.claimed_by, scope_c.agent_id) = :senderId
          AND scope_pm.created_at BETWEEN :startAt AND :endAt
      )`)
    }
  }
  if (options.excludeFailed) conditions.push(`COALESCE(${alias}.send_status, '') != 'failed'`)
  return conditions.join(' AND ')
}

function messageFromClause(params) {
  return params.agent_id
    ? 'plat_messages m LEFT JOIN conversations c ON c.id = m.conversation_id'
    : 'plat_messages m'
}

function buildReplacements(query, range) {
  return {
    startAt: range.startAt,
    endAt: range.endAt,
    channel: query.channel || null,
    accountId: query.account_id ? parseInt(query.account_id, 10) : null,
    senderId: query.agent_id ? parseInt(query.agent_id, 10) : null,
    visibilityUserId: query.visibility_user_id ? parseInt(query.visibility_user_id, 10) : null
  }
}

function buildConversationScopeConditions(alias, query, options = {}) {
  const conditions = []
  if (query.channel) conditions.push(`${alias}.channel = :channel`)
  if (query.account_id) conditions.push(`${alias}.account_id = :accountId`)
  if (query.visibility_user_id) {
    conditions.push(`${alias}.account_id IN (
      SELECT account_id FROM seat_account_bindings
      WHERE seat_id = :visibilityUserId AND status = 'active'
    )`)
  }
  if (query.agent_id && options.includeAgentScope) {
    conditions.push(`EXISTS (
      SELECT 1 FROM plat_messages scope_pm
      LEFT JOIN conversations scope_c ON scope_c.id = scope_pm.conversation_id
      WHERE scope_pm.conversation_id = ${alias}.id
        AND scope_pm.sender_type = 'agent'
        AND COALESCE(scope_pm.sender_id, scope_c.claimed_by, scope_c.agent_id) = :senderId
        AND scope_pm.created_at BETWEEN :startAt AND :endAt
    )`)
  }
  return conditions
}

function customerKey(alias) {
  return `CONCAT_WS(':', ${alias}.channel, COALESCE(${alias}.account_id, ''), COALESCE(${alias}.user_id, ''))`
}

async function countMessageMetric(query, range, options) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: options.senderType,
    direction: options.direction
  }
  const where = buildMessageWhere('m', query, options)
  const fromClause = messageFromClause(query)
  const [rows] = await sequelize.query(
    `SELECT
       COUNT(*) AS messages,
       COUNT(DISTINCT ${customerKey('m')}) AS customers,
       COUNT(DISTINCT m.conversation_id) AS conversations
     FROM ${fromClause}
     WHERE ${where}`,
    { replacements }
  )
  return rows[0] || { messages: 0, customers: 0, conversations: 0 }
}

async function countOverviewMessageMetrics(query, range) {
  const replacements = buildReplacements(query, range)
  const where = buildMessageWhere('m', query)
  const fromClause = messageFromClause(query)
  const agentOwnerFilter = query.agent_id
    ? 'AND COALESCE(m.sender_id, c.claimed_by, c.agent_id) = :senderId'
    : ''

  const [rows] = await sequelize.query(
    `SELECT
       SUM(CASE WHEN m.direction = 'inbound' AND m.sender_type = 'customer' THEN 1 ELSE 0 END) AS inbound_messages,
       COUNT(DISTINCT CASE WHEN m.direction = 'inbound' AND m.sender_type = 'customer' THEN ${customerKey('m')} END) AS inbound_customers,
       COUNT(DISTINCT CASE WHEN m.direction = 'inbound' AND m.sender_type = 'customer' THEN m.conversation_id END) AS inbound_conversations,
       SUM(CASE WHEN m.direction = 'outbound' AND m.sender_type = 'ai' AND COALESCE(m.send_status, '') != 'failed' THEN 1 ELSE 0 END) AS ai_messages,
       COUNT(DISTINCT CASE WHEN m.direction = 'outbound' AND m.sender_type = 'ai' AND COALESCE(m.send_status, '') != 'failed' THEN ${customerKey('m')} END) AS ai_customers,
       COUNT(DISTINCT CASE WHEN m.direction = 'outbound' AND m.sender_type = 'ai' AND COALESCE(m.send_status, '') != 'failed' THEN m.conversation_id END) AS ai_conversations,
       SUM(CASE WHEN m.direction = 'outbound' AND m.sender_type = 'agent' AND COALESCE(m.send_status, '') != 'failed' ${agentOwnerFilter} THEN 1 ELSE 0 END) AS agent_messages,
       COUNT(DISTINCT CASE WHEN m.direction = 'outbound' AND m.sender_type = 'agent' AND COALESCE(m.send_status, '') != 'failed' ${agentOwnerFilter} THEN ${customerKey('m')} END) AS agent_customers,
       COUNT(DISTINCT CASE WHEN m.direction = 'outbound' AND m.sender_type = 'agent' AND COALESCE(m.send_status, '') != 'failed' ${agentOwnerFilter} THEN m.conversation_id END) AS agent_conversations
     FROM ${fromClause}
     WHERE ${where}`,
    { replacements }
  )

  return rows[0] || {}
}

async function countInquiryCustomerLifecycle(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'customer',
    direction: 'inbound'
  }
  const where = buildMessageWhere('m', query, {
    direction: 'inbound',
    senderType: 'customer'
  })
  const fromClause = messageFromClause(query)
  const priorCustomerMatch = `
    p.direction = 'inbound'
    AND p.sender_type = 'customer'
    AND p.created_at < :startAt
    AND p.channel <=> current_customers.channel
    AND p.account_id <=> current_customers.account_id
    AND p.user_id <=> current_customers.user_id
  `

  const [rows] = await sequelize.query(
    `SELECT
       SUM(CASE
         WHEN NOT EXISTS (SELECT 1 FROM plat_messages p WHERE ${priorCustomerMatch})
         THEN 1 ELSE 0
       END) AS new_customers,
       SUM(CASE
         WHEN EXISTS (SELECT 1 FROM plat_messages p WHERE ${priorCustomerMatch})
         THEN 1 ELSE 0
       END) AS returning_customers
     FROM (
       SELECT DISTINCT
         m.channel,
         m.account_id,
         m.user_id,
         ${customerKey('m')} AS customer_key
       FROM ${fromClause}
       WHERE ${where}
     ) current_customers`,
    { replacements }
  )

  return rows[0] || { new_customers: 0, returning_customers: 0 }
}

async function averageResponseSeconds(query, range, senderType, senderId = null) {
  const params = senderId ? { ...query, agent_id: senderId } : query
  const replacements = {
    ...buildReplacements(params, range),
    senderType,
    direction: 'outbound'
  }
  const where = buildMessageWhere('m', params, {
    direction: 'outbound',
    senderType,
    senderId: Boolean(senderId),
    excludeFailed: true
  })
  const fromClause = messageFromClause(params)

  const [rows] = await sequelize.query(
    `SELECT AVG(response_seconds) AS avg_seconds
     FROM (
       SELECT TIMESTAMPDIFF(SECOND, (
         SELECT MAX(i.created_at)
         FROM plat_messages i
         WHERE i.conversation_id = m.conversation_id
           AND i.direction = 'inbound'
           AND i.sender_type = 'customer'
           AND i.created_at < m.created_at
       ), m.created_at) AS response_seconds
       FROM ${fromClause}
       WHERE ${where}
     ) t
     WHERE response_seconds IS NOT NULL
       AND response_seconds >= 0
       AND response_seconds <= :maxResponseSeconds`,
    { replacements: { ...replacements, maxResponseSeconds: MAX_RESPONSE_SECONDS } }
  )
  return Math.round(Number(rows[0]?.avg_seconds || 0))
}

async function averageUnassignedAgentResponseSeconds(query, range) {
  const scopedQuery = { ...query }
  delete scopedQuery.agent_id
  const replacements = {
    ...buildReplacements(scopedQuery, range),
    senderType: 'agent',
    direction: 'outbound',
    maxResponseSeconds: MAX_RESPONSE_SECONDS
  }
  const where = buildMessageWhere('m', scopedQuery, {
    direction: 'outbound',
    senderType: 'agent',
    excludeFailed: true
  })

  const [rows] = await sequelize.query(
    `SELECT AVG(response_seconds) AS avg_seconds
     FROM (
       SELECT TIMESTAMPDIFF(SECOND, (
         SELECT MAX(i.created_at)
         FROM plat_messages i
         WHERE i.conversation_id = m.conversation_id
           AND i.direction = 'inbound'
           AND i.sender_type = 'customer'
           AND i.created_at < m.created_at
       ), m.created_at) AS response_seconds
       FROM plat_messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE ${where}
         AND COALESCE(m.sender_id, c.claimed_by, c.agent_id) IS NULL
     ) t
     WHERE response_seconds IS NOT NULL
       AND response_seconds >= 0
       AND response_seconds <= :maxResponseSeconds`,
    { replacements }
  )
  return Math.round(Number(rows[0]?.avg_seconds || 0))
}

async function averageAgentResponseSecondsByOwner(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'agent',
    direction: 'outbound',
    maxResponseSeconds: MAX_RESPONSE_SECONDS
  }
  const where = buildMessageWhere('m', query, {
    direction: 'outbound',
    senderType: 'agent',
    excludeFailed: true
  })

  const [rows] = await sequelize.query(
    `SELECT owner_id, AVG(response_seconds) AS avg_seconds
     FROM (
       SELECT
         COALESCE(m.sender_id, c.claimed_by, c.agent_id) AS owner_id,
         TIMESTAMPDIFF(SECOND, (
           SELECT MAX(i.created_at)
           FROM plat_messages i
           WHERE i.conversation_id = m.conversation_id
             AND i.direction = 'inbound'
             AND i.sender_type = 'customer'
             AND i.created_at < m.created_at
         ), m.created_at) AS response_seconds
       FROM plat_messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE ${where}
     ) t
     WHERE response_seconds IS NOT NULL
       AND response_seconds >= 0
       AND response_seconds <= :maxResponseSeconds
     GROUP BY owner_id`,
    { replacements }
  )

  return new Map(rows.map(row => [
    row.owner_id == null ? 'unassigned' : Number(row.owner_id),
    Math.round(Number(row.avg_seconds || 0))
  ]))
}

async function currentPrivateCountsByAgent(agentIds) {
  if (!agentIds.length) return new Map()
  const [rows] = await sequelize.query(
    `SELECT claimed_by AS agent_id, COUNT(*) AS current_private_count
     FROM conversations
     WHERE pool_type = 'private'
       AND claimed_by IN (:agentIds)
     GROUP BY claimed_by`,
    { replacements: { agentIds } }
  )
  return new Map(rows.map(row => [Number(row.agent_id), Number(row.current_private_count || 0)]))
}

async function getTrend(query, range) {
  const startMs = new Date(`${range.startDate}T00:00:00+08:00`).getTime()
  const endMs = new Date(`${range.endDate}T23:59:59+08:00`).getTime()
  const groupByHour = endMs - startMs <= 2 * 24 * 60 * 60 * 1000
  const chinaCreatedAt = "CONVERT_TZ(m.created_at, '+00:00', '+08:00')"
  const bucketSql = groupByHour
    ? `DATE_FORMAT(${chinaCreatedAt}, '%Y-%m-%d %H:00:00')`
    : `DATE_FORMAT(${chinaCreatedAt}, '%Y-%m-%d')`
  const replacements = buildReplacements(query, range)
  const where = buildMessageWhere('m', query)
  const fromClause = messageFromClause(query)
  const [rows] = await sequelize.query(
    `SELECT
       ${bucketSql} AS bucket,
       SUM(CASE WHEN direction = 'inbound' AND sender_type = 'customer' THEN 1 ELSE 0 END) AS inbound_messages,
       SUM(CASE WHEN direction = 'outbound' AND sender_type = 'ai' THEN 1 ELSE 0 END) AS ai_replies,
       SUM(CASE WHEN direction = 'outbound' AND sender_type = 'agent' THEN 1 ELSE 0 END) AS agent_replies
     FROM ${fromClause}
     WHERE ${where}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { replacements }
  )
  return { granularity: groupByHour ? 'hour' : 'day', list: rows }
}

async function getChannelDistribution(query, range) {
  const replacements = buildReplacements(query, range)
  const where = buildMessageWhere('m', query, { direction: 'inbound', senderType: 'customer' })
  const fromClause = messageFromClause(query)
  const [rows] = await sequelize.query(
    `SELECT m.channel AS channel, COUNT(DISTINCT ${customerKey('m')}) AS value
     FROM ${fromClause}
     WHERE ${where}
     GROUP BY m.channel
     ORDER BY value DESC`,
    { replacements: { ...replacements, senderType: 'customer', direction: 'inbound' } }
  )
  return rows
}

async function countAiTransferMetric(query, range) {
  const replacements = buildReplacements(query, range)
  const conditions = [
    `l.created_at BETWEEN :startAt AND :endAt`,
    `l.action = 'ai_to_human'`,
    `l.to_pool = 'pending_human'`
  ]

  if (query.channel) conditions.push('c.channel = :channel')
  if (query.account_id) conditions.push('c.account_id = :accountId')
  if (query.visibility_user_id) {
    conditions.push(`c.account_id IN (
      SELECT account_id FROM seat_account_bindings
      WHERE seat_id = :visibilityUserId AND status = 'active'
    )`)
  }
  if (query.agent_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM plat_messages scope_pm
      LEFT JOIN conversations scope_c ON scope_c.id = scope_pm.conversation_id
      WHERE scope_pm.conversation_id = c.id
        AND scope_pm.sender_type = 'agent'
        AND COALESCE(scope_pm.sender_id, scope_c.claimed_by, scope_c.agent_id) = :senderId
        AND scope_pm.created_at BETWEEN :startAt AND :endAt
    )`)
  }

  const [rows] = await sequelize.query(
    `SELECT
       COUNT(DISTINCT l.conversation_id) AS conversations,
       COUNT(DISTINCT ${customerKey('c')}) AS customers
     FROM conversation_pool_logs l
     LEFT JOIN conversations c ON c.id = l.conversation_id
     WHERE ${conditions.join(' AND ')}`,
    { replacements }
  )

  return rows[0] || { conversations: 0, customers: 0 }
}

async function countAiServedCustomers(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'ai',
    direction: 'outbound'
  }
  const aiMessageWhere = buildMessageWhere('m', query, {
    direction: 'outbound',
    senderType: 'ai',
    excludeFailed: true
  })
  const aiMessageFromClause = messageFromClause(query)
  const transferConditions = [
    `l.created_at BETWEEN :startAt AND :endAt`,
    `l.action = 'ai_to_human'`,
    `l.to_pool = 'pending_human'`
  ]

  if (query.channel) transferConditions.push('c.channel = :channel')
  if (query.account_id) transferConditions.push('c.account_id = :accountId')
  if (query.visibility_user_id) {
    transferConditions.push(`c.account_id IN (
      SELECT account_id FROM seat_account_bindings
      WHERE seat_id = :visibilityUserId AND status = 'active'
    )`)
  }
  if (query.agent_id) {
    transferConditions.push(`EXISTS (
      SELECT 1 FROM plat_messages scope_pm
      LEFT JOIN conversations scope_c ON scope_c.id = scope_pm.conversation_id
      WHERE scope_pm.conversation_id = c.id
        AND scope_pm.sender_type = 'agent'
        AND COALESCE(scope_pm.sender_id, scope_c.claimed_by, scope_c.agent_id) = :senderId
        AND scope_pm.created_at BETWEEN :startAt AND :endAt
    )`)
  }

  const [rows] = await sequelize.query(
    `SELECT COUNT(DISTINCT customer_key) AS customers
     FROM (
       SELECT ${customerKey('m')} AS customer_key
       FROM ${aiMessageFromClause}
       WHERE ${aiMessageWhere}
       UNION
       SELECT ${customerKey('c')} AS customer_key
       FROM conversation_pool_logs l
       LEFT JOIN conversations c ON c.id = l.conversation_id
       WHERE ${transferConditions.join(' AND ')}
     ) ai_served
     WHERE customer_key IS NOT NULL AND customer_key != ''`,
    { replacements }
  )

  return Number(rows[0]?.customers || 0)
}

async function countAiResolutionMetrics(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'ai',
    direction: 'outbound'
  }
  const aiMessageWhere = buildMessageWhere('m', query, {
    direction: 'outbound',
    senderType: 'ai',
    excludeFailed: true
  })
  const aiMessageFromClause = messageFromClause(query)
  const transferConditions = [
    `l.created_at BETWEEN :startAt AND :endAt`,
    `l.action = 'ai_to_human'`,
    `l.to_pool = 'pending_human'`,
    ...buildConversationScopeConditions('c', query, { includeAgentScope: true })
  ]

  const [rows] = await sequelize.query(
    `SELECT
       COUNT(DISTINCT customer_key) AS served_customers,
       COUNT(DISTINCT CASE WHEN has_ai_reply = 1 THEN customer_key END) AS replied_customers,
       COUNT(DISTINCT CASE WHEN has_transfer = 1 THEN customer_key END) AS transfer_customers,
       COUNT(DISTINCT CASE WHEN has_ai_reply = 1 AND has_transfer = 0 THEN customer_key END) AS independent_customers
     FROM (
       SELECT
         customer_key,
         MAX(has_ai_reply) AS has_ai_reply,
         MAX(has_transfer) AS has_transfer
       FROM (
         SELECT ${customerKey('m')} AS customer_key, 1 AS has_ai_reply, 0 AS has_transfer
         FROM ${aiMessageFromClause}
         WHERE ${aiMessageWhere}
         UNION ALL
         SELECT ${customerKey('c')} AS customer_key, 0 AS has_ai_reply, 1 AS has_transfer
         FROM conversation_pool_logs l
         LEFT JOIN conversations c ON c.id = l.conversation_id
         WHERE ${transferConditions.join(' AND ')}
       ) ai_events
       WHERE customer_key IS NOT NULL AND customer_key != ''
       GROUP BY customer_key
     ) ai_summary`,
    { replacements }
  )

  const row = rows[0] || {}
  return {
    servedCustomers: Number(row.served_customers || 0),
    repliedCustomers: Number(row.replied_customers || 0),
    transferCustomers: Number(row.transfer_customers || 0),
    independentCustomers: Number(row.independent_customers || 0)
  }
}

function classifyAiTransferReason(reason = '') {
  const text = String(reason || '')
  if (text.includes('转人工关键词')) {
    return { key: 'customer_handoff', label: '客户主动要人工' }
  }
  if (text.includes('非文本') || text.includes('图片') || text.includes('文件') || text.includes('语音') || text.includes('视频')) {
    return { key: 'non_text', label: '非文本内容' }
  }
  if (text.includes('仍在追问') || (text.includes('回复') && text.includes('轮'))) {
    return { key: 'max_rounds', label: '连续追问' }
  }
  if (text.includes('情绪分析为负面') || text.includes('负面')) {
    return { key: 'negative_sentiment', label: '负面情绪' }
  }
  if (text.includes('置信度') || text.includes('无相关信息')) {
    return { key: 'low_confidence', label: '知识命中不足' }
  }
  if (text.includes('人工接管/无资料兜底') || text.includes('兜底话术')) {
    return { key: 'reply_handoff_phrase', label: 'AI兜底转人工' }
  }
  if (text.includes('有效性校验')) {
    return { key: 'validation_failed', label: '回答质检未通过' }
  }
  if (text.includes('等待AI') || text.includes('超时')) {
    return { key: 'timeout', label: 'AI处理超时' }
  }
  return { key: 'other', label: '其他原因' }
}

async function getAiTransferReasonDistribution(query, range) {
  const replacements = buildReplacements(query, range)
  const conditions = [
    `l.created_at BETWEEN :startAt AND :endAt`,
    `l.action = 'ai_to_human'`,
    `l.to_pool = 'pending_human'`,
    ...buildConversationScopeConditions('c', query, { includeAgentScope: true })
  ]
  const [rows] = await sequelize.query(
    `SELECT l.conversation_id, ${customerKey('c')} AS customer_key, l.reason
     FROM conversation_pool_logs l
     LEFT JOIN conversations c ON c.id = l.conversation_id
     WHERE ${conditions.join(' AND ')}`,
    { replacements }
  )

  const grouped = new Map()
  for (const row of rows) {
    const category = classifyAiTransferReason(row.reason)
    if (!grouped.has(category.key)) {
      grouped.set(category.key, {
        key: category.key,
        label: category.label,
        conversationsSet: new Set(),
        customersSet: new Set()
      })
    }
    const stat = grouped.get(category.key)
    if (row.conversation_id) stat.conversationsSet.add(row.conversation_id)
    if (row.customer_key) stat.customersSet.add(row.customer_key)
  }

  return Array.from(grouped.values())
    .map(item => ({
      key: item.key,
      label: item.label,
      conversations: item.conversationsSet.size,
      customers: item.customersSet.size
    }))
    .sort((a, b) => b.conversations - a.conversations || a.label.localeCompare(b.label))
}

async function averageFirstResponseSecondsByOwner(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'agent',
    direction: 'outbound',
    maxResponseSeconds: MAX_RESPONSE_SECONDS
  }
  const scopeConditions = buildConversationScopeConditions('c', query)
  const conditions = [
    `m.created_at BETWEEN :startAt AND :endAt`,
    `m.direction = :direction`,
    `m.sender_type = :senderType`,
    `COALESCE(m.send_status, '') != 'failed'`,
    ...scopeConditions
  ]
  if (query.agent_id) {
    conditions.push(`COALESCE(m.sender_id, c.claimed_by, c.agent_id) = :senderId`)
  }

  const [rows] = await sequelize.query(
    `SELECT owner_id, AVG(response_seconds) AS avg_seconds
     FROM (
       SELECT
         first_agent.owner_id,
         TIMESTAMPDIFF(SECOND, (
           SELECT MIN(i.created_at)
           FROM plat_messages i
           WHERE i.conversation_id = first_agent.conversation_id
             AND i.direction = 'inbound'
             AND i.sender_type = 'customer'
             AND i.created_at <= first_agent.first_agent_at
         ), first_agent.first_agent_at) AS response_seconds
       FROM (
         SELECT
           COALESCE(m.sender_id, c.claimed_by, c.agent_id) AS owner_id,
           m.conversation_id,
           MIN(m.created_at) AS first_agent_at
         FROM plat_messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
         WHERE ${conditions.join(' AND ')}
         GROUP BY owner_id, m.conversation_id
       ) first_agent
     ) t
     WHERE response_seconds IS NOT NULL
       AND response_seconds >= 0
       AND response_seconds <= :maxResponseSeconds
     GROUP BY owner_id`,
    { replacements }
  )

  return new Map(rows.map(row => [
    row.owner_id == null ? 'unassigned' : Number(row.owner_id),
    Math.round(Number(row.avg_seconds || 0))
  ]))
}

async function averageClaimSecondsByOwner(query, range) {
  const replacements = buildReplacements(query, range)
  const conditions = [
    `l.created_at BETWEEN :startAt AND :endAt`,
    `l.action = 'claim'`,
    `l.operator_id IS NOT NULL`,
    `l.from_pool IN ('pending_human', 'public')`,
    ...buildConversationScopeConditions('c', query)
  ]
  if (query.agent_id) conditions.push(`l.operator_id = :senderId`)

  const [rows] = await sequelize.query(
    `SELECT operator_id AS owner_id, AVG(claim_seconds) AS avg_seconds
     FROM (
       SELECT
         l.operator_id,
         TIMESTAMPDIFF(SECOND, COALESCE((
           SELECT MAX(prev.created_at)
           FROM conversation_pool_logs prev
           WHERE prev.conversation_id = l.conversation_id
             AND prev.created_at < l.created_at
             AND prev.to_pool = l.from_pool
         ), c.created_at), l.created_at) AS claim_seconds
       FROM conversation_pool_logs l
       LEFT JOIN conversations c ON c.id = l.conversation_id
       WHERE ${conditions.join(' AND ')}
     ) t
     WHERE claim_seconds IS NOT NULL
       AND claim_seconds >= 0
       AND claim_seconds <= :maxResponseSeconds
     GROUP BY operator_id`,
    { replacements: { ...replacements, maxResponseSeconds: MAX_RESPONSE_SECONDS } }
  )

  return new Map(rows.map(row => [Number(row.owner_id), Math.round(Number(row.avg_seconds || 0))]))
}

async function followupQualityByOwner(query, range) {
  const replacements = {
    ...buildReplacements(query, range),
    senderType: 'agent',
    direction: 'outbound'
  }
  const scopeConditions = buildConversationScopeConditions('c', query)
  const conditions = [
    `m.created_at BETWEEN :startAt AND :endAt`,
    `m.direction = :direction`,
    `m.sender_type = :senderType`,
    `COALESCE(m.send_status, '') != 'failed'`,
    ...scopeConditions
  ]
  if (query.agent_id) {
    conditions.push(`COALESCE(m.sender_id, c.claimed_by, c.agent_id) = :senderId`)
  }

  const [rows] = await sequelize.query(
    `SELECT
       owner_id,
       COUNT(DISTINCT customer_key) AS followed_customers,
       COUNT(DISTINCT CASE WHEN customer_replied = 1 THEN customer_key END) AS effective_followup_customers,
       COUNT(*) AS followed_conversations,
       SUM(CASE WHEN ai_handoff_followed = 1 THEN 1 ELSE 0 END) AS handoff_followed_conversations,
       SUM(CASE WHEN ai_handoff_followed = 1 AND customer_replied_after_last = 0 THEN 1 ELSE 0 END) AS silent_conversations
     FROM (
       SELECT
         agent_scope.owner_id,
         agent_scope.conversation_id,
         agent_scope.customer_key,
         CASE WHEN EXISTS (
           SELECT 1 FROM plat_messages i
           WHERE i.conversation_id = agent_scope.conversation_id
             AND i.direction = 'inbound'
             AND i.sender_type = 'customer'
             AND i.created_at > agent_scope.first_agent_at
             AND i.created_at <= :endAt
         ) THEN 1 ELSE 0 END AS customer_replied,
         CASE WHEN EXISTS (
           SELECT 1 FROM plat_messages i
           WHERE i.conversation_id = agent_scope.conversation_id
             AND i.direction = 'inbound'
             AND i.sender_type = 'customer'
             AND i.created_at > agent_scope.last_agent_at
             AND i.created_at <= :endAt
         ) THEN 1 ELSE 0 END AS customer_replied_after_last,
         CASE WHEN EXISTS (
           SELECT 1 FROM conversation_pool_logs l
           WHERE l.conversation_id = agent_scope.conversation_id
             AND l.action = 'ai_to_human'
             AND l.to_pool = 'pending_human'
             AND l.created_at <= agent_scope.last_agent_at
         ) THEN 1 ELSE 0 END AS ai_handoff_followed
       FROM (
         SELECT
           COALESCE(m.sender_id, c.claimed_by, c.agent_id) AS owner_id,
           m.conversation_id,
           ${customerKey('m')} AS customer_key,
           MIN(m.created_at) AS first_agent_at,
           MAX(m.created_at) AS last_agent_at
         FROM plat_messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
         WHERE ${conditions.join(' AND ')}
         GROUP BY owner_id, m.conversation_id, customer_key
       ) agent_scope
     ) quality
     GROUP BY owner_id`,
    { replacements }
  )

  return new Map(rows.map(row => {
    const followedCustomers = Number(row.followed_customers || 0)
    const effectiveFollowupCustomers = Number(row.effective_followup_customers || 0)
    const followedConversations = Number(row.followed_conversations || 0)
    const handoffFollowedConversations = Number(row.handoff_followed_conversations || 0)
    const silentConversations = Number(row.silent_conversations || 0)
    return [
      row.owner_id == null ? 'unassigned' : Number(row.owner_id),
      {
        followedCustomers,
        effectiveFollowupCustomers,
        followedConversations,
        handoffFollowedConversations,
        silentConversations,
        effectiveFollowupRate: followedCustomers > 0 ? Number(((effectiveFollowupCustomers / followedCustomers) * 100).toFixed(1)) : 0,
        silenceRate: handoffFollowedConversations > 0 ? Number(((silentConversations / handoffFollowedConversations) * 100).toFixed(1)) : 0
      }
    ]
  }))
}

async function getOverview(query = {}) {
  await ensureStatisticsSchema()
  const cached = getCached(overviewCache, query)
  if (cached) return cached

  const range = normalizeRange(query)
  const [messageMetrics, aiAvg, agentAvg, trend, channelDistribution, lifecycle, aiTransfer, aiResolution, aiTransferReasons] = await Promise.all([
    countOverviewMessageMetrics(query, range),
    averageResponseSeconds(query, range, 'ai'),
    averageResponseSeconds(query, range, 'agent'),
    getTrend(query, range),
    getChannelDistribution(query, range),
    countInquiryCustomerLifecycle(query, range),
    countAiTransferMetric(query, range),
    countAiResolutionMetrics(query, range),
    getAiTransferReasonDistribution(query, range)
  ])
  const aiServedCustomers = aiResolution.servedCustomers
  const aiTransferCustomers = aiResolution.transferCustomers || Number(aiTransfer.customers || 0)
  const inquiryCustomers = Number(messageMetrics.inbound_customers || 0)
  const aiIndependentCustomers = aiResolution.independentCustomers

  const data = {
    range,
    metrics: {
      inboundMessages: Number(messageMetrics.inbound_messages || 0),
      inquiryCustomers,
      inquiryConversations: Number(messageMetrics.inbound_conversations || 0),
      newInquiryCustomers: Number(lifecycle.new_customers || 0),
      returningInquiryCustomers: Number(lifecycle.returning_customers || 0),
      aiRepliedCustomers: aiResolution.repliedCustomers || Number(messageMetrics.ai_customers || 0),
      aiServedCustomers,
      aiReplyMessages: Number(messageMetrics.ai_messages || 0),
      aiAvgResponseSeconds: aiAvg,
      aiTransferCustomers,
      aiTransferConversations: Number(aiTransfer.conversations || 0),
      aiTransferRate: aiServedCustomers > 0 ? Number(((aiTransferCustomers / aiServedCustomers) * 100).toFixed(1)) : 0,
      aiAcceptanceRate: inquiryCustomers > 0 ? Number(((aiServedCustomers / inquiryCustomers) * 100).toFixed(1)) : 0,
      aiIndependentCustomers,
      aiIndependentRate: aiServedCustomers > 0 ? Number(((aiIndependentCustomers / aiServedCustomers) * 100).toFixed(1)) : 0,
      aiSavedAgentWorkload: aiIndependentCustomers,
      agentRepliedCustomers: Number(messageMetrics.agent_customers || 0),
      agentReplyMessages: Number(messageMetrics.agent_messages || 0),
      agentAvgResponseSeconds: agentAvg
    },
    trend,
    channelDistribution,
    aiTransferReasons
  }

  setCached(overviewCache, query, data)
  return data
}

async function getAgentPerformance(query = {}) {
  await ensureStatisticsSchema()
  const cached = getCached(agentPerformanceCache, query)
  if (cached) return cached

  const range = normalizeRange(query)
  const replacements = buildReplacements(query, range)
  const agentFilter = query.agent_id ? 'AND id = :senderId' : ''

  const agentsPromise = sequelize.query(
    `SELECT id, username, role
     FROM users
     WHERE status = 'active'
       AND role = 'agent'
       ${agentFilter}
     ORDER BY username ASC`,
    { replacements }
  )

  const messageWhere = buildMessageWhere('m', query, {
    direction: 'outbound',
    senderType: 'agent',
    excludeFailed: true
  })
  const replyRowsPromise = sequelize.query(
    `SELECT
       COALESCE(m.sender_id, c.claimed_by, c.agent_id) AS owner_id,
       COUNT(*) AS reply_messages,
       COUNT(DISTINCT ${customerKey('m')}) AS replied_customers,
       COUNT(DISTINCT m.conversation_id) AS inquiry_count
     FROM plat_messages m
     LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE ${messageWhere}
     GROUP BY owner_id
     `,
    { replacements: { ...replacements, senderType: 'agent', direction: 'outbound' } }
  )
  const avgResponseMapPromise = averageAgentResponseSecondsByOwner(query, range)
  const firstResponseMapPromise = averageFirstResponseSecondsByOwner(query, range)
  const claimSecondsMapPromise = averageClaimSecondsByOwner(query, range)
  const followupQualityMapPromise = followupQualityByOwner(query, range)

  const [[agents], [replyRows], avgResponseMap, firstResponseMap, claimSecondsMap, followupQualityMap] = await Promise.all([
    agentsPromise,
    replyRowsPromise,
    avgResponseMapPromise,
    firstResponseMapPromise,
    claimSecondsMapPromise,
    followupQualityMapPromise
  ])
  const currentPrivateCountMap = await currentPrivateCountsByAgent(agents.map(agent => Number(agent.id)))

  const replyMap = new Map(replyRows.map(row => [
    row.owner_id == null ? 'unassigned' : Number(row.owner_id),
    row
  ]))
  const rows = []
  for (const agent of agents) {
    const stat = replyMap.get(Number(agent.id)) || {}
    const quality = followupQualityMap.get(Number(agent.id)) || {}

    rows.push({
      agentId: agent.id,
      name: agent.username,
      role: agent.role,
      replyMessages: Number(stat.reply_messages || 0),
      repliedCustomers: Number(stat.replied_customers || 0),
      inquiryCount: Number(stat.inquiry_count || 0),
      avgResponseSeconds: avgResponseMap.get(Number(agent.id)) || 0,
      firstResponseSeconds: firstResponseMap.get(Number(agent.id)) || 0,
      avgClaimSeconds: claimSecondsMap.get(Number(agent.id)) || 0,
      effectiveFollowupCustomers: Number(quality.effectiveFollowupCustomers || 0),
      effectiveFollowupRate: Number(quality.effectiveFollowupRate || 0),
      followedConversations: Number(quality.followedConversations || 0),
      silentConversations: Number(quality.silentConversations || 0),
      silenceRate: Number(quality.silenceRate || 0),
      currentPrivateCount: currentPrivateCountMap.get(Number(agent.id)) || 0
    })
  }

  const unassignedStat = replyMap.get('unassigned')
  if (!query.agent_id && unassignedStat && Number(unassignedStat.reply_messages || 0) > 0) {
    const quality = followupQualityMap.get('unassigned') || {}
    rows.push({
      agentId: null,
      name: '未归属历史消息',
      role: 'unassigned',
      replyMessages: Number(unassignedStat.reply_messages || 0),
      repliedCustomers: Number(unassignedStat.replied_customers || 0),
      inquiryCount: Number(unassignedStat.inquiry_count || 0),
      avgResponseSeconds: avgResponseMap.get('unassigned') || 0,
      firstResponseSeconds: firstResponseMap.get('unassigned') || 0,
      avgClaimSeconds: 0,
      effectiveFollowupCustomers: Number(quality.effectiveFollowupCustomers || 0),
      effectiveFollowupRate: Number(quality.effectiveFollowupRate || 0),
      followedConversations: Number(quality.followedConversations || 0),
      silentConversations: Number(quality.silentConversations || 0),
      silenceRate: Number(quality.silenceRate || 0),
      currentPrivateCount: 0
    })
  }

  rows.sort((a, b) => b.effectiveFollowupCustomers - a.effectiveFollowupCustomers || a.firstResponseSeconds - b.firstResponseSeconds)
  const data = { range, list: rows }
  setCached(agentPerformanceCache, query, data)
  return data
}

function toCsv(rows) {
  const headers = ['客服', '角色', '回复条数', '跟进客户数', '有效跟进客户数', '有效跟进率', '首次响应秒', '待人工领取秒', '转人工后沉默率', '当前私有池']
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push([
      row.name,
      row.role,
      row.replyMessages,
      row.repliedCustomers,
      row.effectiveFollowupCustomers,
      `${row.effectiveFollowupRate}%`,
      row.firstResponseSeconds,
      row.avgClaimSeconds,
      `${row.silenceRate}%`,
      row.currentPrivateCount
    ].map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
  }
  return `\ufeff${lines.join('\n')}`
}

const afterSalesCache = new Map()

async function getAfterSalesStats(query = {}) {
  const cached = getCached(afterSalesCache, query)
  if (cached) return cached

  const range = normalizeRange(query)
  const channelWhere = query.channel ? 'AND o.channel = :channel' : ''
  const rep = {
    startAt: range.startAt,
    endAt: range.endAt,
    channel: query.channel || null
  }

  const [[summary], channelDist, productDist, trendRows, reasonRows] = await Promise.all([
    sequelize.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(deal_amount), 0) AS total_amount,
        COALESCE(AVG(deal_amount), 0) AS avg_amount
       FROM orders o
       WHERE o.status = 'after_sales'
         AND o.updated_at BETWEEN :startAt AND :endAt
         ${channelWhere}`,
      { replacements: rep, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT o.channel,
              COUNT(*) AS order_count,
              COALESCE(SUM(o.deal_amount), 0) AS total_amount
       FROM orders o
       WHERE o.status = 'after_sales'
         AND o.updated_at BETWEEN :startAt AND :endAt
         ${channelWhere}
       GROUP BY o.channel
       ORDER BY order_count DESC`,
      { replacements: rep, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT oi.product_name,
              COUNT(DISTINCT o.id) AS order_count,
              COALESCE(SUM(o.deal_amount), 0) AS total_amount
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'after_sales'
         AND o.updated_at BETWEEN :startAt AND :endAt
         ${channelWhere}
       GROUP BY oi.product_name
       ORDER BY order_count DESC
       LIMIT 15`,
      { replacements: rep, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT DATE(CONVERT_TZ(o.updated_at, '+00:00', '+08:00')) AS date,
              COUNT(*) AS order_count,
              COALESCE(SUM(o.deal_amount), 0) AS total_amount
       FROM orders o
       WHERE o.status = 'after_sales'
         AND o.updated_at BETWEEN :startAt AND :endAt
         ${channelWhere}
       GROUP BY date
       ORDER BY date`,
      { replacements: rep, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COALESCE(NULLIF(TRIM(oe.title), ''), '未备注原因') AS reason,
              COUNT(DISTINCT oe.order_id) AS cnt
       FROM order_events oe
       JOIN orders o ON o.id = oe.order_id
       WHERE o.status = 'after_sales'
         AND o.updated_at BETWEEN :startAt AND :endAt
         ${channelWhere}
       GROUP BY reason
       ORDER BY cnt DESC
       LIMIT 10`,
      { replacements: rep, type: sequelize.QueryTypes.SELECT }
    )
  ])

  const data = {
    range,
    summary: {
      totalOrders: Number(summary?.total_orders || 0),
      totalAmount: Number(summary?.total_amount || 0),
      avgAmount: Number(summary?.avg_amount || 0)
    },
    channelDistribution: channelDist,
    productDistribution: productDist,
    trend: trendRows,
    reasonDistribution: reasonRows
  }
  setCached(afterSalesCache, query, data)
  return data
}

module.exports = {
  normalizeRange,
  getOverview,
  getAgentPerformance,
  getAfterSalesStats,
  toCsv
}
