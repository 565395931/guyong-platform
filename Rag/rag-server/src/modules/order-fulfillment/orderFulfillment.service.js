'use strict'

const { randomUUID } = require('node:crypto')

function fulfillmentError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requiredId(value, field, maximum = 160) {
  const text = String(value || '').trim()
  if (!text || text.length > maximum) throw fulfillmentError('fulfillment_invalid_input', `${field} is invalid`)
  return text
}

function positiveOperator(value) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw fulfillmentError('fulfillment_invalid_input', 'operatorId is invalid')
  return id
}

function quantity(value) {
  const text = String(value ?? '').trim()
  if (!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(text) || Number(text) <= 0) throw fulfillmentError('fulfillment_invalid_input', 'quantity is invalid')
  return text
}

function createOrderFulfillmentService({ repository, warehouseService, skuMappingService, writebackAdapter = null }) {
  if (!repository || !warehouseService || !skuMappingService) throw new TypeError('order fulfillment dependencies are required')

  async function resolveLines(order) {
    const items = await repository.listItems(order.id)
    if (!Array.isArray(items) || items.length === 0) throw fulfillmentError('fulfillment_items_missing', 'order has no items')
    const lines = []
    for (const item of items) {
      const internalSku = item.skuCode
        ? String(item.skuCode).trim().toUpperCase()
        : (await skuMappingService.resolve(order.channel, order.accountId, item.externalSku)).internalSkuCode
      if (!internalSku) throw fulfillmentError('fulfillment_sku_missing', 'internal SKU is required')
      lines.push({ skuCode: internalSku, quantity: quantity(item.quantity) })
    }
    return lines
  }

  async function dispatchWriteback(fulfillment, shipment) {
    const pending = await repository.findPendingWriteback(fulfillment.id)
    if (!pending) return 'succeeded'
    if (!writebackAdapter || typeof writebackAdapter.writeShipment !== 'function') return 'pending'
    try {
      await writebackAdapter.writeShipment({
        channel: fulfillment.channel,
        accountId: fulfillment.accountId,
        externalOrderId: fulfillment.externalOrderId,
        courier: shipment.courier,
        trackingNo: shipment.trackingNo,
        shipmentType: shipment.shipmentType
      })
      await repository.markWriteback(pending.id, { status: 'succeeded', lastError: null })
      return 'succeeded'
    } catch (error) {
      await repository.markWriteback(pending.id, { status: 'failed', lastError: String(error.message || 'writeback failed').slice(0, 500) })
      return 'failed'
    }
  }

  return {
    async reserve(input = {}) {
      const orderId = requiredId(input.orderId, 'orderId')
      const warehouseCode = requiredId(input.warehouseCode, 'warehouseCode', 40).toUpperCase()
      const idempotencyKey = requiredId(input.idempotencyKey, 'idempotencyKey')
      const operatorId = positiveOperator(input.operatorId)
      const existing = await repository.findFulfillment(orderId)
      if (existing && ['reserved', 'shipped'].includes(existing.status)) return existing
      const order = await repository.getOrder(orderId)
      if (!order) throw fulfillmentError('fulfillment_order_not_found', 'order not found')
      const lines = await resolveLines(order)
      const reservationKey = `order:${orderId}:${idempotencyKey}`
      await warehouseService.reserve({ warehouseCode, reservationKey, orderRef: order.orderNo || orderId, lines }, operatorId)
      const row = {
        id: randomUUID(), orderId, warehouseCode, reservationKey, status: 'reserved',
        channel: order.channel || null, accountId: order.accountId || null,
        externalOrderId: order.externalOrderId || null, lines, createdBy: operatorId
      }
      try {
        return await repository.createFulfillment(row)
      } catch (error) {
        await warehouseService.release(reservationKey, operatorId).catch(() => {})
        throw error
      }
    },

    async ship(input = {}) {
      const orderId = requiredId(input.orderId, 'orderId')
      const operatorId = positiveOperator(input.operatorId)
      const courier = requiredId(input.courier, 'courier', 120)
      const trackingNo = requiredId(input.trackingNo, 'trackingNo', 160)
      const existing = await repository.findFulfillment(orderId)
      if (!existing) throw fulfillmentError('fulfillment_not_reserved', 'order must be reserved before shipping')
      if (existing.status === 'shipped') {
        const writebackStatus = await repository.getWritebackStatus(existing.id)
        return { ...existing, writebackStatus: writebackStatus || 'unknown' }
      }
      if (existing.status !== 'reserved') throw fulfillmentError('fulfillment_state_invalid', 'fulfillment is not reservable')
      await warehouseService.fulfill(existing.reservationKey, operatorId)
      const shipment = {
        id: randomUUID(), orderId, shipmentType: input.shipmentType || 'international', courier, trackingNo,
        shippedAt: input.shippedAt || new Date(), metadata: input.metadata || null, operatorId
      }
      await repository.createShipment(shipment)
      const updated = await repository.markShipped(existing.id, { orderId, lastError: null })
      await repository.enqueueWriteback({
        fulfillmentId: existing.id, eventType: 'shipment.created', channel: existing.channel,
        accountId: existing.accountId, externalOrderId: existing.externalOrderId,
        payload: { orderId, courier, trackingNo, shipmentType: shipment.shipmentType }
      })
      const writebackStatus = await dispatchWriteback(existing, shipment)
      return { ...updated, writebackStatus }
    }
  }
}

module.exports = { createOrderFulfillmentService, fulfillmentError }
