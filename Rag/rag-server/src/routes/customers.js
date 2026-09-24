/**
 * 客户管理 API
 *
 * 聚合客服工作台用于维护客户手机号、时间和备注。
 */

const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const { sequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const { createCustomerOperationsService } = require('../modules/customer-operations/customerOperations.service')
const { createCustomerOperationsRepository } = require('../modules/customer-operations/customerOperations.repository')
const { localDateKey } = require('../modules/customer-operations/communicationRules')
const { buildNextFollowup } = require('../modules/customer-operations/customerFollowupRules')

const customerOperationsService = createCustomerOperationsService()
const customerOperationsRepository = createCustomerOperationsRepository()

function currentUserId(req) {
  return req.user.id || req.user.userId
}

function customerVisibility(req, alias = 'c') {
  if (['admin', 'supervisor'].includes(req.user?.role)) {
    return { sql: '1=1', replacements: {} }
  }
  return {
    sql: `(${alias}.owner_id = :viewerId OR EXISTS (
      SELECT 1
      FROM customer_identities ci
      JOIN conversations cv
        ON cv.channel = ci.channel
       AND cv.account_id <=> ci.account_id
       AND cv.user_id = ci.external_user_id
      WHERE ci.customer_id = ${alias}.id
        AND (cv.claimed_by = :viewerId OR cv.agent_id = :viewerId)
    ))`,
    replacements: { viewerId: Number(currentUserId(req)) }
  }
}

function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeReportDate(value) {
  const date = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return date
}

async function buildDailyReport(req) {
  const reportDate = normalizeReportDate(req.query.date) || localDateKey(new Date())
  const visibility = customerVisibility(req, 'c')
  const conditions = ['d.communication_date = :reportDate', visibility.sql]
  const replacements = { reportDate, ...visibility.replacements }
  if (['admin', 'supervisor'].includes(req.user?.role) && req.query.owner_id) {
    conditions.push('d.owner_id = :ownerId')
    replacements.ownerId = Number(req.query.owner_id)
  }

  const conversationAccess = ['admin', 'supervisor'].includes(req.user?.role)
    ? '1=1'
    : '(cv.claimed_by = :viewerId OR cv.agent_id = :viewerId)'

  const [detailRows] = await sequelize.query(
    `SELECT c.id, c.phone, c.display_name, c.owner_id, c.won_status,
            d.communication_date, d.communication_index, d.stage_label, d.message_count,
            d.summary, DATE_FORMAT(d.last_message_at, '%Y-%m-%d %H:%i:%s') AS lastMessageAt,
            (SELECT MIN(f.due_at) FROM customer_followups f
             WHERE f.customer_id = c.id AND f.status IN ('pending', 'due')) AS nextFollowupAt,
            (SELECT cv.id FROM customer_identities ci
             JOIN conversations cv ON cv.channel = ci.channel
              AND cv.account_id <=> ci.account_id
              AND cv.user_id = ci.external_user_id
             WHERE ci.customer_id = c.id AND ${conversationAccess}
             ORDER BY cv.last_message_time DESC, cv.id ASC LIMIT 1) AS primaryConversationId,
            (SELECT cv.channel FROM customer_identities ci
             JOIN conversations cv ON cv.channel = ci.channel
              AND cv.account_id <=> ci.account_id
              AND cv.user_id = ci.external_user_id
             WHERE ci.customer_id = c.id AND ${conversationAccess}
             ORDER BY cv.last_message_time DESC, cv.id ASC LIMIT 1) AS channel,
            (SELECT cv.account_id FROM customer_identities ci
             JOIN conversations cv ON cv.channel = ci.channel
              AND cv.account_id <=> ci.account_id
              AND cv.user_id = ci.external_user_id
             WHERE ci.customer_id = c.id AND ${conversationAccess}
             ORDER BY cv.last_message_time DESC, cv.id ASC LIMIT 1) AS accountId,
            (SELECT CASE WHEN cv.claimed_by IS NOT NULL OR cv.agent_id IS NOT NULL THEN 'claimed'
                         WHEN cv.pool_type IS NULL THEN 'unbound' ELSE cv.pool_type END
             FROM customer_identities ci
             JOIN conversations cv ON cv.channel = ci.channel
              AND cv.account_id <=> ci.account_id
              AND cv.user_id = ci.external_user_id
             WHERE ci.customer_id = c.id AND ${conversationAccess}
             ORDER BY cv.last_message_time DESC, cv.id ASC LIMIT 1) AS bindingStatus
     FROM customer_communication_days d
     JOIN customers c ON c.id = d.customer_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY d.last_message_at DESC, c.id ASC`,
    { replacements }
  )

  const total = detailRows.length
  const firstCount = detailRows.filter(row => row.stage_label === 'first').length
  const secondCount = detailRows.filter(row => row.stage_label === 'second').length
  const thirdCount = detailRows.filter(row => row.stage_label === 'third').length
  const wonCount = detailRows.filter(row => row.won_status === 'won').length
  const dueCount = detailRows.filter(row => row.nextFollowupAt && new Date(row.nextFollowupAt) <= new Date()).length
  const overdueCount = detailRows.filter(row => row.nextFollowupAt && new Date(row.nextFollowupAt) < new Date(`${reportDate} 00:00:00`)).length
  const summary = `当天共有 ${total} 位客户沟通，其中首次 ${firstCount} 位、二次 ${secondCount} 位、三次 ${thirdCount} 位，成交 ${wonCount} 位，待复联 ${dueCount} 位。`

  return {
    report: {
      reportDate,
      customerCount: total,
      firstCount,
      secondCount,
      thirdCount,
      wonCount,
      dueCount,
      overdueCount,
      summary,
      generatedAt: new Date().toISOString(),
      source: 'deterministic'
    },
    customers: detailRows.map(row => ({
      id: row.id,
      phone: row.phone,
      displayName: row.display_name || '',
      ownerId: row.owner_id,
      wonStatus: row.won_status || 'unknown',
      communicationDate: row.communication_date,
      communicationIndex: Number(row.communication_index || 1),
      stageLabel: row.stage_label,
      messageCount: Number(row.message_count || 0),
      summary: row.summary || 'AI 摘要生成中',
      lastMessageAt: row.lastMessageAt,
      nextFollowupAt: row.nextFollowupAt,
      primaryConversationId: row.primaryConversationId || null,
      channel: row.channel || null,
      accountId: row.accountId ?? null,
      bindingStatus: row.bindingStatus || 'unbound',
      actionFlags: {
        canOpenConversation: Boolean(row.primaryConversationId),
        hasDueFollowup: Boolean(row.nextFollowupAt && new Date(row.nextFollowupAt) <= new Date()),
        canMarkWon: row.won_status !== 'won'
      }
    }))
  }
}

function reportScope(req) {
  if (req.user?.role === 'agent') return { scopeType: 'agent', scopeId: Number(currentUserId(req)) }
  if (req.query.owner_id) return { scopeType: 'owner', scopeId: Number(req.query.owner_id) }
  return { scopeType: 'global', scopeId: null }
}

function parseReportSnapshot(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

async function readDailyReportRevision(req, reportDate) {
  const scope = reportScope(req)
  const [rows] = await sequelize.query(
    `SELECT id, revision, status, snapshot,
            DATE_FORMAT(generated_at, '%Y-%m-%d %H:%i:%s') AS generatedAt
     FROM customer_daily_report_revisions
     WHERE report_date = :reportDate AND scope_type = :scopeType
       AND ((scope_id IS NULL AND :scopeId IS NULL) OR scope_id = :scopeId)
     ORDER BY revision DESC LIMIT 1`,
    { replacements: { reportDate, ...scope } }
  )
  const row = rows[0]
  if (!row) return null
  const snapshot = parseReportSnapshot(row.snapshot)
  if (!snapshot) return null

  // Re-apply current visibility to historical snapshots so owner changes cannot leak data.
  const ids = Array.isArray(snapshot.customers) ? snapshot.customers.map(item => item.id).filter(Boolean) : []
  if (ids.length && req.user?.role === 'agent') {
    const visibility = customerVisibility(req, 'c')
    const [visibleRows] = await sequelize.query(
      `SELECT c.id FROM customers c WHERE c.id IN (:customerIds) AND ${visibility.sql}`,
      { replacements: { customerIds: ids, ...visibility.replacements } }
    )
    const visible = new Set(visibleRows.map(item => String(item.id)))
    snapshot.customers = snapshot.customers.filter(item => visible.has(String(item.id)))
    if (snapshot.report) snapshot.report.customerCount = snapshot.customers.length
  }
  return {
    ...snapshot,
    report: { ...(snapshot.report || {}), revision: Number(row.revision), generatedAt: row.generatedAt || snapshot.report?.generatedAt, source: 'snapshot', status: row.status || 'current' },
    revision: Number(row.revision),
    generatedAt: row.generatedAt || null,
    status: row.status || 'current'
  }
}

async function persistDailyReportRevision(req, data) {
  const reportDate = data.report?.reportDate
  if (!reportDate) return data
  const scope = reportScope(req)
  const [rows] = await sequelize.query(
    `SELECT COALESCE(MAX(revision), 0) AS revision
     FROM customer_daily_report_revisions
     WHERE report_date = :reportDate AND scope_type = :scopeType
       AND ((scope_id IS NULL AND :scopeId IS NULL) OR scope_id = :scopeId)`,
    { replacements: { reportDate, ...scope } }
  )
  const revision = Number(rows[0]?.revision || 0) + 1
  const generatedAt = new Date().toISOString()
  const snapshot = JSON.stringify({ ...data, revision, generatedAt, status: 'current' })
  await sequelize.query(
    `INSERT INTO customer_daily_report_revisions
      (id, report_date, scope_type, scope_id, revision, status, snapshot, generated_by, generated_at)
     VALUES (:id, :reportDate, :scopeType, :scopeId, :revision, 'current', :snapshot, :generatedBy, NOW())`,
    { replacements: { id: crypto.randomUUID(), reportDate, ...scope, revision, snapshot, generatedBy: currentUserId(req) } }
  )
  return { ...data, revision, generatedAt, status: 'current', report: { ...data.report, revision, generatedAt, status: 'current' } }
}

async function updateFollowupStatus(req, status) {
  const visibility = customerVisibility(req, 'c')
  const [tasks] = await sequelize.query(
    `SELECT f.id, f.customer_id AS customerId, f.conversation_id AS conversationId,
            f.order_id AS orderId, f.type, f.assigned_to AS assignedTo
     FROM customer_followups f
     JOIN customers c ON c.id = f.customer_id
     WHERE f.id = :followupId AND f.customer_id = :customerId AND ${visibility.sql}`,
    {
      replacements: {
        followupId: req.params.followupId,
        customerId: req.params.id,
        ...visibility.replacements
      }
    }
  )
  if (!tasks.length) return null

  const [result, metadata] = await sequelize.query(
    `UPDATE customer_followups f
     JOIN customers c ON c.id = f.customer_id
     SET f.status = :status,
         f.completed_at = CASE WHEN :status = 'completed' THEN NOW() ELSE f.completed_at END,
         f.updated_at = NOW()
     WHERE f.id = :followupId AND f.customer_id = :customerId AND ${visibility.sql}`,
    {
      replacements: {
        status,
        followupId: req.params.followupId,
        customerId: req.params.id,
        ...visibility.replacements
      }
    }
  )
  return (result?.affectedRows ?? metadata?.affectedRows ?? 0) ? tasks[0] : null
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

function normalizeCustomerPayload(body = {}) {
  const phone = String(body.phone || '').trim()
  const displayName = emptyToNull(body.displayName || body.display_name)
  const contactTime = emptyToNull(body.contactTime || body.contact_time)
  const notes = emptyToNull(body.notes)

  if (!phone) return { error: '手机号不能为空' }
  if (phone.length > 60) return { error: '手机号不能超过60个字符' }
  if (notes && String(notes).length > 5000) return { error: '备注不能超过5000个字符' }

  return { data: { phone, displayName, contactTime, notes } }
}

function toPublicCustomer(row) {
  return {
    id: row.id,
    phone: row.phone,
    displayName: row.display_name || row.displayName || '',
    contactTime: row.contactTime || row.contact_time,
    notes: row.notes || '',
    ownerId: row.owner_id ?? null,
    wonStatus: row.won_status || 'unknown',
    wonAt: row.wonAt || row.won_at || null,
    communicationDays: Number(row.communicationDays || row.communication_days || 0),
    lastCommunicationDate: row.lastCommunicationDate || row.last_communication_date || null,
    currentStage: row.currentStage || row.current_stage || null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at
  }
}

router.use(createAuthenticate())

router.get('/', async (req, res) => {
  try {
    const {
      keyword = '',
      start_date,
      end_date,
      limit = 50,
      offset = 0
    } = req.query

    const replacements = {
      limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
      offset: Math.max(parseInt(offset, 10) || 0, 0)
    }
    const conditions = []
    const visibility = customerVisibility(req, 'c')
    conditions.push(visibility.sql)
    Object.assign(replacements, visibility.replacements)

    if (keyword) {
      conditions.push('(c.phone LIKE :keyword OR c.notes LIKE :keyword OR c.display_name LIKE :keyword)')
      replacements.keyword = `%${String(keyword).trim()}%`
    }
    if (start_date) {
      conditions.push('c.contact_time >= :startDate')
      replacements.startDate = start_date
    }
    if (end_date) {
      conditions.push('c.contact_time <= :endDate')
      replacements.endDate = String(end_date).length <= 10 ? `${end_date} 23:59:59` : end_date
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await sequelize.query(
      `SELECT c.id,
              phone,
              display_name,
              DATE_FORMAT(contact_time, '%Y-%m-%d %H:%i:%s') AS contactTime,
              notes,
              owner_id,
              won_status,
              DATE_FORMAT(won_at, '%Y-%m-%d %H:%i:%s') AS wonAt,
              COUNT(DISTINCT ccd.communication_date) AS communicationDays,
              MAX(ccd.communication_date) AS lastCommunicationDate,
              SUBSTRING_INDEX(GROUP_CONCAT(ccd.stage_label ORDER BY ccd.communication_date DESC), ',', 1) AS currentStage,
              created_by,
              updated_by,
              DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
              DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt
       FROM customers c
       LEFT JOIN customer_communication_days ccd ON ccd.customer_id = c.id
       ${whereSql}
       GROUP BY c.id
       ORDER BY COALESCE(c.contact_time, c.created_at) DESC, c.created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM customers c ${whereSql}`,
      { replacements }
    )

    res.json({
      success: true,
      data: {
        list: rows.map(toPublicCustomer),
        total: Number(countRows[0]?.total || 0),
        limit: replacements.limit,
        offset: replacements.offset
      }
    })
  } catch (err) {
    console.error('[Customers] list failed:', err)
    res.status(500).json({ success: false, message: '查询客户失败: ' + err.message })
  }
})

router.get('/:id/profile', async (req, res) => {
  try {
    const { id } = req.params
    const visibility = customerVisibility(req, 'c')

    const [customerRows] = await sequelize.query(
      `SELECT c.id, c.phone, c.display_name, DATE_FORMAT(c.contact_time, '%Y-%m-%d %H:%i:%s') AS contactTime,
              c.notes, c.owner_id, c.won_status, DATE_FORMAT(c.won_at, '%Y-%m-%d %H:%i:%s') AS wonAt,
              c.ai_profile, DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM customers c
       WHERE c.id = :id AND ${visibility.sql}`,
      { replacements: { id, ...visibility.replacements } }
    )
    if (!customerRows.length) {
      return res.status(404).json({ success: false, message: '客户不存在' })
    }
    const customer = {
      ...customerRows[0],
      ai_profile: parseJsonField(customerRows[0].ai_profile, null)
    }
    const conversationVisibility = ['admin', 'supervisor'].includes(req.user?.role)
      ? '1=1'
      : '(cv.claimed_by = :viewerId OR cv.agent_id = :viewerId)'

    const [summaryRows, channelDist, statusDist, topProducts, recentOrders] = await Promise.all([
      sequelize.query(
        `SELECT COUNT(*) AS total_orders,
                COALESCE(SUM(deal_amount), 0) AS total_spend,
                COALESCE(SUM(CASE WHEN status = 'after_sales' THEN 1 ELSE 0 END), 0) AS after_sales_count,
                COALESCE(SUM(CASE WHEN status IN ('closed','delivered') THEN deal_amount ELSE 0 END), 0) AS completed_amount
         FROM orders WHERE customer_id = :customerId`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT channel, COUNT(*) AS order_count, COALESCE(SUM(deal_amount), 0) AS total_amount
         FROM orders WHERE customer_id = :customerId
         GROUP BY channel ORDER BY order_count DESC`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT status, COUNT(*) AS cnt
         FROM orders WHERE customer_id = :customerId
         GROUP BY status ORDER BY cnt DESC`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT oi.product_name, COUNT(*) AS purchase_count,
                COALESCE(SUM(oi.total_amount), 0) AS total_amount
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.customer_id = :customerId
         GROUP BY oi.product_name ORDER BY purchase_count DESC LIMIT 10`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT id, order_no, channel, status, deal_amount, currency,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM orders WHERE customer_id = :customerId
         ORDER BY created_at DESC LIMIT 20`,
        { replacements: { customerId: id } }
      )
    ])

    const [communicationDays, followups, conversationRows] = await Promise.all([
      sequelize.query(
        `SELECT communication_date, communication_index, stage_label, message_count,
                DATE_FORMAT(first_message_at, '%Y-%m-%d %H:%i:%s') AS firstMessageAt,
                DATE_FORMAT(last_message_at, '%Y-%m-%d %H:%i:%s') AS lastMessageAt,
                summary, owner_id
         FROM customer_communication_days
         WHERE customer_id = :customerId
         ORDER BY communication_date DESC
         LIMIT 90`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT id, type, status, DATE_FORMAT(due_at, '%Y-%m-%d %H:%i:%s') AS dueAt,
                DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completedAt,
                assigned_to, source, ai_reason AS aiReason, ai_confidence AS aiConfidence,
                ai_signals AS aiSignals, overridden_by AS overriddenBy, override_reason AS overrideReason
         FROM customer_followups
         WHERE customer_id = :customerId
         ORDER BY due_at ASC, created_at DESC`,
        { replacements: { customerId: id } }
      ),
      sequelize.query(
        `SELECT DISTINCT cv.id, cv.channel, cv.account_id, cv.user_id, cv.user_name,
                cv.claimed_by, cv.agent_id, cv.pool_type, cv.conv_status,
                cv.last_message, DATE_FORMAT(cv.last_message_time, '%Y-%m-%d %H:%i:%s') AS lastMessageTime
         FROM customer_identities ci
         JOIN conversations cv
           ON cv.channel = ci.channel
          AND cv.account_id <=> ci.account_id
          AND cv.user_id = ci.external_user_id
         WHERE ci.customer_id = :customerId
           AND ${conversationVisibility}
         ORDER BY cv.last_message_time DESC`,
        { replacements: { customerId: id, ...visibility.replacements } }
      )
    ])

    res.json({
      success: true,
      data: {
        customer,
        summary: {
          totalOrders: Number(summaryRows[0]?.[0]?.total_orders || 0),
          totalSpend: Number(summaryRows[0]?.[0]?.total_spend || 0),
          afterSalesCount: Number(summaryRows[0]?.[0]?.after_sales_count || 0),
          completedAmount: Number(summaryRows[0]?.[0]?.completed_amount || 0)
        },
        channelDistribution: channelDist[0],
        statusDistribution: statusDist[0],
        topProducts: topProducts[0],
        recentOrders: recentOrders[0],
        communicationDays: communicationDays[0].map(row => ({
          ...row,
          message_count: Number(row.message_count || 0)
        })),
        followups: followups[0].map(row => ({
          ...row,
          aiSignals: parseJsonField(row.aiSignals, []),
          aiConfidence: row.aiConfidence === null ? null : Number(row.aiConfidence)
        })),
        conversations: conversationRows[0],
        aiProfile: customer.ai_profile || null
      }
    })
  } catch (err) {
    console.error('[Customers] profile failed:', err)
    res.status(500).json({ success: false, message: '查询客户画像失败: ' + err.message })
  }
})

router.get('/daily-report', async (req, res) => {
  try {
    const reportDate = normalizeReportDate(req.query.date) || localDateKey(new Date())
    const today = localDateKey(new Date())
    const data = reportDate < today
      ? (await readDailyReportRevision(req, reportDate)) || await buildDailyReport(req)
      : await buildDailyReport(req)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[Customers] daily report failed:', err)
    res.status(500).json({ success: false, message: '获取客户日报失败: ' + err.message })
  }
})

router.post('/daily-report/regenerate', async (req, res) => {
  try {
    const scopedReq = { ...req, query: { ...req.query, ...req.body } }
    const data = await persistDailyReportRevision(scopedReq, await buildDailyReport(scopedReq))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[Customers] daily report regenerate failed:', err)
    res.status(500).json({ success: false, message: '重新生成客户日报失败: ' + err.message })
  }
})

router.post('/:id/won', async (req, res) => {
  try {
    const id = req.params.id
    const visibility = customerVisibility(req, 'c')
    const [rows] = await sequelize.query(
      `SELECT c.id, c.phone, c.display_name
       FROM customers c
       WHERE c.id = :id AND ${visibility.sql}`,
      { replacements: { id, ...visibility.replacements } }
    )
    if (!rows.length) return res.status(404).json({ success: false, message: '客户不存在或无权访问' })

    await sequelize.query(
      `UPDATE customers
       SET won_status = 'won', won_at = COALESCE(won_at, NOW()), updated_by = :updatedBy, updated_at = NOW()
       WHERE id = :id`,
      { replacements: { id, updatedBy: currentUserId(req) } }
    )
    await customerOperationsRepository.createWonFollowupIfMissing({
      customerId: id,
      orderId: `manual-${id}`,
      type: 'won_first',
      assignedTo: currentUserId(req),
      dueAt: new Date(Date.now() + 10 * 86400000),
      source: 'manual',
      aiReason: '坐席手动标记成交，等待 AI 重新评估复联时间',
      aiSignals: []
    })
    res.json({ success: true, message: '客户已标记为成交' })
  } catch (err) {
    console.error('[Customers] mark won failed:', err)
    res.status(500).json({ success: false, message: '标记成交失败: ' + err.message })
  }
})

router.post('/:id/followups/:followupId/complete', async (req, res) => {
  try {
    const completedTask = await updateFollowupStatus(req, 'completed')
    if (!completedTask) return res.status(404).json({ success: false, message: '跟进任务不存在或无权访问' })
    const nextFollowup = buildNextFollowup(completedTask)
    if (nextFollowup) {
      await customerOperationsRepository.createWonFollowupIfMissing(nextFollowup)
    }
    res.json({ success: true, message: '跟进任务已完成' })
  } catch (err) {
    console.error('[Customers] complete follow-up failed:', err)
    res.status(500).json({ success: false, message: '完成跟进任务失败: ' + err.message })
  }
})

router.post('/:id/followups/:followupId/skip', async (req, res) => {
  try {
    const changed = await updateFollowupStatus(req, 'skipped')
    if (!changed) return res.status(404).json({ success: false, message: '跟进任务不存在或无权访问' })
    res.json({ success: true, message: '跟进任务已跳过' })
  } catch (err) {
    console.error('[Customers] skip follow-up failed:', err)
    res.status(500).json({ success: false, message: '跳过跟进任务失败: ' + err.message })
  }
})

router.patch('/:id/followups/:followupId', async (req, res) => {
  try {
    const dueAt = emptyToNull(req.body.dueAt || req.body.due_at)
    if (!dueAt || Number.isNaN(new Date(dueAt).getTime())) {
      return res.status(400).json({ success: false, message: '请提供有效的提醒时间' })
    }
    const visibility = customerVisibility(req, 'c')
    const [result, metadata] = await sequelize.query(
      `UPDATE customer_followups f
       JOIN customers c ON c.id = f.customer_id
       SET f.due_at = :dueAt, f.overridden_by = :overriddenBy,
           f.override_reason = :overrideReason, f.source = 'manual', f.updated_at = NOW()
       WHERE f.id = :followupId AND f.customer_id = :customerId AND ${visibility.sql}`,
      {
        replacements: {
          followupId: req.params.followupId,
          customerId: req.params.id,
          dueAt,
          overriddenBy: currentUserId(req),
          overrideReason: emptyToNull(req.body.reason) || '人工调整复联时间',
          ...visibility.replacements
        }
      }
    )
    const affectedRows = result?.affectedRows ?? metadata?.affectedRows ?? 0
    if (!affectedRows) return res.status(404).json({ success: false, message: '跟进任务不存在或无权访问' })
    res.json({ success: true, message: '跟进时间已更新' })
  } catch (err) {
    console.error('[Customers] update follow-up failed:', err)
    res.status(500).json({ success: false, message: '更新跟进时间失败: ' + err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const normalized = normalizeCustomerPayload(req.body)
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error })
    }

    const id = crypto.randomUUID()
    const userId = currentUserId(req)
    await sequelize.query(
      `INSERT INTO customers
        (id, phone, display_name, contact_time, notes, owner_id, created_by, updated_by, created_at, updated_at)
       VALUES
        (:id, :phone, :displayName, :contactTime, :notes, :ownerId, :createdBy, :updatedBy, NOW(), NOW())`,
      {
        replacements: {
          id,
          ...normalized.data,
          ownerId: userId,
          createdBy: userId,
          updatedBy: userId
        }
      }
    )

    res.status(201).json({ success: true, message: '客户已创建', data: { id, ...normalized.data } })
  } catch (err) {
    console.error('[Customers] create failed:', err)
    res.status(500).json({ success: false, message: '创建客户失败: ' + err.message })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const normalized = normalizeCustomerPayload(req.body)
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error })
    }

    const visibility = customerVisibility(req, 'c')
    const [result, metadata] = await sequelize.query(
      `UPDATE customers c
       SET phone = :phone,
           display_name = :displayName,
           contact_time = :contactTime,
           notes = :notes,
           updated_by = :updatedBy,
           updated_at = NOW()
       WHERE c.id = :id AND ${visibility.sql}`,
      {
        replacements: {
          id: req.params.id,
          ...normalized.data,
          updatedBy: currentUserId(req),
          ...visibility.replacements
        }
      }
    )

    const affectedRows = result?.affectedRows ?? metadata?.affectedRows ?? 0
    if (affectedRows === 0) {
      return res.status(404).json({ success: false, message: '客户不存在' })
    }

    res.json({ success: true, message: '客户已更新' })
  } catch (err) {
    console.error('[Customers] update failed:', err)
    res.status(500).json({ success: false, message: '更新客户失败: ' + err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const visibility = customerVisibility(req, 'c')
    const [linkedRows] = await sequelize.query(
      `SELECT c.phone,
              (SELECT COUNT(*) FROM customer_identities ci WHERE ci.customer_id = c.id) AS identity_count,
              (SELECT COUNT(*) FROM customer_communication_days cd WHERE cd.customer_id = c.id) AS communication_count,
              (SELECT COUNT(*) FROM customer_followups f WHERE f.customer_id = c.id) AS followup_count,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count
       FROM customers c
       WHERE c.id = :id AND ${visibility.sql}`,
      { replacements: { id: req.params.id, ...visibility.replacements } }
    )
    if (!linkedRows.length) return res.status(404).json({ success: false, message: '客户不存在或无权访问' })
    const linked = linkedRows[0]
    if ([linked.identity_count, linked.communication_count, linked.followup_count, linked.order_count].some(value => Number(value) > 0)) {
      return res.status(409).json({ success: false, message: '客户已有会话、订单或跟进历史，不能删除' })
    }
    const [result, metadata] = await sequelize.query(
      `DELETE c FROM customers c
       WHERE c.id = :id AND ${visibility.sql}`,
      { replacements: { id: req.params.id, ...visibility.replacements } }
    )
    const affectedRows = result?.affectedRows ?? metadata?.affectedRows ?? 0
    if (affectedRows === 0) {
      return res.status(404).json({ success: false, message: '客户不存在' })
    }
    res.json({ success: true, message: '客户已删除' })
  } catch (err) {
    console.error('[Customers] delete failed:', err)
    res.status(500).json({ success: false, message: '删除客户失败: ' + err.message })
  }
})

module.exports = router
