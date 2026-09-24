'use strict'

const QUANTITY_SCALE = 1000n

function toDatabaseQuantity(value) {
  if (typeof value !== 'bigint') return String(value)
  const negative = value < 0n
  const unsigned = negative ? -value : value
  const whole = unsigned / QUANTITY_SCALE
  const fraction = String(unsigned % QUANTITY_SCALE).padStart(3, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function parseJson(value) {
  if (typeof value !== 'string') return value ?? null
  try { return JSON.parse(value) } catch { return null }
}

function createWarehouseRepository(sequelize, transaction = null) {
  if (!sequelize || typeof sequelize.query !== 'function') throw new TypeError('sequelize query dependency is required')
  return {
    async createWarehouse(input) {
      await sequelize.query(`INSERT INTO warehouses (id, code, name, status, created_by) VALUES (:id, :code, :name, :status, :createdBy)`, { replacements: input, ...(transaction ? { transaction } : {}) })
      return { id: input.id, code: input.code, name: input.name, status: input.status }
    },
    async listWarehouses() {
      const [rows] = await sequelize.query('SELECT id, code, name, status, created_by, created_at, updated_at FROM warehouses ORDER BY code', transaction ? { transaction } : undefined)
      return rows
    },
    async findWarehouse(code) {
      const [rows] = await sequelize.query('SELECT id, code, name, status FROM warehouses WHERE code = :code LIMIT 1', { replacements: { code }, ...(transaction ? { transaction } : {}) })
      return rows[0] || null
    },
    async findWarehouseById(id) {
      const [rows] = await sequelize.query('SELECT id, code, name, status FROM warehouses WHERE id = :id LIMIT 1', { replacements: { id }, ...(transaction ? { transaction } : {}) })
      return rows[0] || null
    },
    async getInventory(warehouseId, skuCode) {
      const lock = transaction ? ' FOR UPDATE' : ''
      const [rows] = await sequelize.query(`SELECT id, warehouse_id AS warehouseId, sku_code AS skuCode, on_hand_quantity AS onHand, reserved_quantity AS reserved FROM warehouse_inventory WHERE warehouse_id = :warehouseId AND sku_code = :skuCode LIMIT 1${lock}`, { replacements: { warehouseId, skuCode }, ...(transaction ? { transaction } : {}) })
      return rows[0] || { warehouseId, skuCode, onHand: '0', reserved: '0' }
    },
    async listInventory(warehouseId) {
      const [rows] = await sequelize.query('SELECT id, warehouse_id AS warehouseId, sku_code AS skuCode, on_hand_quantity AS onHand, reserved_quantity AS reserved FROM warehouse_inventory WHERE warehouse_id = :warehouseId ORDER BY sku_code', { replacements: { warehouseId }, ...(transaction ? { transaction } : {}) })
      return rows
    },
    async saveInventory(row) {
      await sequelize.query(`INSERT INTO warehouse_inventory (id, warehouse_id, sku_code, on_hand_quantity, reserved_quantity) VALUES (:id, :warehouseId, :skuCode, :onHand, :reserved) ON DUPLICATE KEY UPDATE on_hand_quantity = VALUES(on_hand_quantity), reserved_quantity = VALUES(reserved_quantity), updated_at = CURRENT_TIMESTAMP(3)`, { replacements: { ...row, onHand: toDatabaseQuantity(row.onHand), reserved: toDatabaseQuantity(row.reserved) }, ...(transaction ? { transaction } : {}) })
      return row
    },
    async findLedgerByOperationKey(operationKey) {
      const [rows] = await sequelize.query('SELECT id, operation_key AS operationKey FROM warehouse_inventory_ledger WHERE operation_key = :operationKey LIMIT 1', { replacements: { operationKey }, ...(transaction ? { transaction } : {}) })
      return rows[0] || null
    },
    async appendLedger(row) {
      await sequelize.query(`INSERT INTO warehouse_inventory_ledger (id, warehouse_id, sku_code, operation_key, operation_type, on_hand_delta, reserved_delta, reference_key, quantity, metadata_json, created_by) VALUES (:id, :warehouseId, :skuCode, :operationKey, :operationType, :onHandDelta, :reservedDelta, :referenceKey, :quantity, :metadata, :createdBy)`, { replacements: { ...row, onHandDelta: toDatabaseQuantity(row.onHandDelta), reservedDelta: toDatabaseQuantity(row.reservedDelta), quantity: toDatabaseQuantity(row.quantity), metadata: row.metadata ? JSON.stringify(row.metadata) : null }, ...(transaction ? { transaction } : {}) })
      return row
    },
    async listLedger(warehouseId, filters) {
      const where = ['warehouse_id = :warehouseId']
      const replacements = {
        warehouseId,
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize
      }
      if (filters.skuCode) { where.push('sku_code = :skuCode'); replacements.skuCode = filters.skuCode }
      if (filters.operationType) { where.push('operation_type = :operationType'); replacements.operationType = filters.operationType }
      const whereClause = where.join(' AND ')
      const [rows] = await sequelize.query(`SELECT id, warehouse_id AS warehouseId, sku_code AS skuCode, operation_key AS operationKey, operation_type AS operationType, on_hand_delta AS onHandDelta, reserved_delta AS reservedDelta, reference_key AS referenceKey, quantity, metadata_json AS metadata, created_by AS createdBy, created_at AS createdAt FROM warehouse_inventory_ledger WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`, { replacements, ...(transaction ? { transaction } : {}) })
      const [countRows] = await sequelize.query(`SELECT COUNT(*) AS total FROM warehouse_inventory_ledger WHERE ${whereClause}`, { replacements: Object.fromEntries(Object.entries(replacements).filter(([key]) => !['limit', 'offset'].includes(key))), ...(transaction ? { transaction } : {}) })
      return { rows: rows.map(row => ({ ...row, metadata: parseJson(row.metadata) })), total: Number(countRows[0]?.total || 0) }
    },
    async findReservation(reservationKey) {
      const lock = transaction ? ' FOR UPDATE' : ''
      const [rows] = await sequelize.query(`SELECT id, reservation_key AS reservationKey, order_ref AS orderRef, warehouse_id AS warehouseId, status, lines_json AS reservationLines, created_by AS createdBy FROM warehouse_reservations WHERE reservation_key = :reservationKey LIMIT 1${lock}`, { replacements: { reservationKey }, ...(transaction ? { transaction } : {}) })
      if (!rows[0]) return null
      const rawLines = rows[0].reservationLines ?? rows[0].lines
      return { ...rows[0], lines: typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines }
    },
    async listReservations(warehouseId, status = null) {
      const replacements = { warehouseId }
      const statusClause = status ? ' AND status = :status' : ''
      if (status) replacements.status = status
      const [rows] = await sequelize.query(`SELECT id, reservation_key AS reservationKey, order_ref AS orderRef, warehouse_id AS warehouseId, status, lines_json AS reservationLines, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM warehouse_reservations WHERE warehouse_id = :warehouseId${statusClause} ORDER BY created_at DESC LIMIT 200`, { replacements, ...(transaction ? { transaction } : {}) })
      return rows.map(row => { const rawLines = row.reservationLines ?? row.lines; return { ...row, lines: typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines } })
    },
    async saveReservation(row) {
      await sequelize.query(`INSERT INTO warehouse_reservations (id, reservation_key, order_ref, warehouse_id, status, lines_json, created_by) VALUES (:id, :reservationKey, :orderRef, :warehouseId, :status, :lines, :createdBy) ON DUPLICATE KEY UPDATE status = VALUES(status), lines_json = VALUES(lines_json), updated_at = CURRENT_TIMESTAMP(3)`, { replacements: { ...row, lines: JSON.stringify(row.lines) }, ...(transaction ? { transaction } : {}) })
      return row
    },
    async withTransaction(callback) {
      if (typeof sequelize.transaction !== 'function') return callback(this)
      return sequelize.transaction(transactionContext => callback(createWarehouseRepository(sequelize, transactionContext)))
    }
  }
}

module.exports = { createWarehouseRepository, toDatabaseQuantity }
