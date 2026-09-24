const express = require('express')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const { sequelize } = require('../config/database')
const { extractOrderDraftFromMessages } = require('../services/orderExtractionService')
const { createCustomerOperationsService } = require('../modules/customer-operations/customerOperations.service')
const { createCustomerOperationsEventHooks } = require('../modules/customer-operations/customerOperations.events')
const { createCustomerOperationEventsRepository } = require('../modules/customer-operations/customerOperationEvents.repository')
const { createAuthenticate } = require('../middleware/authenticate')

const router = express.Router()

const customerOperationsHooks = createCustomerOperationsEventHooks({
  service: createCustomerOperationsService(),
  eventsRepository: createCustomerOperationEventsRepository(),
  logger: console
})

const ORDER_STATUS = new Set([
  'draft',
  'confirmed',
  'paid',
  'purchasing',
  'domestic_shipping',
  'international_shipping',
  'delivered',
  'after_sales',
  'closed',
  'cancelled'
])

const PAYMENT_STATUS = new Set(['unpaid', 'partial', 'paid', 'refunded'])
const ORDER_OPTION_TYPES = new Set(['payment_platform', 'domestic_platform', 'courier', 'country', 'city'])
const ORDER_ATTACHMENT_DIR = path.join(__dirname, '..', 'public', 'order-attachments')
const ORDER_ATTACHMENT_PUBLIC_PREFIX = '/api/order-attachments/static'

if (!fs.existsSync(ORDER_ATTACHMENT_DIR)) {
  fs.mkdirSync(ORDER_ATTACHMENT_DIR, { recursive: true })
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ORDER_ATTACHMENT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '')
      cb(null, `${Date.now()}-${randomUUID()}${ext}`)
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
})

router.use(createAuthenticate())

function currentUserId(req) {
  return req.user.id || req.user.userId
}

