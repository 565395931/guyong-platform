'use strict'

const crypto = require('node:crypto')

const SCALE = 1000n
const LEDGER_OPERATION_TYPES = new Set(['receipt', 'adjustment', 'reserve', 'release', 'fulfill'])

function warehouseError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function text(value, field) {
  const result = String(value ?? '').trim()
  if (!result || result.length > 160) throw warehouseError('warehouse_invalid_input', `${field} is required`)
  return result
}

function quantity(value, field = 'quantity', allowNegative = false) {
  const raw = String(value ?? '').trim()
  const pattern = allowNegative ? /^-?(0|[1-9]\d*)(?:\.\d{1,3})?$/ : /^(0|[1-9]\d*)(?:\.\d{1,3})?$/
  if (!pattern.test(raw)) throw warehouseError('warehouse_invalid_quantity', `${field} is invalid`)
  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [whole, fraction = ''] = unsigned.split('.')
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(3, '0') || 0)
  if (scaled === 0n) throw warehouseError('warehouse_invalid_quantity', `${field} must not be zero`)
  return negative ? -scaled : scaled
}

function storedQuantity(value, field = 'quantity') {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value) * SCALE
  const raw = String(value ?? '0').trim()
  if (!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) throw warehouseError('warehouse_inventory_corrupt', `${field} is invalid`)
  const [whole, fraction = ''] = raw.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(3, '0') || 0)
}

function storedDelta(value, field) {
  if (typeof value === 'bigint') return value
  const raw = String(value ?? '0').trim()
  if (!/^-?(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) throw warehouseError('warehouse_inventory_corrupt', `${field} is invalid`)
  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [whole, fraction = ''] = unsigned.split('.')
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(3, '0') || 0)
  return negative ? -scaled : scaled
}

function positiveInteger(value, field, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback
  const raw = String(value)
  if (!/^[1-9]\d*$/.test(raw)) throw warehouseError('warehouse_invalid_input', `${field} is invalid`)
  const result = Number(raw)
  if (!Number.isSafeInteger(result) || result > maximum) throw warehouseError('warehouse_invalid_input', `${field} is invalid`)
  return result
}

