'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWarehouseService } = require('./warehouse.service')
const { WAREHOUSE_SCHEMA_STATEMENTS } = require('./warehouse.schema')

function repository() {
  const warehouses = new Map()
  const inventory = new Map()
  const reservations = new Map()
  const ledger = []
  let transactionCount = 0
  return {
    warehouses, inventory, reservations, ledger,
    get transactionCount() { return transactionCount },
    async withTransaction(callback) { transactionCount += 1; return callback(this) },
    async createWarehouse(input) {
      const warehouse = { id: input.id || `w-${warehouses.size + 1}`, ...input }
      warehouses.set(warehouse.code, warehouse)
      return warehouse
    },
    async findWarehouse(code) { return warehouses.get(code) || null },
    async findWarehouseById(id) { return [...warehouses.values()].find(warehouse => warehouse.id === id) || null },
    async getInventory(warehouseId, skuCode) { return inventory.get(`${warehouseId}:${skuCode}`) || { warehouseId, skuCode, onHand: 0, reserved: 0 } },
    async saveInventory(row) { inventory.set(`${row.warehouseId}:${row.skuCode}`, { ...row }); return row },
    async findReservation(key) { return reservations.get(key) || null },
    async listReservations(warehouseId, status) { return [...reservations.values()].filter(item => item.warehouseId === warehouseId && (!status || item.status === status)) },
    async saveReservation(row) { reservations.set(row.reservationKey, { ...row }); return row },
    async findLedgerByOperationKey(key) { return ledger.find(item => item.operationKey === key) || null },
    async listLedger(warehouseId, filters) {
      const matching = ledger.filter(item => item.warehouseId === warehouseId && (!filters.skuCode || item.skuCode === filters.skuCode) && (!filters.operationType || item.operationType === filters.operationType))
      const offset = (filters.page - 1) * filters.pageSize
      return { rows: matching.slice(offset, offset + filters.pageSize), total: matching.length }
    },
    async appendLedger(row) { ledger.push({ ...row }); return row }
  }
}

test('receives stock, exposes available quantity, and rejects overselling', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: () => 'fixed-id' })
  await service.createWarehouse({ code: 'WH-SH', name: 'Shanghai' }, 9)
  await service.adjustStock({ warehouseCode: 'WH-SH', skuCode: 'SKU-1', quantity: '10', reason: 'receipt', idempotencyKey: 'receipt-1' }, 9)

  assert.deepEqual(await service.getInventory('WH-SH', 'SKU-1'), {
    warehouseId: 'fixed-id', warehouseCode: 'WH-SH', skuCode: 'SKU-1', onHand: '10', reserved: '0', available: '10'
  })
  await assert.rejects(
    () => service.adjustStock({ warehouseCode: 'WH-SH', skuCode: 'SKU-1', quantity: '-11', reason: 'adjustment', idempotencyKey: 'adjust-1' }, 9),
    error => error.code === 'warehouse_insufficient_available'
  )
})

test('reserves multiple lines atomically and makes repeated idempotency keys no-op', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
  await service.createWarehouse({ code: 'WH-NB', name: 'Ningbo' }, 9)
  for (const [skuCode, quantity] of [['SKU-A', '5'], ['SKU-B', '3']]) {
    await service.adjustStock({ warehouseCode: 'WH-NB', skuCode, quantity, reason: 'receipt', idempotencyKey: `receipt-${skuCode}` }, 9)
  }

  const first = await service.reserve({ warehouseCode: 'WH-NB', reservationKey: 'order-1', orderRef: 'TB-1', lines: [{ skuCode: 'SKU-A', quantity: '2' }, { skuCode: 'SKU-B', quantity: '1' }] }, 9)
  const repeated = await service.reserve({ warehouseCode: 'WH-NB', reservationKey: 'order-1', orderRef: 'TB-1', lines: [{ skuCode: 'SKU-A', quantity: '2' }, { skuCode: 'SKU-B', quantity: '1' }] }, 9)
  assert.equal(first.status, 'reserved')
  assert.equal(repeated.id, first.id)
  assert.equal((await service.getInventory('WH-NB', 'SKU-A')).available, '3')
  assert.equal(store.ledger.filter(item => item.referenceKey === 'order-1').length, 2)
})