async function resolveCustomerId({ customerId, channel, accountId, channelUserId }, transaction) {
  if (customerId) {
    const [rows] = await sequelize.query(
      'SELECT id FROM customers WHERE id = :customerId LIMIT 1',
      { replacements: { customerId }, transaction }
    )
    return rows[0]?.id || null
  }
  if (!channel || !channelUserId) return null
  const [rows] = await sequelize.query(
    `SELECT customer_id AS customerId
     FROM customer_identities
     WHERE channel = :channel
       AND normalized_account_key = :normalizedAccountKey
       AND external_user_id = :channelUserId
     LIMIT 1`,
    {
      replacements: {
        channel,
        normalizedAccountKey: accountId == null ? '__none__' : String(accountId),
        channelUserId
      },
      transaction
    }
  )
  return rows[0]?.customerId || null
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

function numberOrNull(value) {
  const normalized = emptyToNull(value)
  if (normalized === null) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function dateOrNull(value) {
  return emptyToNull(value)
}

function jsonOrNull(value) {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function onlyDigits(value) {
  return value ? String(value).replace(/\D/g, '') : ''
}

function extractPhoneFromUserId(userId, fallbackDisplay) {
  if (!userId || typeof userId !== 'string') return null
  const match = userId.match(/^(\d+)@c\.us$/)
  const digits = match ? match[1] : (/^\d{6,}$/.test(userId) ? userId : '')
  if (!digits) return null
  if (fallbackDisplay && onlyDigits(fallbackDisplay) === digits) return fallbackDisplay
  return digits
}

function makeOrderNo() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `SO${stamp}${randomUUID().slice(0, 4).toUpperCase()}`
}

function normalizeItems(items = [], currency = 'USD') {
  if (!Array.isArray(items)) return []
  return items
    .map((item, index) => {
      const productName = emptyToNull(item.productName || item.product_name || item.description)
      if (!productName) return null
      const quantity = numberOrNull(item.quantity || item.qty) || 1
      const unitPrice = numberOrNull(item.unitPrice || item.unit_price || item.unit_value)
      return {
        id: item.id || randomUUID(),
        externalSku: emptyToNull(item.externalSku || item.external_sku || item.platformSku || item.platform_sku),
        skuCode: emptyToNull(item.skuCode || item.sku_code),
        productName,
        specification: emptyToNull(item.specification),
        description: emptyToNull(item.description || productName),
        quantity,
        unitPrice,
        currency: item.currency || currency,
        totalAmount: unitPrice === null ? null : Number((quantity * unitPrice).toFixed(2)),
        sortOrder: Number.isFinite(Number(item.sortOrder ?? item.sort_order)) ? Number(item.sortOrder ?? item.sort_order) : index
      }
    })
    .filter(Boolean)
}

function normalizeShipments(shipments = []) {
  if (!Array.isArray(shipments)) return []
  return shipments.map((shipment) => ({
    id: shipment.id || randomUUID(),
    shipmentType: shipment.shipmentType || shipment.shipment_type || 'international',
    courier: emptyToNull(shipment.courier),
    trackingNo: emptyToNull(shipment.trackingNo || shipment.tracking_no),
    status: shipment.status || 'pending',
    expectedArrivalAt: dateOrNull(shipment.expectedArrivalAt || shipment.expected_arrival_at),
    shippedAt: dateOrNull(shipment.shippedAt || shipment.shipped_at),
    arrivedAt: dateOrNull(shipment.arrivedAt || shipment.arrived_at),
    recipientName: emptyToNull(shipment.recipientName || shipment.recipient_name),
    recipientPhone: emptyToNull(shipment.recipientPhone || shipment.recipient_phone),
    country: emptyToNull(shipment.country),
    city: emptyToNull(shipment.city),
    addressLine1: emptyToNull(shipment.addressLine1 || shipment.address_line1),
    addressDetail: emptyToNull(shipment.addressDetail || shipment.address_detail),
    freightFee: numberOrNull(shipment.freightFee || shipment.freight_fee),
    metadata: shipment.metadata || null
  }))
}

function computeAmounts(body, items) {
  const goodsAmount = numberOrNull(body.goodsAmount ?? body.goods_amount)
    ?? items.reduce((sum, item) => sum + (item.totalAmount || 0), 0)
  const shippingAmount = numberOrNull(body.shippingAmount ?? body.shipping_amount)
  const dealAmount = numberOrNull(body.dealAmount ?? body.deal_amount)
    ?? Number(((goodsAmount || 0) + (shippingAmount || 0)).toFixed(2))
  const costAmount = numberOrNull(body.costAmount ?? body.cost_amount)
  const freightFeeRmb = numberOrNull(body.freightFeeRmb ?? body.freight_fee_rmb)
  const marketingAmount = numberOrNull(body.marketingAmount ?? body.marketing_amount)
    ?? (costAmount === null ? null : Number((dealAmount - costAmount).toFixed(2)))
  return { goodsAmount, shippingAmount, dealAmount, costAmount, freightFeeRmb, marketingAmount }
}

function addOrderVisibility(req, conditions, replacements, alias = 'o') {
  if (req.user.role === 'agent') {
    conditions.push(`(
      ${alias}.owner_seat_id = :viewerId
      OR ${alias}.created_by = :viewerId
      OR EXISTS (
        SELECT 1 FROM customers customer_scope
        WHERE customer_scope.id = ${alias}.customer_id
          AND customer_scope.owner_id = :viewerId
      )
      OR (${alias}.owner_seat_id IS NULL AND ${alias}.created_by IS NULL)
    )`)
    replacements.viewerId = currentUserId(req)
  }
}

async function loadOrderBundle(orderId, req) {
  const conditions = ['o.id = :orderId']
  const replacements = { orderId }
  addOrderVisibility(req, conditions, replacements)

  const [orders] = await sequelize.query(
    `SELECT o.*, c.user_avatar, c.last_message, c.last_message_time
     FROM orders o
     LEFT JOIN conversations c ON o.source_conversation_id = c.id
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    { replacements }
  )
  if (orders.length === 0) return null

  const [items] = await sequelize.query(
    'SELECT * FROM order_items WHERE order_id = :orderId ORDER BY sort_order ASC, created_at ASC',
    { replacements: { orderId } }
  )
  const [shipments] = await sequelize.query(
    'SELECT * FROM order_shipments WHERE order_id = :orderId ORDER BY created_at ASC',
    { replacements: { orderId } }
  )
  const [events] = await sequelize.query(
    'SELECT * FROM order_events WHERE order_id = :orderId ORDER BY created_at DESC LIMIT 50',
    { replacements: { orderId } }
  )
  const [invoices] = await sequelize.query(
    'SELECT * FROM order_invoices WHERE order_id = :orderId ORDER BY created_at DESC',
    { replacements: { orderId } }
  )
  const [attachments] = await sequelize.query(
    'SELECT * FROM order_attachments WHERE order_id = :orderId ORDER BY created_at DESC',
    { replacements: { orderId } }
  )

  return { ...orders[0], items, shipments, events, invoices, attachments }
}

async function insertEvent(orderId, event, req, transaction) {
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
        title: emptyToNull(event.title),
        description: emptyToNull(event.description),
        operatorId: currentUserId(req),
        operatorName: req.user.username || null,
        payload: jsonOrNull(event.payload || null)
      },
      transaction
    }
  )
}

async function replaceItems(orderId, items, transaction) {
  await sequelize.query('DELETE FROM order_items WHERE order_id = :orderId', {
    replacements: { orderId },
    transaction
  })
  for (const item of items) {
    await sequelize.query(
      `INSERT INTO order_items
        (id, order_id, external_sku, sku_code, product_name, specification, description, quantity, unit_price, currency, total_amount, sort_order, created_at, updated_at)
       VALUES
        (:id, :orderId, :externalSku, :skuCode, :productName, :specification, :description, :quantity, :unitPrice, :currency, :totalAmount, :sortOrder, NOW(), NOW())`,
      { replacements: { ...item, orderId }, transaction }
    )
  }
}

async function replaceShipments(orderId, shipments, transaction) {
  await sequelize.query('DELETE FROM order_shipments WHERE order_id = :orderId', {
    replacements: { orderId },
    transaction
  })
  for (const shipment of shipments) {
    await sequelize.query(
      `INSERT INTO order_shipments
        (id, order_id, shipment_type, courier, tracking_no, status, expected_arrival_at, shipped_at, arrived_at,
         recipient_name, recipient_phone, country, city, address_line1, address_detail, freight_fee, metadata, created_at, updated_at)
       VALUES
        (:id, :orderId, :shipmentType, :courier, :trackingNo, :status, :expectedArrivalAt, :shippedAt, :arrivedAt,
         :recipientName, :recipientPhone, :country, :city, :addressLine1, :addressDetail, :freightFee, :metadata, NOW(), NOW())`,
      {
        replacements: {
          ...shipment,
          orderId,
          metadata: jsonOrNull(shipment.metadata)
        },
        transaction
      }
    )
  }
}

function removeStoredFile(storagePath) {
  if (!storagePath) return
  try {
    const resolved = path.resolve(storagePath)
    const root = path.resolve(ORDER_ATTACHMENT_DIR)
    if (resolved !== root && resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
      fs.unlinkSync(resolved)
    }
  } catch (err) {
    console.warn('[Orders] remove attachment file skipped:', err.message)
  }
}

router.get('/', async (req, res) => {
  try {
    const {
      status,
      payment_status,
      payment_platform,
      domestic_platform,
      courier,
      order_scope,
      owner_seat_id,
      source_conversation_id,
      keyword,
      date_type = 'purchase',
      start_date,
      end_date,
      limit = 50,
      offset = 0
    } = req.query

    const conditions = []
    const replacements = {
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0
    }

    addOrderVisibility(req, conditions, replacements)
    if (order_scope === 'domestic') {
      conditions.push(`(
        JSON_VALID(o.raw_payload)
        AND JSON_UNQUOTE(JSON_EXTRACT(o.raw_payload, '$.order_scope')) = 'domestic'
      )`)
    } else if (order_scope === 'foreign') {
      conditions.push(`(
        o.raw_payload IS NULL
        OR NOT JSON_VALID(o.raw_payload)
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.raw_payload, '$.order_scope')), 'foreign') != 'domestic'
      )`)
    }
    if (status) {
      conditions.push('o.status = :status')
      replacements.status = status
    }
    if (payment_status) {
      conditions.push('o.payment_status = :paymentStatus')
      replacements.paymentStatus = payment_status
    }
    if (payment_platform) {
      conditions.push('o.payment_platform = :paymentPlatform')
      replacements.paymentPlatform = payment_platform
    }
    if (domestic_platform) {
      conditions.push(`(
        JSON_VALID(o.raw_payload)
        AND JSON_UNQUOTE(JSON_EXTRACT(o.raw_payload, '$.domestic_platform')) = :domesticPlatform
      )`)
      replacements.domesticPlatform = domestic_platform
    }
    if (courier) {
      conditions.push(`EXISTS (
        SELECT 1 FROM order_shipments s
        WHERE s.order_id = o.id AND s.courier = :courier
      )`)
      replacements.courier = courier
    }
    if (owner_seat_id) {
      conditions.push('o.owner_seat_id = :ownerSeatId')
      replacements.ownerSeatId = parseInt(owner_seat_id, 10)
    }
    if (source_conversation_id) {
      conditions.push('o.source_conversation_id = :sourceConversationId')
      replacements.sourceConversationId = source_conversation_id
    }
    if (start_date || end_date) {
      const dateType = ['purchase', 'expected_arrival', 'arrival'].includes(date_type) ? date_type : 'purchase'
      if (dateType === 'purchase') {
        if (start_date) {
          conditions.push('COALESCE(o.purchase_time, o.created_at) >= :startDate')
          replacements.startDate = start_date
        }
        if (end_date) {
          conditions.push('COALESCE(o.purchase_time, o.created_at) <= :endDate')
          replacements.endDate = `${end_date} 23:59:59`
        }
      } else {
        const dateColumn = dateType === 'expected_arrival' ? 'expected_arrival_at' : 'arrived_at'
        const dateConditions = []
        if (start_date) {
          dateConditions.push(`s.${dateColumn} >= :startDate`)
          replacements.startDate = start_date
        }
        if (end_date) {
          dateConditions.push(`s.${dateColumn} <= :endDate`)
          replacements.endDate = `${end_date} 23:59:59`
        }
        conditions.push(`EXISTS (
          SELECT 1 FROM order_shipments s
          WHERE s.order_id = o.id AND ${dateConditions.join(' AND ')}
        )`)
      }
    }
    if (keyword) {
      conditions.push(`(
        o.order_no LIKE :keyword
        OR o.customer_name LIKE :keyword
        OR o.customer_phone LIKE :keyword
        OR o.channel_user_id LIKE :keyword
        OR o.payment_platform LIKE :keyword
        OR o.production_batch LIKE :keyword
        OR o.notes LIKE :keyword
        OR EXISTS (
          SELECT 1 FROM order_shipments s
          WHERE s.order_id = o.id
            AND (
              s.tracking_no LIKE :keyword
              OR s.courier LIKE :keyword
              OR s.address_detail LIKE :keyword
            )
        )
        OR EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id
            AND (
              oi.description LIKE :keyword
              OR oi.product_name LIKE :keyword
              OR oi.specification LIKE :keyword
            )
        )
      )`)
      replacements.keyword = `%${keyword}%`
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [rows] = await sequelize.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT COUNT(*) FROM order_invoices inv WHERE inv.order_id = o.id) AS invoice_count,
              (SELECT oi.description FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.sort_order ASC, oi.created_at ASC LIMIT 1) AS purchase_amount,
              (SELECT s.tracking_no FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_type = 'domestic' ORDER BY s.created_at ASC LIMIT 1) AS domestic_tracking,
              (SELECT s.tracking_no FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_type != 'domestic' ORDER BY s.created_at ASC LIMIT 1) AS international_tracking,
              (SELECT s.expected_arrival_at FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_type != 'domestic' ORDER BY s.created_at ASC LIMIT 1) AS expected_arrival,
              (SELECT s.arrived_at FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_type != 'domestic' ORDER BY s.created_at ASC LIMIT 1) AS arrival_time,
              (SELECT s.courier FROM order_shipments s WHERE s.order_id = o.id AND s.courier IS NOT NULL ORDER BY s.created_at ASC LIMIT 1) AS courier,
              (SELECT s.address_detail FROM order_shipments s WHERE s.order_id = o.id AND s.address_detail IS NOT NULL ORDER BY s.created_at ASC LIMIT 1) AS detailed_address,
              (SELECT GROUP_CONCAT(s.tracking_no SEPARATOR ', ') FROM order_shipments s WHERE s.order_id = o.id AND s.tracking_no IS NOT NULL) AS tracking_numbers
       FROM orders o
       ${whereSql}
       ORDER BY COALESCE(o.purchase_time, o.created_at) DESC, o.created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM orders o ${whereSql}`,
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
    console.error('[Orders] list failed:', err)
    res.status(500).json({ success: false, message: '查询订单失败: ' + err.message })
  }
})