function formatQuantity(scaled) {
  const value = BigInt(scaled)
  const negative = value < 0n
  const unsigned = negative ? -value : value
  const whole = unsigned / SCALE
  const fraction = String(unsigned % SCALE).padStart(3, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function normalizeRow(row, warehouseCode) {
  const onHand = storedQuantity(row.onHand ?? row.on_hand_quantity ?? 0, 'onHand')
  const reserved = storedQuantity(row.reserved ?? row.reserved_quantity ?? 0, 'reserved')
  if (onHand < 0n || reserved < 0n || reserved > onHand) throw warehouseError('warehouse_inventory_corrupt', 'inventory quantity is invalid')
  return {
    warehouseId: row.warehouseId ?? row.warehouse_id,
    warehouseCode,
    skuCode: row.skuCode ?? row.sku_code,
    onHand: formatQuantity(onHand),
    reserved: formatQuantity(reserved),
    available: formatQuantity(onHand - reserved)
  }
}

function createWarehouseService({ repository, idFactory = () => crypto.randomUUID() }) {
  if (!repository) throw new TypeError('warehouse repository is required')

  async function atomic(work) {
    if (typeof repository.withTransaction === 'function') return repository.withTransaction(work)
    return work(repository)
  }

  async function findWarehouse(code) {
    const warehouse = await repository.findWarehouse(text(code, 'warehouseCode').toUpperCase())
    if (!warehouse) throw warehouseError('warehouse_not_found', 'warehouse not found')
    return warehouse
  }

  function requireActiveWarehouse(warehouse) {
    if (warehouse.status !== 'active') throw warehouseError('warehouse_inactive', 'warehouse is inactive')
  }

  return {
    async createWarehouse(input, operatorId) {
      const code = text(input?.code, 'warehouse code').toUpperCase()
      if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw warehouseError('warehouse_invalid_input', 'warehouse code is invalid')
      const name = text(input?.name, 'warehouse name')
      if (input?.status && !['active', 'inactive'].includes(input.status)) throw warehouseError('warehouse_invalid_input', 'status is invalid')
      return repository.createWarehouse({ id: idFactory(), code, name, status: input.status || 'active', createdBy: operatorId })
    },

    async listWarehouses() { return repository.listWarehouses() },

    async getInventory(warehouseCode, skuCode) {
      const warehouse = await findWarehouse(warehouseCode)
      const row = await repository.getInventory(warehouse.id, text(skuCode, 'skuCode').toUpperCase())
      return normalizeRow(row, warehouse.code)
    },

    async listInventory(warehouseCode) {
      const warehouse = await findWarehouse(warehouseCode)
      const rows = await repository.listInventory(warehouse.id)
      return rows.map(row => normalizeRow(row, warehouse.code))
    },

    async listReservations(warehouseCode, status) {
      const warehouse = await findWarehouse(warehouseCode)
      if (status && !['reserved', 'released', 'fulfilled'].includes(status)) throw warehouseError('warehouse_invalid_input', 'reservation status is invalid')
      return repository.listReservations(warehouse.id, status || null)
    },

    async listLedger(warehouseCode, filters = {}) {
      const warehouse = await findWarehouse(warehouseCode)
      const page = positiveInteger(filters.page, 'page', 1, 1000000)
      const pageSize = positiveInteger(filters.pageSize, 'pageSize', 20, 100)
      const operationType = filters.operationType ? text(filters.operationType, 'operationType') : null
      if (operationType && !LEDGER_OPERATION_TYPES.has(operationType)) throw warehouseError('warehouse_invalid_input', 'operationType is invalid')
      const skuCode = filters.skuCode ? text(filters.skuCode, 'skuCode').toUpperCase() : null
      const result = await repository.listLedger(warehouse.id, { page, pageSize, operationType, skuCode })
      return {
        items: result.rows.map(row => ({
          id: row.id,
          warehouseCode: warehouse.code,
          skuCode: row.skuCode ?? row.sku_code,
          operationKey: row.operationKey ?? row.operation_key,
          operationType: row.operationType ?? row.operation_type,
          onHandDelta: formatQuantity(storedDelta(row.onHandDelta ?? row.on_hand_delta, 'onHandDelta')),
          reservedDelta: formatQuantity(storedDelta(row.reservedDelta ?? row.reserved_delta, 'reservedDelta')),
          quantity: formatQuantity(storedQuantity(row.quantity, 'quantity')),
          referenceKey: row.referenceKey ?? row.reference_key ?? null,
          metadata: row.metadata ?? null,
          createdBy: row.createdBy ?? row.created_by ?? null,
          createdAt: row.createdAt ?? row.created_at ?? null
        })),
        total: result.total,
        page,
        pageSize
      }
    },

    async adjustStock(input, operatorId) {
      const warehouse = await findWarehouse(input?.warehouseCode)
      requireActiveWarehouse(warehouse)
      const skuCode = text(input?.skuCode, 'skuCode').toUpperCase()
      const operationKey = text(input?.idempotencyKey, 'idempotencyKey')
      const delta = quantity(input?.quantity, 'quantity', true)
      if (delta > 0n && input?.reason && input.reason !== 'receipt') throw warehouseError('warehouse_invalid_input', 'positive stock changes must use receipt reason')
      if (delta < 0n && input?.reason && input.reason !== 'adjustment') throw warehouseError('warehouse_invalid_input', 'negative stock changes must use adjustment reason')
      return atomic(async store => {
        const existing = await store.findLedgerByOperationKey(operationKey)
        if (existing) throw warehouseError('warehouse_duplicate_operation', 'idempotency key already used')
        const row = await store.getInventory(warehouse.id, skuCode)
        const onHand = storedQuantity(row.onHand ?? row.on_hand_quantity ?? 0, 'onHand')
        const reserved = storedQuantity(row.reserved ?? row.reserved_quantity ?? 0, 'reserved')
        if (onHand + delta < reserved) throw warehouseError('warehouse_insufficient_available', 'available inventory is insufficient')
        const updated = { ...row, id: row.id || idFactory(), warehouseId: warehouse.id, skuCode, onHand: onHand + delta, reserved }
        await store.saveInventory(updated)
        await store.appendLedger({ id: idFactory(), warehouseId: warehouse.id, skuCode, operationKey, operationType: delta > 0n ? 'receipt' : 'adjustment', onHandDelta: delta, reservedDelta: 0n, referenceKey: input.referenceKey || null, quantity: delta < 0n ? -delta : delta, metadata: input.metadata || null, createdBy: operatorId })
        return normalizeRow(updated, warehouse.code)
      })
    },

    async reserve(input, operatorId) {
      const warehouse = await findWarehouse(input?.warehouseCode)
      requireActiveWarehouse(warehouse)
      const reservationKey = text(input?.reservationKey, 'reservationKey')
      if (!Array.isArray(input?.lines) || input.lines.length === 0) throw warehouseError('warehouse_invalid_input', 'reservation lines are required')
      const linesBySku = new Map()
      for (const line of input.lines) {
        const skuCode = text(line.skuCode, 'skuCode').toUpperCase()
        const lineQuantity = quantity(line.quantity, 'quantity')
        linesBySku.set(skuCode, (linesBySku.get(skuCode) || 0n) + lineQuantity)
      }
      const lines = [...linesBySku.entries()].map(([skuCode, lineQuantity]) => ({ skuCode, quantity: lineQuantity }))
      return atomic(async store => {
        const existing = await store.findReservation(reservationKey)
        if (existing) {
          const expectedLines = lines.map(line => ({ skuCode: line.skuCode, quantity: formatQuantity(line.quantity) }))
          const sameLines = JSON.stringify(existing.lines) === JSON.stringify(expectedLines)
          if (existing.warehouseId !== warehouse.id || existing.orderRef !== text(input.orderRef, 'orderRef') || !sameLines) {
            throw warehouseError('warehouse_duplicate_operation', 'reservation key already belongs to different input')
          }
          return existing
        }
        const rows = []
        for (const line of lines) {
          const row = await store.getInventory(warehouse.id, line.skuCode)
          const onHand = storedQuantity(row.onHand ?? row.on_hand_quantity ?? 0, 'onHand')
          const reserved = storedQuantity(row.reserved ?? row.reserved_quantity ?? 0, 'reserved')
          if (onHand - reserved < line.quantity) throw warehouseError('warehouse_insufficient_available', `insufficient inventory for ${line.skuCode}`)
          rows.push({ row, line, onHand, reserved })
        }
        const reservation = { id: idFactory(), reservationKey, orderRef: text(input.orderRef, 'orderRef'), warehouseId: warehouse.id, status: 'reserved', lines: lines.map(line => ({ skuCode: line.skuCode, quantity: formatQuantity(line.quantity) })), createdBy: operatorId }
        await store.saveReservation(reservation)
        for (const item of rows) {
          await store.saveInventory({ ...item.row, id: item.row.id || idFactory(), warehouseId: warehouse.id, skuCode: item.line.skuCode, onHand: item.onHand, reserved: item.reserved + item.line.quantity })
          await store.appendLedger({ id: idFactory(), warehouseId: warehouse.id, skuCode: item.line.skuCode, operationKey: `${reservationKey}:${item.line.skuCode}:reserve`, operationType: 'reserve', onHandDelta: 0n, reservedDelta: item.line.quantity, referenceKey: reservationKey, quantity: item.line.quantity, createdBy: operatorId })
        }
        return reservation
      })
    },

    async release(reservationKey, operatorId) { return atomic(store => transitionReservation(store, reservationKey, 'released', operatorId)) },
    async fulfill(reservationKey, operatorId) { return atomic(store => transitionReservation(store, reservationKey, 'fulfilled', operatorId)) }
  }

  async function transitionReservation(store, reservationKey, target, operatorId) {
    const reservation = await store.findReservation(text(reservationKey, 'reservationKey'))
    if (!reservation || reservation.status !== 'reserved') throw warehouseError('warehouse_reservation_state_invalid', 'reservation is not active')
    for (const line of reservation.lines) {
      const row = await store.getInventory(reservation.warehouseId, line.skuCode)
      const onHand = storedQuantity(row.onHand ?? row.on_hand_quantity ?? 0, 'onHand')
      const reserved = storedQuantity(row.reserved ?? row.reserved_quantity ?? 0, 'reserved')
      const amount = quantity(line.quantity, 'quantity')
      if (reserved < amount || (target === 'fulfilled' && onHand < amount)) throw warehouseError('warehouse_inventory_corrupt', 'reservation exceeds inventory')
      await store.saveInventory({ ...row, id: row.id || idFactory(), warehouseId: reservation.warehouseId, skuCode: line.skuCode, onHand: target === 'fulfilled' ? onHand - amount : onHand, reserved: reserved - amount })
      await store.appendLedger({ id: idFactory(), warehouseId: reservation.warehouseId, skuCode: line.skuCode, operationKey: `${reservation.reservationKey}:${line.skuCode}:${target}`, operationType: target === 'fulfilled' ? 'fulfill' : 'release', onHandDelta: target === 'fulfilled' ? -amount : 0n, reservedDelta: -amount, referenceKey: reservation.reservationKey, quantity: amount, createdBy: operatorId })
    }
    const updatedReservation = { ...reservation, status: target }
    await store.saveReservation(updatedReservation)
    return updatedReservation
  }
}

module.exports = { createWarehouseService, formatQuantity, quantity }
