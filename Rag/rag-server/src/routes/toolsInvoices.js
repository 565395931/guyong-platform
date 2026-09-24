const express = require('express')
const jwt = require('jsonwebtoken')
const { randomUUID } = require('crypto')
const { sequelize } = require('../config/database')
const {
  buildInvoiceDataFromOrder,
  generateInvoiceFiles,
  normalizeInvoiceData
} = require('../services/invoiceService')

const router = express.Router()
const EFFECTIVE_JWT_SECRET = process.env.JWT_SECRET || 'rag_secret_key_2024_dev_only'

router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    if (!['agent', 'supervisor', 'admin'].includes(decoded.role)) {
      return res.status(403).json({ success: false, message: '无权使用发票工具' })
    }
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

function currentUserId(req) {
  return req.user.id || req.user.userId
}

function isDomesticOrder(order) {
  const raw = order?.raw_payload
  if (!raw) return false
  if (typeof raw === 'object') return raw.order_scope === 'domestic'
  try {
    return JSON.parse(raw).order_scope === 'domestic'
  } catch {
    return false
  }
}

async function findAccessibleOrder(orderIdentifier, req) {
  const conditions = ['(id = :orderIdentifier OR order_no = :orderIdentifier)']
  const replacements = { orderIdentifier }
  if (req.user.role === 'agent') {
    conditions.push(`(
      owner_seat_id = :viewerId
      OR created_by = :viewerId
      OR (owner_seat_id IS NULL AND created_by IS NULL)
    )`)
    replacements.viewerId = currentUserId(req)
  }
  const [rows] = await sequelize.query(
    `SELECT id, order_no, raw_payload FROM orders WHERE ${conditions.join(' AND ')} LIMIT 1`,
    { replacements }
  )
  return rows[0] || null
}

async function insertOrderEvent(orderId, event, req, transaction) {
  await sequelize.query(
    `INSERT INTO order_events
      (id, order_id, event_type, title, description, operator_id, operator_name, payload, created_at)
     VALUES
      (:id, :orderId, :eventType, :title, :description, :operatorId, :operatorName, :payload, NOW())`,
    {
      replacements: {
        id: randomUUID(),
        orderId,
        eventType: event.eventType,
        title: event.title,
        description: event.description || null,
        operatorId: currentUserId(req),
        operatorName: req.user.username || null,
        payload: JSON.stringify(event.payload || null)
      },
      transaction
    }
  )
}

router.get('/', async (req, res) => {
  try {
    const { order_id, limit = 50, offset = 0 } = req.query
    const conditions = []
    const replacements = {
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0
    }
    if (order_id) {
      conditions.push('inv.order_id = :orderId')
      replacements.orderId = order_id
    }
    if (req.user.role === 'agent') {
      conditions.push(`(
        inv.generated_by = :viewerId
        OR EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = inv.order_id AND (o.owner_seat_id = :viewerId OR o.created_by = :viewerId)
        )
      )`)
      replacements.viewerId = currentUserId(req)
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await sequelize.query(
      `SELECT inv.*, o.order_no, o.customer_name
       FROM order_invoices inv
       LEFT JOIN orders o ON inv.order_id = o.id
       ${whereSql}
       ORDER BY inv.created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total
       FROM order_invoices inv
       LEFT JOIN orders o ON inv.order_id = o.id
       ${whereSql}`,
      { replacements }
    )
    res.json({
      success: true,
      data: {
        list: rows,
        total: countRows[0]?.total || 0,
        limit: replacements.limit,
        offset: replacements.offset
      }
    })
  } catch (err) {
    console.error('[InvoiceTool] list failed:', err)
    res.status(500).json({ success: false, message: '查询发票失败: ' + err.message })
  }
})

router.post('/generate', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const orderIdentifier = req.body.orderId || req.body.order_id || req.body.orderNo || req.body.order_no || null
    let orderId = null
    if (orderIdentifier) {
      const order = await findAccessibleOrder(orderIdentifier, req)
      if (!order) {
        await transaction.rollback()
        return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
      }
      if (isDomesticOrder(order)) {
        await transaction.rollback()
        return res.status(400).json({ success: false, message: '国内订单不生成 PI' })
      }
      orderId = order.id
    }

    const invoiceData = orderId
      ? await buildInvoiceDataFromOrder(sequelize, orderId)
      : normalizeInvoiceData(req.body)

    const result = await generateInvoiceFiles({
      sequelize,
      data: invoiceData,
      orderId,
      userId: currentUserId(req),
      transaction
    })

    if (orderId) {
      await insertOrderEvent(orderId, {
        eventType: 'invoice_generated',
        title: '生成 PI 发票',
        payload: {
          invoiceId: result.id,
          invoiceNo: result.invoiceNo,
          publicUrl: result.publicUrl
        }
      }, req, transaction)
    }

    await transaction.commit()
    res.status(201).json({ success: true, message: 'PI 发票已生成', data: result })
  } catch (err) {
    await transaction.rollback()
    console.error('[InvoiceTool] generate failed:', err)
    res.status(err.status || 500).json({ success: false, message: '生成发票失败: ' + err.message })
  }
})

module.exports = router