router.get('/options', async (req, res) => {
  try {
    const type = req.query.type || ''
    if (type && !ORDER_OPTION_TYPES.has(type)) {
      return res.status(400).json({ success: false, message: '无效选项类型' })
    }
    const replacements = {}
    const whereSql = type ? 'WHERE option_type = :type' : ''
    if (type) replacements.type = type
    const [rows] = await sequelize.query(
      `SELECT id, option_type, option_value, sort_order, created_by, created_at, updated_at
       FROM order_option_values
       ${whereSql}
       ORDER BY option_type ASC, sort_order ASC, created_at ASC`,
      { replacements }
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('[Orders] options list failed:', err)
    res.status(500).json({ success: false, message: '查询订单选项失败: ' + err.message })
  }
})

router.post('/options', async (req, res) => {
  try {
    const type = req.body.type || req.body.option_type
    const value = String(req.body.value || req.body.option_value || '').trim()
    if (!ORDER_OPTION_TYPES.has(type)) {
      return res.status(400).json({ success: false, message: '无效选项类型' })
    }
    if (!value) {
      return res.status(400).json({ success: false, message: '选项不能为空' })
    }

    await sequelize.query(
      `INSERT INTO order_option_values
        (id, option_type, option_value, sort_order, created_by, created_at, updated_at)
       VALUES
        (:id, :type, :value, :sortOrder, :createdBy, NOW(), NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      {
        replacements: {
          id: randomUUID(),
          type,
          value,
          sortOrder: Number.isFinite(Number(req.body.sortOrder || req.body.sort_order))
            ? Number(req.body.sortOrder || req.body.sort_order)
            : 100,
          createdBy: currentUserId(req)
        }
      }
    )

    const [rows] = await sequelize.query(
      `SELECT id, option_type, option_value, sort_order, created_by, created_at, updated_at
       FROM order_option_values
       WHERE option_type = :type AND option_value = :value
       LIMIT 1`,
      { replacements: { type, value } }
    )
    res.status(201).json({ success: true, message: '选项已保存', data: rows[0] })
  } catch (err) {
    console.error('[Orders] option create failed:', err)
    res.status(500).json({ success: false, message: '保存订单选项失败: ' + err.message })
  }
})

router.delete('/options/:id', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      'SELECT id FROM order_option_values WHERE id = :id LIMIT 1',
      { replacements: { id: req.params.id } }
    )
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '选项不存在' })
    }
    await sequelize.query(
      'DELETE FROM order_option_values WHERE id = :id',
      { replacements: { id: req.params.id } }
    )
    res.json({ success: true, message: '选项已删除' })
  } catch (err) {
    console.error('[Orders] option delete failed:', err)
    res.status(500).json({ success: false, message: '删除订单选项失败: ' + err.message })
  }
})

router.post('/from-conversation/:conversationId', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const { conversationId } = req.params
    const viewerId = currentUserId(req)
    const conditions = ['c.id = :conversationId']
    const replacements = { conversationId }

    if (req.user.role === 'agent') {
      conditions.push(`(
        c.claimed_by = :viewerId
        OR c.agent_id = :viewerId
        OR c.account_id IN (
          SELECT account_id FROM seat_account_bindings WHERE seat_id = :viewerId AND status = 'active'
        )
      )`)
      replacements.viewerId = viewerId
    }

    const [conversations] = await sequelize.query(
      `SELECT c.*, u.username AS claimed_by_name
       FROM conversations c
       LEFT JOIN users u ON c.claimed_by = u.id
       WHERE ${conditions.join(' AND ')}
       LIMIT 1`,
      { replacements, transaction }
    )
    if (conversations.length === 0) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '会话不存在或无权访问' })
    }

    const [existing] = await sequelize.query(
      `SELECT id FROM orders
       WHERE source_conversation_id = :conversationId AND status != 'cancelled'
       ORDER BY created_at DESC LIMIT 1`,
      { replacements: { conversationId }, transaction }
    )
    if (existing.length > 0) {
      await transaction.commit()
      const bundle = await loadOrderBundle(existing[0].id, req)
      return res.json({ success: true, message: '该会话已有订单', data: bundle })
    }

    const conv = conversations[0]
    const [recentMessageRows] = await sequelize.query(
      `SELECT direction, sender_type, message_type, content, created_at
       FROM plat_messages
       WHERE conversation_id = :conversationId
       ORDER BY created_at DESC
       LIMIT 20`,
      { replacements: { conversationId }, transaction }
    )
    const recentMessages = recentMessageRows.reverse().map((msg) => {
      let content = msg.content
      try {
        content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content
      } catch {
        content = { text: String(msg.content || '') }
      }
      return {
        direction: msg.direction,
        senderType: msg.sender_type,
        messageType: msg.message_type,
        text: content?.text || content?.translatedText || content?.caption || '',
        translatedText: content?.translatedText || '',
        createdAt: msg.created_at
      }
    })
    const extractedDraft = extractOrderDraftFromMessages({ conversation: conv, recentMessages })
    const extractedItems = normalizeItems(extractedDraft.items || [], req.body.currency || 'USD')
    const extractedShipments = normalizeShipments(extractedDraft.shipments || [])
    const extractedAmounts = computeAmounts(extractedDraft, extractedItems)
    const orderId = randomUUID()
    const orderNo = makeOrderNo()
    const ownerSeatId = conv.claimed_by || conv.agent_id || viewerId
    const ownerName = conv.claimed_by_name || req.user.username || null
    const customerPhone = extractPhoneFromUserId(conv.user_id, conv.user_name)
    const customerId = await resolveCustomerId({
      channel: conv.channel,
      accountId: conv.account_id,
      channelUserId: conv.user_id
    }, transaction)

    await sequelize.query(
      `INSERT INTO orders
        (id, order_no, source_conversation_id, customer_id, channel, account_id, channel_user_id,
         customer_name, customer_phone, customer_email, customer_country, customer_city, customer_address,
         owner_seat_id, owner_name, status, payment_platform, production_batch, currency,
         goods_amount, shipping_amount, deal_amount, cost_amount, freight_fee_rmb, marketing_amount,
         notes, raw_payload, created_by, updated_by, created_at, updated_at)
       VALUES
        (:id, :orderNo, :sourceConversationId, :customerId, :channel, :accountId, :channelUserId,
         :customerName, :customerPhone, :customerEmail, :customerCountry, :customerCity, :customerAddress,
         :ownerSeatId, :ownerName, 'draft', :paymentPlatform, :productionBatch, :currency,
         :goodsAmount, :shippingAmount, :dealAmount, :costAmount, :freightFeeRmb, :marketingAmount,
         :notes, :rawPayload, :createdBy, :updatedBy, NOW(), NOW())`,
      {
        replacements: {
          id: orderId,
          orderNo,
          sourceConversationId: conv.id,
          customerId,
          channel: conv.channel,
          accountId: conv.account_id,
          channelUserId: conv.user_id,
          customerName: extractedDraft.customerName || conv.user_name,
          customerPhone: extractedDraft.customerPhone || customerPhone,
          customerEmail: extractedDraft.customerEmail || null,
          customerCountry: extractedDraft.customerCountry || null,
          customerCity: extractedDraft.customerCity || null,
          customerAddress: extractedDraft.customerAddress || null,
          ownerSeatId,
          ownerName,
          paymentPlatform: extractedDraft.paymentPlatform || null,
          productionBatch: extractedDraft.productionBatch || extractedDraft.production_batch || null,
          currency: req.body.currency || 'USD',
          ...extractedAmounts,
          notes: conv.last_message ? `最近消息：${conv.last_message}` : null,
          rawPayload: jsonOrNull({ conversation: conv, recentMessages, extractedDraft, source: 'conversation' }),
          createdBy: viewerId,
          updatedBy: viewerId
        },
        transaction
      }
    )
    await replaceItems(orderId, extractedItems, transaction)
    await replaceShipments(orderId, extractedShipments, transaction)
    await insertEvent(orderId, {
      eventType: 'created_from_conversation',
      title: '从会话创建成交单',
      payload: { conversationId: conv.id, extractedDraft }
    }, req, transaction)
    await transaction.commit()

    const bundle = await loadOrderBundle(orderId, req)
    res.status(201).json({ success: true, message: '成交单草稿已创建', data: bundle })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] create from conversation failed:', err)
    res.status(500).json({ success: false, message: '从会话创建订单失败: ' + err.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const bundle = await loadOrderBundle(req.params.id, req)
    if (!bundle) {
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }
    res.json({ success: true, data: bundle })
  } catch (err) {
    console.error('[Orders] detail failed:', err)
    res.status(500).json({ success: false, message: '查询订单详情失败: ' + err.message })
  }
})

router.post('/', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const orderId = randomUUID()
    const userId = currentUserId(req)
    const currency = req.body.currency || 'USD'
    const items = normalizeItems(req.body.items, currency)
    const shipments = normalizeShipments(req.body.shipments)
    const amounts = computeAmounts(req.body, items)
    const status = req.body.status || 'draft'
    const paymentStatus = req.body.paymentStatus || req.body.payment_status || 'unpaid'
    const channel = emptyToNull(req.body.channel)
    const accountId = numberOrNull(req.body.accountId || req.body.account_id)
    const channelUserId = emptyToNull(req.body.channelUserId || req.body.channel_user_id)
    const customerId = await resolveCustomerId({
      customerId: req.body.customerId || req.body.customer_id,
      channel,
      accountId,
      channelUserId
    }, transaction)

    if (!ORDER_STATUS.has(status)) {
      await transaction.rollback()
      return res.status(400).json({ success: false, message: '无效订单状态' })
    }
    if (!PAYMENT_STATUS.has(paymentStatus)) {
      await transaction.rollback()
      return res.status(400).json({ success: false, message: '无效付款状态' })
    }

    await sequelize.query(
      `INSERT INTO orders
        (id, order_no, source_conversation_id, customer_id, channel, account_id, channel_user_id,
         customer_name, customer_phone, customer_email, customer_country, customer_city, customer_address,
         owner_seat_id, owner_name, status, payment_status, payment_platform, production_batch, currency,
         goods_amount, shipping_amount, deal_amount, cost_amount, freight_fee_rmb, marketing_amount,
         purchase_time, paid_at, closed_at, notes, raw_payload, created_by, updated_by, created_at, updated_at)
       VALUES
        (:id, :orderNo, :sourceConversationId, :customerId, :channel, :accountId, :channelUserId,
         :customerName, :customerPhone, :customerEmail, :customerCountry, :customerCity, :customerAddress,
         :ownerSeatId, :ownerName, :status, :paymentStatus, :paymentPlatform, :productionBatch, :currency,
         :goodsAmount, :shippingAmount, :dealAmount, :costAmount, :freightFeeRmb, :marketingAmount,
         :purchaseTime, :paidAt, :closedAt, :notes, :rawPayload, :createdBy, :updatedBy, NOW(), NOW())`,
      {
        replacements: {
          id: orderId,
          orderNo: req.body.orderNo || req.body.order_no || makeOrderNo(),
          sourceConversationId: emptyToNull(req.body.sourceConversationId || req.body.source_conversation_id),
          channel,
          accountId,
          channelUserId,
          customerId,
          customerName: emptyToNull(req.body.customerName || req.body.customer_name),
          customerPhone: emptyToNull(req.body.customerPhone || req.body.customer_phone),
          customerEmail: emptyToNull(req.body.customerEmail || req.body.customer_email),
          customerCountry: emptyToNull(req.body.customerCountry || req.body.customer_country),
          customerCity: emptyToNull(req.body.customerCity || req.body.customer_city),
          customerAddress: emptyToNull(req.body.customerAddress || req.body.customer_address),
          ownerSeatId: numberOrNull(req.body.ownerSeatId || req.body.owner_seat_id) || userId,
          ownerName: emptyToNull(req.body.ownerName || req.body.owner_name) || req.user.username || null,
          status,
          paymentStatus,
          paymentPlatform: emptyToNull(req.body.paymentPlatform || req.body.payment_platform),
          productionBatch: emptyToNull(req.body.productionBatch || req.body.production_batch),
          currency,
          ...amounts,
          purchaseTime: dateOrNull(req.body.purchaseTime || req.body.purchase_time),
          paidAt: dateOrNull(req.body.paidAt || req.body.paid_at),
          closedAt: dateOrNull(req.body.closedAt || req.body.closed_at),
          notes: emptyToNull(req.body.notes),
          rawPayload: jsonOrNull(req.body.rawPayload || req.body.raw_payload || null),
          createdBy: userId,
          updatedBy: userId
        },
        transaction
      }
    )
    await replaceItems(orderId, items, transaction)
    await replaceShipments(orderId, shipments, transaction)
    await insertEvent(orderId, { eventType: 'created', title: '创建订单', payload: req.body }, req, transaction)
    await transaction.commit()

    const bundle = await loadOrderBundle(orderId, req)
    res.status(201).json({ success: true, message: '订单已创建', data: bundle })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] create failed:', err)
    res.status(500).json({ success: false, message: '创建订单失败: ' + err.message })
  }
})

router.put('/:id', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const existing = await loadOrderBundle(req.params.id, req)
    if (!existing) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }

    const currency = req.body.currency || existing.currency || 'USD'
    const items = req.body.items ? normalizeItems(req.body.items, currency) : existing.items.map((item) => ({
      id: item.id,
      externalSku: item.external_sku || item.externalSku || null,
      skuCode: item.sku_code || item.skuCode || null,
      productName: item.product_name,
      specification: item.specification,
      description: item.description,
      quantity: Number(item.quantity || 1),
      unitPrice: numberOrNull(item.unit_price),
      currency: item.currency || currency,
      totalAmount: numberOrNull(item.total_amount),
      sortOrder: item.sort_order || 0
    }))
    const shipments = req.body.shipments ? normalizeShipments(req.body.shipments) : null
    const amounts = computeAmounts({ ...existing, ...req.body }, items)
    const status = req.body.status || existing.status
    const paymentStatus = req.body.paymentStatus || req.body.payment_status || existing.payment_status

    if (!ORDER_STATUS.has(status)) {
      await transaction.rollback()
      return res.status(400).json({ success: false, message: '无效订单状态' })
    }
    if (!PAYMENT_STATUS.has(paymentStatus)) {
      await transaction.rollback()
      return res.status(400).json({ success: false, message: '无效付款状态' })
    }

    await sequelize.query(
      `UPDATE orders SET
         channel_user_id = :channelUserId,
         customer_name = :customerName,
         customer_phone = :customerPhone,
         customer_email = :customerEmail,
         customer_country = :customerCountry,
         customer_city = :customerCity,
         customer_address = :customerAddress,
         owner_seat_id = :ownerSeatId,
         owner_name = :ownerName,
         status = :status,
         payment_status = :paymentStatus,
         payment_platform = :paymentPlatform,
         production_batch = :productionBatch,
         currency = :currency,
         goods_amount = :goodsAmount,
         shipping_amount = :shippingAmount,
         deal_amount = :dealAmount,
         cost_amount = :costAmount,
         freight_fee_rmb = :freightFeeRmb,
         marketing_amount = :marketingAmount,
         purchase_time = :purchaseTime,
         paid_at = :paidAt,
         closed_at = :closedAt,
         notes = :notes,
         raw_payload = :rawPayload,
         updated_by = :updatedBy,
         updated_at = NOW()
       WHERE id = :id`,
      {
        replacements: {
          id: req.params.id,
          channelUserId: emptyToNull(req.body.channelUserId ?? req.body.channel_user_id ?? existing.channel_user_id),
          customerName: emptyToNull(req.body.customerName ?? req.body.customer_name ?? existing.customer_name),
          customerPhone: emptyToNull(req.body.customerPhone ?? req.body.customer_phone ?? existing.customer_phone),
          customerEmail: emptyToNull(req.body.customerEmail ?? req.body.customer_email ?? existing.customer_email),
          customerCountry: emptyToNull(req.body.customerCountry ?? req.body.customer_country ?? existing.customer_country),
          customerCity: emptyToNull(req.body.customerCity ?? req.body.customer_city ?? existing.customer_city),
          customerAddress: emptyToNull(req.body.customerAddress ?? req.body.customer_address ?? existing.customer_address),
          ownerSeatId: numberOrNull(req.body.ownerSeatId ?? req.body.owner_seat_id ?? existing.owner_seat_id),
          ownerName: emptyToNull(req.body.ownerName ?? req.body.owner_name ?? existing.owner_name),
          status,
          paymentStatus,
          paymentPlatform: emptyToNull(req.body.paymentPlatform ?? req.body.payment_platform ?? existing.payment_platform),
          productionBatch: emptyToNull(req.body.productionBatch ?? req.body.production_batch ?? existing.production_batch),
          currency,
          ...amounts,
          purchaseTime: dateOrNull(req.body.purchaseTime ?? req.body.purchase_time ?? existing.purchase_time),
          paidAt: dateOrNull(req.body.paidAt ?? req.body.paid_at ?? existing.paid_at),
          closedAt: dateOrNull(req.body.closedAt ?? req.body.closed_at ?? existing.closed_at),
          notes: emptyToNull(req.body.notes ?? existing.notes),
          rawPayload: jsonOrNull(req.body.rawPayload ?? req.body.raw_payload ?? existing.raw_payload ?? null),
          updatedBy: currentUserId(req)
        },
        transaction
      }
    )
    if (req.body.items) await replaceItems(req.params.id, items, transaction)
    if (shipments) await replaceShipments(req.params.id, shipments, transaction)
    await insertEvent(req.params.id, { eventType: 'updated', title: '更新订单', payload: req.body }, req, transaction)
    await transaction.commit()
    void customerOperationsHooks.recordOrderStatus({
      orderId: req.params.id,
      customerId: existing.customer_id || null,
      status,
      channel: req.body.channel || req.body.channel_name || existing.channel,
      accountId: req.body.accountId || req.body.account_id || existing.account_id,
      channelUserId: req.body.channelUserId || req.body.channel_user_id || existing.channel_user_id,
      conversationId: req.body.sourceConversationId || req.body.source_conversation_id || existing.source_conversation_id,
      ownerId: req.body.ownerSeatId || req.body.owner_seat_id || existing.owner_seat_id,
      customer: {
        name: req.body.customerName || req.body.customer_name || existing.customer_name,
        phone: req.body.customerPhone || req.body.customer_phone || existing.customer_phone,
        email: req.body.customerEmail || req.body.customer_email || existing.customer_email
      },
      paidAt: req.body.paidAt || req.body.paid_at || existing.paid_at,
      updatedAt: new Date()
    })

    const bundle = await loadOrderBundle(req.params.id, req)
    res.json({ success: true, message: '订单已更新', data: bundle })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] update failed:', err)
    res.status(500).json({ success: false, message: '更新订单失败: ' + err.message })
  }
})

router.post('/:id/events', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const existing = await loadOrderBundle(req.params.id, req)
    if (!existing) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }
    await insertEvent(req.params.id, {
      eventType: req.body.eventType || req.body.event_type || 'note',
      title: req.body.title || '订单备注',
      description: req.body.description || req.body.content || '',
      payload: req.body.payload || null
    }, req, transaction)
    await transaction.commit()
    const bundle = await loadOrderBundle(req.params.id, req)
    res.json({ success: true, message: '订单事件已追加', data: bundle })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] event append failed:', err)
    res.status(500).json({ success: false, message: '追加订单事件失败: ' + err.message })
  }
})

router.post('/:id/attachments', upload.array('files', 10), async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const existing = await loadOrderBundle(req.params.id, req)
    if (!existing) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }
    const files = req.files || []
    if (files.length === 0) {
      await transaction.rollback()
      return res.status(400).json({ success: false, message: '未上传文件' })
    }

    const rows = []
    for (const file of files) {
      const id = randomUUID()
      const publicUrl = `${ORDER_ATTACHMENT_PUBLIC_PREFIX}/${file.filename}`
      const row = {
        id,
        order_id: req.params.id,
        original_name: file.originalname,
        filename: file.filename,
        mime_type: file.mimetype,
        size: file.size,
        storage_path: file.path,
        public_url: publicUrl,
        attachment_type: req.body.attachmentType || req.body.attachment_type || 'file',
        uploaded_by: currentUserId(req)
      }
      await sequelize.query(
        `INSERT INTO order_attachments
          (id, order_id, original_name, filename, mime_type, size, storage_path, public_url, attachment_type, uploaded_by, created_at)
         VALUES
          (:id, :order_id, :original_name, :filename, :mime_type, :size, :storage_path, :public_url, :attachment_type, :uploaded_by, NOW())`,
        { replacements: row, transaction }
      )
      rows.push(row)
    }

    await insertEvent(req.params.id, {
      eventType: 'attachment_uploaded',
      title: '上传订单附件',
      payload: { count: rows.length, files: rows.map(item => item.original_name) }
    }, req, transaction)

    await transaction.commit()
    res.status(201).json({ success: true, message: '附件已上传', data: rows })
  } catch (err) {
    await transaction.rollback()
    ;(req.files || []).forEach(file => removeStoredFile(file.path))
    console.error('[Orders] attachment upload failed:', err)
    res.status(500).json({ success: false, message: '上传订单附件失败: ' + err.message })
  }
})

router.delete('/:id/attachments/:attachmentId', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const existing = await loadOrderBundle(req.params.id, req)
    if (!existing) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }
    const [rows] = await sequelize.query(
      'SELECT * FROM order_attachments WHERE id = :attachmentId AND order_id = :orderId LIMIT 1',
      { replacements: { attachmentId: req.params.attachmentId, orderId: req.params.id }, transaction }
    )
    if (rows.length === 0) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '附件不存在' })
    }

    await sequelize.query(
      'DELETE FROM order_attachments WHERE id = :attachmentId AND order_id = :orderId',
      { replacements: { attachmentId: req.params.attachmentId, orderId: req.params.id }, transaction }
    )
    await insertEvent(req.params.id, {
      eventType: 'attachment_deleted',
      title: '删除订单附件',
      payload: { file: rows[0].original_name }
    }, req, transaction)
    await transaction.commit()
    removeStoredFile(rows[0].storage_path)
    res.json({ success: true, message: '附件已删除' })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] attachment delete failed:', err)
    res.status(500).json({ success: false, message: '删除订单附件失败: ' + err.message })
  }
})

router.delete('/:id', async (req, res) => {
  const transaction = await sequelize.transaction()
  try {
    const existing = await loadOrderBundle(req.params.id, req)
    if (!existing) {
      await transaction.rollback()
      return res.status(404).json({ success: false, message: '订单不存在或无权访问' })
    }
    const [attachmentRows] = await sequelize.query(
      'SELECT storage_path FROM order_attachments WHERE order_id = :orderId',
      { replacements: { orderId: req.params.id }, transaction }
    )

    await sequelize.query('DELETE FROM order_items WHERE order_id = :orderId', { replacements: { orderId: req.params.id }, transaction })
    await sequelize.query('DELETE FROM order_shipments WHERE order_id = :orderId', { replacements: { orderId: req.params.id }, transaction })
    await sequelize.query('DELETE FROM order_events WHERE order_id = :orderId', { replacements: { orderId: req.params.id }, transaction })
    await sequelize.query('DELETE FROM order_attachments WHERE order_id = :orderId', { replacements: { orderId: req.params.id }, transaction })
    await sequelize.query('DELETE FROM order_invoices WHERE order_id = :orderId', { replacements: { orderId: req.params.id }, transaction })
    await sequelize.query('DELETE FROM orders WHERE id = :orderId', { replacements: { orderId: req.params.id }, transaction })

    await transaction.commit()
    attachmentRows.forEach(row => removeStoredFile(row.storage_path))
    res.json({ success: true, message: '订单已删除' })
  } catch (err) {
    await transaction.rollback()
    console.error('[Orders] delete failed:', err)
    res.status(500).json({ success: false, message: '删除订单失败: ' + err.message })
  }
})

module.exports = router
