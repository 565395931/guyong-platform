'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWarehouseRepository } = require('./warehouse.repository')

test('forwards transaction context and row locks inventory and reservations', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options) {
      calls.push({ sql, options })
      return [[]]
    },
    async transaction(callback) { return callback('tx-1') }
  }
  const repository = createWarehouseRepository(sequelize)
  await repository.withTransaction(async store => {
    await store.getInventory('warehouse-1', 'SKU-1')
    await store.findReservation('reservation-1')
  })

  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /FOR UPDATE$/)
  assert.match(calls[1].sql, /FOR UPDATE$/)
  assert.equal(calls[0].options.transaction, 'tx-1')
  assert.equal(calls[1].options.transaction, 'tx-1')
})

test('covers warehouse repository CRUD and ledger persistence contracts', async () => {
  const calls = []
  const sequelize = {
    async query(sql, options) {
      calls.push({ sql, options })
      if (sql.includes('FROM warehouses') && sql.includes('WHERE code')) return [[{ id: 'w-1', code: 'WH-1', name: 'Main', status: 'active' }]]
      if (sql.includes('FROM warehouses') && sql.includes('WHERE id')) return [[{ id: 'w-1', code: 'WH-1', status: 'active' }]]
      if (sql.includes('FROM warehouse_inventory_ledger')) return [[{ id: 'l-1', operationKey: 'op-1' }]]
      if (sql.includes('FROM warehouse_reservations')) return [[{ id: 'r-1', reservationKey: 'res-1', lines: '[{"skuCode":"SKU-1","quantity":"1"}]' }]]
      return [[]]
    }
  }
  const repository = createWarehouseRepository(sequelize)
  await repository.createWarehouse({ id: 'w-1', code: 'WH-1', name: 'Main', status: 'active', createdBy: 'user-1' })
  await repository.listWarehouses()
  assert.equal((await repository.findWarehouse('WH-1')).id, 'w-1')
  assert.equal((await repository.findWarehouseById('w-1')).id, 'w-1')
  await repository.getInventory('w-1', 'SKU-1')
  await repository.listInventory('w-1')
  await repository.saveInventory({ id: 'i-1', warehouseId: 'w-1', skuCode: 'SKU-1', onHand: 1000n, reserved: 0n })
  assert.equal((await repository.findLedgerByOperationKey('op-1')).id, 'l-1')
  await repository.appendLedger({ id: 'l-1', warehouseId: 'w-1', skuCode: 'SKU-1', operationKey: 'op-1', operationType: 'receipt', onHandDelta: 1000n, reservedDelta: 0n, quantity: 1000n, metadata: { source: 'test' } })
  assert.equal((await repository.findReservation('res-1')).lines[0].skuCode, 'SKU-1')
  assert.equal((await repository.listReservations('w-1')).length, 1)
  await repository.saveReservation({ id: 'r-1', reservationKey: 'res-1', orderRef: 'order-1', warehouseId: 'w-1', status: 'reserved', lines: [{ skuCode: 'SKU-1', quantity: '1' }] })
  assert.equal(calls.length, 12)
})

test('lists inventory ledger with parameterized filters and bounded pagination', async () => {
  const calls = []
  const sequelize = { async query(sql, options) { calls.push({ sql, options }); return sql.startsWith('SELECT COUNT') ? [[{ total: 1 }]] : [[{ operationKey: 'op-1' }]] } }
  const repository = createWarehouseRepository(sequelize)
  const result = await repository.listLedger('w-1', { skuCode: 'SKU-1', operationType: 'receipt', page: 2, pageSize: 25 })
  assert.equal(result.total, 1)
  assert.equal(result.rows[0].operationKey, 'op-1')
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /sku_code = :skuCode/)
  assert.match(calls[0].sql, /operation_type = :operationType/)
  assert.match(calls[0].sql, /LIMIT :limit OFFSET :offset/)
  assert.deepEqual(calls[0].options.replacements, { warehouseId: 'w-1', skuCode: 'SKU-1', operationType: 'receipt', limit: 25, offset: 25 })
})

test('persists scaled quantities as exact decimal values', async () => {
  const calls = []
  const sequelize = { async query(sql, options) { calls.push({ sql, options }); return [[]] } }
  const repository = createWarehouseRepository(sequelize)
  await repository.saveInventory({ id: 'i-1', warehouseId: 'w-1', skuCode: 'SKU-1', onHand: 2500n, reserved: 125n })
  await repository.appendLedger({ id: 'l-1', warehouseId: 'w-1', skuCode: 'SKU-1', operationKey: 'op-1', operationType: 'receipt', onHandDelta: 2500n, reservedDelta: -125n, quantity: 2500n, referenceKey: null, metadata: null, createdBy: 7 })
  assert.equal(calls[0].options.replacements.onHand, '2.5')
  assert.equal(calls[0].options.replacements.reserved, '0.125')
  assert.equal(calls[1].options.replacements.onHandDelta, '2.5')
  assert.equal(calls[1].options.replacements.reservedDelta, '-0.125')
  assert.equal(calls[1].options.replacements.quantity, '2.5')
})
