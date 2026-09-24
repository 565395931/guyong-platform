'use strict'

const { randomUUID } = require('node:crypto')

function createOrderFulfillmentRepository(sequelize) {
  if (!sequelize || typeof sequelize.query !== 'function') throw new TypeError('order fulfillment repository requires Sequelize')
  return {
    async getOrder(orderId) {
      const [rows] = await sequelize.query(
        `SELECT id, order_no AS orderNo, channel, account_id AS accountId,
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.externalOrderId')),
                         JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.external_order_id')),
                         order_no) AS externalOrderId
           FROM orders WHERE id=:orderId LIMIT 1`,
        { replacements: { orderId } }
      )
      return rows[0] || null
    },

    async listItems(orderId) {
      const [rows] = await sequelize.query(
        `SELECT id, external_sku AS externalSku, sku_code AS skuCode, quantity
           FROM order_items WHERE order_id=:orderId ORDER BY sort_order, created_at`,
        { replacements: { orderId } }
      )
      return rows
    },

    async findFulfillment(orderId) {
      const [rows] = await sequelize.query(
        `SELECT id, order_id AS orderId, warehouse_code AS warehouseCode,
                reservation_key AS reservationKey, status, channel, account_id AS accountId,
                external_order_id AS externalOrderId, lines_json AS fulfillmentLines, last_error AS lastError
           FROM order_fulfillments WHERE order_id=:orderId LIMIT 1`,
        { replacements: { orderId } }
      )
      const row = rows[0]
      if (!row) return null
      return { ...row, lines: typeof row.fulfillmentLines === 'string' ? JSON.parse(row.fulfillmentLines) : row.fulfillmentLines }
    },

    async createFulfillment(row) {
      await sequelize.query(
        `INSERT INTO order_fulfillments
          (id, order_id, warehouse_code, reservation_key, status, channel, account_id,
           external_order_id, lines_json, created_by)
         VALUES (:id, :orderId, :warehouseCode, :reservationKey, :status, :channel,
           :accountId, :externalOrderId, :lines, :createdBy)`,
        { replacements: { ...row, lines: JSON.stringify(row.lines) } }
      )
      return row
    },

    async markShipped(id, patch) {
      await sequelize.query(
        `UPDATE order_fulfillments SET status='shipped', last_error=:lastError, updated_at=CURRENT_TIMESTAMP(3) WHERE id=:id`,
        { replacements: { id, lastError: patch.lastError || null } }
      )
      return this.findFulfillment(patch.orderId)
    },

    async createShipment(input) {
      await sequelize.query(
        `INSERT INTO order_shipments
          (id, order_id, shipment_type, courier, tracking_no, status, shipped_at, metadata, created_at, updated_at)
         VALUES (:id, :orderId, :shipmentType, :courier, :trackingNo, 'shipped', :shippedAt, :metadata, NOW(), NOW())`,
        { replacements: { ...input, metadata: input.metadata ? JSON.stringify(input.metadata) : null } }
      )
      await sequelize.query(
        `UPDATE orders SET status=:status, updated_by=:operatorId, updated_at=NOW() WHERE id=:orderId`,
        { replacements: { orderId: input.orderId, status: input.orderStatus || 'international_shipping', operatorId: input.operatorId } }
      )
      return input
    },

    async enqueueWriteback(row) {
      const id = row.id || randomUUID()
      await sequelize.query(
        `INSERT INTO fulfillment_writeback_outbox
          (id, fulfillment_id, event_type, channel, account_id, external_order_id, payload_json, status)
         VALUES (:id, :fulfillmentId, :eventType, :channel, :accountId, :externalOrderId, :payloadJson, 'pending')
         ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json), updated_at=CURRENT_TIMESTAMP(3)`,
        { replacements: { ...row, id, payloadJson: JSON.stringify(row.payload) } }
      )
      return { ...row, id, status: 'pending' }
    },

    async getWritebackStatus(fulfillmentId) {
      const [rows] = await sequelize.query(
        `SELECT status FROM fulfillment_writeback_outbox
          WHERE fulfillment_id=:fulfillmentId AND event_type='shipment.created'
          LIMIT 1`,
        { replacements: { fulfillmentId } }
      )
      return rows[0]?.status || null
    },

    async findPendingWriteback(fulfillmentId) {
      const [rows] = await sequelize.query(
        `SELECT id, fulfillment_id AS fulfillmentId, event_type AS eventType,
                channel, account_id AS accountId, external_order_id AS externalOrderId,
                payload_json AS payload, status, attempt_count AS attemptCount
           FROM fulfillment_writeback_outbox
          WHERE fulfillment_id=:fulfillmentId AND status IN ('pending','failed')
          ORDER BY created_at LIMIT 1`,
        { replacements: { fulfillmentId } }
      )
      const row = rows[0]
      return row ? { ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } : null
    },

    async markWriteback(id, patch) {
      await sequelize.query(
        `UPDATE fulfillment_writeback_outbox
            SET status=:status, attempt_count=attempt_count+1, last_error=:lastError, updated_at=CURRENT_TIMESTAMP(3)
          WHERE id=:id`,
        { replacements: { id, status: patch.status, lastError: patch.lastError || null } }
      )
      return { id, ...patch }
    },

    async updateOrderStatus(orderId, status) {
      await sequelize.query('UPDATE orders SET status=:status, updated_at=NOW() WHERE id=:orderId', { replacements: { orderId, status } })
    }
  }
}

module.exports = { createOrderFulfillmentRepository }