test('releases and fulfills only reserved quantities', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
  await service.createWarehouse({ code: 'WH-SZ', name: 'Shenzhen' }, 3)
  await service.adjustStock({ warehouseCode: 'WH-SZ', skuCode: 'SKU-1', quantity: '4', reason: 'receipt', idempotencyKey: 'receipt' }, 3)
  await service.reserve({ warehouseCode: 'WH-SZ', reservationKey: 'order-2', orderRef: 'PDD-2', lines: [{ skuCode: 'SKU-1', quantity: '2' }] }, 3)

  await service.release('order-2', 3)
  assert.deepEqual((await service.getInventory('WH-SZ', 'SKU-1')).available, '4')
  await assert.rejects(() => service.fulfill('order-2', 3), error => error.code === 'warehouse_reservation_state_invalid')

  await service.reserve({ warehouseCode: 'WH-SZ', reservationKey: 'order-3', orderRef: 'PDD-3', lines: [{ skuCode: 'SKU-1', quantity: '2' }] }, 3)
  await service.fulfill('order-3', 3)
  assert.deepEqual(await service.getInventory('WH-SZ', 'SKU-1'), {
    warehouseId: 'id-1', warehouseCode: 'WH-SZ', skuCode: 'SKU-1', onHand: '2', reserved: '0', available: '2'
  })
})

test('rejects invalid quantities and duplicate stock idempotency keys', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store })
  await service.createWarehouse({ code: 'WH-1', name: 'Main' }, 1)
  await assert.rejects(() => service.adjustStock({ warehouseCode: 'WH-1', skuCode: 'SKU', quantity: '0', reason: 'receipt', idempotencyKey: 'x' }, 1), /quantity/i)
  await service.adjustStock({ warehouseCode: 'WH-1', skuCode: 'SKU', quantity: '1', reason: 'receipt', idempotencyKey: 'x' }, 1)
  await assert.rejects(() => service.adjustStock({ warehouseCode: 'WH-1', skuCode: 'SKU', quantity: '1', reason: 'receipt', idempotencyKey: 'x' }, 1), error => error.code === 'warehouse_duplicate_operation')
})

test('releasing a reservation writes the MySQL release ledger type and makes it queryable', async () => {
  const ledgerSchema = WAREHOUSE_SCHEMA_STATEMENTS.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS warehouse_inventory_ledger'))
  const enumDefinition = ledgerSchema.match(/operation_type ENUM\(([^)]+)\)/)[1]
  const allowedTypes = new Set([...enumDefinition.matchAll(/'([^']+)'/g)].map(match => match[1]))
  const store = repository()
  const strictStore = {
    ...store,
    async appendLedger(row) {
      assert.ok(allowedTypes.has(row.operationType), `MySQL operation_type ENUM rejects ${row.operationType}`)
      return store.appendLedger(row)
    }
  }
  const service = createWarehouseService({ repository: strictStore })
  await service.createWarehouse({ code: 'WH-RELEASE', name: 'Release audit' }, 7)
  await service.adjustStock({ warehouseCode: 'WH-RELEASE', skuCode: 'SKU-1', quantity: '2.5', idempotencyKey: 'release-receipt' }, 7)
  await service.reserve({ warehouseCode: 'WH-RELEASE', reservationKey: 'release-order', orderRef: 'ORDER-RELEASE', lines: [{ skuCode: 'SKU-1', quantity: '1.5' }] }, 7)

  const reservation = await service.release('release-order', 7)
  assert.equal(reservation.status, 'released')
  assert.equal((await service.getInventory('WH-RELEASE', 'SKU-1')).available, '2.5')
  const ledger = await service.listLedger('WH-RELEASE', { operationType: 'release' })
  assert.equal(ledger.total, 1)
  assert.equal(ledger.items[0].operationType, 'release')
  assert.equal(ledger.items[0].reservedDelta, '-1.5')
  assert.equal(ledger.items[0].referenceKey, 'release-order')
})

test('uses a transaction boundary for stock mutations', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: () => 'fixed-id' })
  await service.createWarehouse({ code: 'WH-TX', name: 'Transactional' }, 1)
  await service.adjustStock({ warehouseCode: 'WH-TX', skuCode: 'SKU', quantity: '1', reason: 'receipt', idempotencyKey: 'tx-1' }, 1)
  await service.reserve({ warehouseCode: 'WH-TX', reservationKey: 'res-tx', orderRef: 'ORDER-TX', lines: [{ skuCode: 'SKU', quantity: '1' }] }, 1)
  await service.release('res-tx', 1)
  assert.equal(store.transactionCount, 3)
})

