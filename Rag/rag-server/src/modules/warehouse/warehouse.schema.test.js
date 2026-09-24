'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { WAREHOUSE_SCHEMA_STATEMENTS, ensureWarehouseSchema } = require('./warehouse.schema')

test('creates warehouse, inventory, reservation, and ledger tables with audit indexes', async () => {
  const statements = []
  await ensureWarehouseSchema({ query: async sql => statements.push(sql) })
  assert.equal(statements.length, WAREHOUSE_SCHEMA_STATEMENTS.length)
  const sql = statements.join('\n')
  for (const table of ['warehouses', 'warehouse_inventory', 'warehouse_reservations', 'warehouse_inventory_ledger']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'))
  }
  assert.match(sql, /UNIQUE KEY uk_warehouse_inventory_item/i)
  assert.match(sql, /UNIQUE KEY uk_warehouse_operation/i)
  assert.match(sql, /reserved_quantity/i)
})
