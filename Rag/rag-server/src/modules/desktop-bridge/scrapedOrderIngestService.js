/**
 * 千帆（小红书）桌面采集订单入库。
 *
 * 数据流：节点定时采集订单页 → WS `commerce.orders.scraped` → 本服务 → orders 表。
 *
 * 幂等：以平台订单号（order_no，唯一键）为准——重复采集只更新不新增，
 * 每天定时采集天然去重。
 *
 * 字段映射（订单列表页 11 列 → orders 表）：
 *   订单号 → order_no；状态 → status（映射表见 STATUS_MAP，原文保留在 raw_payload）；
 *   用户名/用户ID/手机号/收货地址 → customer_name/channel_user_id/customer_phone/customer_address；
 *   创建时间 → purchase_time；其余列（商家名称/发货仓/运单号/操作列表）保留在 raw_payload，
 *   运单号暂不入 order_shipments（列表页数据不足以确定承运商与配送类型，待做详情页采集后补）。
 *
 * 资产假设（无法从列表页确定，如实记录）：
 *   - payment_status：非草稿单一律记 paid（订单能走到发货/签收即已付款；退款场景靠 raw_payload 追溯）；
 *   - 金额相关字段一律为空（列表页不提供），currency 保持表默认值。
 */

const { randomUUID } = require('node:crypto')

const ADAPTER_CHANNEL_MAP = Object.freeze({
  'xiaohongshu.qianfan': 'xiaohongshu'
})

// 千帆订单状态 → 平台订单状态（平台词表见 routes/orders.js 的 ORDER_STATUS 与前端 statusOptions）
const STATUS_MAP = Object.freeze({
  待付款: 'draft',
  待发货: 'paid',
  部分发货: 'domestic_shipping',
  已发货: 'domestic_shipping',
  待收货: 'domestic_shipping',
  已签收: 'delivered',
  已完成: 'closed',
  交易成功: 'closed',
  已关闭: 'closed',
  交易关闭: 'closed',
  取消发货: 'cancelled',
  已取消: 'cancelled',
  退款中: 'after_sales',
  售后中: 'after_sales',
  换货中: 'after_sales',
  退款成功: 'after_sales'
})

const ORDER_STATUS = new Set([
  'draft', 'confirmed', 'paid', 'purchasing', 'domestic_shipping',
  'international_shipping', 'delivered', 'after_sales', 'closed', 'cancelled'
])