test('aggregates duplicate SKU lines before checking availability', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: () => 'fixed-id' })
  await service.createWarehouse({ code: 'WH-DUP', name: 'Duplicate line guard' }, 1)
  await service.adjustStock({ warehouseCode: 'WH-DUP', skuCode: 'SKU', quantity: '3', reason: 'receipt', idempotencyKey: 'dup-receipt' }, 1)
  await assert.rejects(
    () => service.reserve({ warehouseCode: 'WH-DUP', reservationKey: 'dup-res', orderRef: 'ORDER-DUP', lines: [{ skuCode: 'SKU', quantity: '2' }, { skuCode: 'SKU', quantity: '2' }] }, 1),
    error => error.code === 'warehouse_insufficient_available'
  )
  assert.equal((await service.getInventory('WH-DUP', 'SKU')).available, '3')
})

test('lists reservations by state and rejects conflicting idempotency input', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
  await service.createWarehouse({ code: 'WH-LIST', name: 'Reservation list' }, 1)
  await service.adjustStock({ warehouseCode: 'WH-LIST', skuCode: 'SKU', quantity: '5', reason: 'receipt', idempotencyKey: 'list-receipt' }, 1)
  const input = { warehouseCode: 'WH-LIST', reservationKey: 'list-res', orderRef: 'ORDER-1', lines: [{ skuCode: 'SKU', quantity: '2' }] }
  await service.reserve(input, 1)
  assert.equal((await service.listReservations('WH-LIST', 'reserved')).length, 1)
  assert.equal((await service.listReservations('WH-LIST', 'fulfilled')).length, 0)
  await assert.rejects(() => service.listReservations('WH-LIST', 'unknown'), error => error.code === 'warehouse_invalid_input')
  await assert.rejects(() => service.reserve({ ...input, orderRef: 'ORDER-2' }, 1), error => error.code === 'warehouse_duplicate_operation')
})

test('lists a bounded and normalized inventory ledger', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
  await service.createWarehouse({ code: 'WH-AUDIT', name: 'Audit warehouse' }, 7)
  await service.adjustStock({ warehouseCode: 'WH-AUDIT', skuCode: 'sku-1', quantity: '2.5', reason: 'receipt', idempotencyKey: 'audit-1', referenceKey: 'PO-1' }, 7)

  const result = await service.listLedger('WH-AUDIT', { skuCode: 'sku-1', operationType: 'receipt', page: '1', pageSize: '20' })
  assert.equal(result.total, 1)
  assert.equal(result.page, 1)
  assert.equal(result.pageSize, 20)
  assert.equal(result.items[0].skuCode, 'SKU-1')
  assert.equal(result.items[0].quantity, '2.5')
  assert.equal(result.items[0].onHandDelta, '2.5')
  await assert.rejects(() => service.listLedger('WH-AUDIT', { pageSize: '101' }), error => error.code === 'warehouse_invalid_input')
  await assert.rejects(() => service.listLedger('WH-AUDIT', { operationType: 'delete' }), error => error.code === 'warehouse_invalid_input')
})

test('blocks new inventory mutations for inactive warehouses', async () => {
  const store = repository()
  const service = createWarehouseService({ repository: store, idFactory: () => 'inactive-id' })
  await service.createWarehouse({ code: 'WH-OFF', name: 'Inactive warehouse', status: 'inactive' }, 1)
  await assert.rejects(
    () => service.adjustStock({ warehouseCode: 'WH-OFF', skuCode: 'SKU-1', quantity: '1', reason: 'receipt', idempotencyKey: 'inactive-receipt' }, 1),
    error => error.code === 'warehouse_inactive'
  )
  await assert.rejects(
    () => service.reserve({ warehouseCode: 'WH-OFF', reservationKey: 'inactive-res', orderRef: 'ORDER-1', lines: [{ skuCode: 'SKU-1', quantity: '1' }] }, 1),
    error => error.code === 'warehouse_inactive'
  )
})