const MAX_ORDERS_PER_BATCH = 500
const MAX_ORDER_NO_LENGTH = 40

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** '2026/10/01 11:50:38' | '2026-10-01 11:50:38' → 'YYYY-MM-DD HH:MM:SS'，无效返回 null */
function parseChinaTime(raw) {
  const match = String(raw || '').trim()
    .match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} `
    + `${hour.padStart(2, '0')}:${minute}:${second}`
}

/** 采集行 → orders 表字段。无法建档的行（缺订单号/超长）返回 null。 */
function mapOrderRow(row, meta, warnings) {
  const orderNo = cleanString(row && row['订单号'])
  if (!orderNo || orderNo.length > MAX_ORDER_NO_LENGTH) return null

  const statusRaw = cleanString(row['状态'])
  const mapped = STATUS_MAP[statusRaw]
  if (!mapped && statusRaw && !warnings.unknownStatus.has(statusRaw)) {
    warnings.unknownStatus.add(statusRaw)
  }
  const status = ORDER_STATUS.has(mapped) ? mapped : 'confirmed'

  return {
    orderNo,
    status,
    statusRaw,
    paymentStatus: status === 'draft' ? 'unpaid' : 'paid',
    channelUserId: cleanString(row['用户ID']) || null,
    customerName: cleanString(row['用户名']) || null,
    customerPhone: cleanString(row['手机号']) || null,
    customerAddress: cleanString(row['收货地址']) || null,
    purchaseTime: parseChinaTime(row['创建时间']),
    rawPayload: {
      source: 'desktop_scrape',
      adapterId: meta.adapterId,
      capturedAt: meta.capturedAt || null,
      row
    }
  }
}

function createScrapedOrderIngestService({ sequelize, logger = console }) {
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new TypeError('scrapedOrderIngestService requires a sequelize instance')
  }

  async function resolveAccountId(channel, adapterId, transaction) {
    const rows = await sequelize.query(
      `SELECT id FROM channel_accounts
        WHERE channel = :channel AND adapter_type = 'desktop_bridge'
        ORDER BY id LIMIT 1`,
      { replacements: { channel, adapterId }, transaction }
    )
    const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : null
    return first && first.id ? Number(first.id) : null
  }

  async function orderNoExists(orderNo, transaction) {
    const rows = await sequelize.query(
      'SELECT id FROM orders WHERE order_no = :orderNo LIMIT 1',
      { replacements: { orderNo }, transaction }
    )
    const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : null
    return Boolean(first && first.id)
  }

  async function upsertOrder(record, accountId, channel, transaction) {
    await sequelize.query(
      `INSERT INTO orders
        (id, order_no, channel, account_id, channel_user_id, customer_name, customer_phone,
         customer_address, status, payment_status, purchase_time, raw_payload,
         created_at, updated_at)
       VALUES
        (:id, :orderNo, :channel, :accountId, :channelUserId, :customerName, :customerPhone,
         :customerAddress, :status, :paymentStatus, :purchaseTime, :rawPayload,
         NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         channel = VALUES(channel),
         account_id = VALUES(account_id),
         channel_user_id = VALUES(channel_user_id),
         customer_name = VALUES(customer_name),
         customer_phone = VALUES(customer_phone),
         customer_address = VALUES(customer_address),
         status = VALUES(status),
         payment_status = VALUES(payment_status),
         purchase_time = VALUES(purchase_time),
         raw_payload = VALUES(raw_payload),
         updated_at = NOW()`,
      {
        replacements: {
          id: randomUUID(),
          orderNo: record.orderNo,
          channel,
          accountId,
          channelUserId: record.channelUserId,
          customerName: record.customerName,
          customerPhone: record.customerPhone,
          customerAddress: record.customerAddress,
          status: record.status,
          paymentStatus: record.paymentStatus,
          purchaseTime: record.purchaseTime,
          rawPayload: JSON.stringify(record.rawPayload)
        },
        transaction
      }
    )
  }

  async function insertImportedEvent(record, meta, transaction) {
    await sequelize.query(
      `INSERT INTO order_events
        (id, order_id, event_type, title, description, operator_id, operator_name, payload, created_at)
       VALUES
        (:id, (SELECT id FROM orders WHERE order_no = :orderNo LIMIT 1),
         'imported', '千帆桌面采集入库', :description, NULL, '桌面桥接', :payload, NOW())`,
      {
        replacements: {
          id: randomUUID(),
          orderNo: record.orderNo,
          description: `状态「${record.statusRaw || '未知'}」→ ${record.status}`,
          payload: JSON.stringify({ adapterId: meta.adapterId, capturedAt: meta.capturedAt || null })
        },
        transaction
      }
    )
  }

  async function handle({ envelope }) {
    const payload = envelope && envelope.payload ? envelope.payload : {}
    const adapterId = cleanString(payload.adapterId)
    const channel = ADAPTER_CHANNEL_MAP[adapterId]
    if (!channel) {
      return {
        status: 'rejected',
        errorCode: 'UNSUPPORTED_ADAPTER',
        message: `不支持的上报适配器 ${adapterId || '(空)'}`
      }
    }
    const orders = Array.isArray(payload.orders) ? payload.orders : []
    if (orders.length > MAX_ORDERS_PER_BATCH) {
      return {
        status: 'rejected',
        errorCode: 'BATCH_TOO_LARGE',
        message: `单批最多 ${MAX_ORDERS_PER_BATCH} 条，收到 ${orders.length} 条`
      }
    }
    if (!orders.length) {
      return { status: 'processed', message: '无订单可入库' }
    }

    const meta = { adapterId, capturedAt: cleanString(payload.capturedAt) || null }
    const transaction = await sequelize.transaction()
    try {
      const accountId = await resolveAccountId(channel, adapterId, transaction)
      let inserted = 0
      let updated = 0
      let skipped = 0
      const warnings = { unknownStatus: new Set() }

      for (const row of orders) {
        const record = mapOrderRow(row, meta, warnings)
        if (!record) {
          skipped += 1
          continue
        }
        const existed = await orderNoExists(record.orderNo, transaction)
        await upsertOrder(record, accountId, channel, transaction)
        if (existed) {
          updated += 1
        } else {
          inserted += 1
          await insertImportedEvent(record, meta, transaction)
        }
      }
      await transaction.commit()

      if (warnings.unknownStatus.size) {
        logger.warn?.(`[OrderIngest] 未知订单状态（已回落为 confirmed，原文保留在 raw_payload）: ${[...warnings.unknownStatus].join(', ')}`)
      }
      const skippedNote = skipped ? `，跳过 ${skipped}（缺订单号）` : ''
      return {
        status: 'processed',
        message: `新增 ${inserted} 条、更新 ${updated} 条${skippedNote}`
      }
    } catch (error) {
      await transaction.rollback()
      logger.error?.(`[OrderIngest] 入库失败: ${error.message}`)
      return {
        status: 'retryable_error',
        errorCode: 'ORDER_INGEST_FAILED',
        message: `订单入库失败: ${error.message}`.slice(0, 500)
      }
    }
  }

  return Object.freeze({ handle })
}

module.exports = {
  ADAPTER_CHANNEL_MAP,
  ORDER_STATUS,
  STATUS_MAP,
  createScrapedOrderIngestService,
  mapOrderRow,
  parseChinaTime
}
