import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('warehouse API uses encoded resource paths and exposes the MVP operations', () => {
  const source = readFileSync(fileURLToPath(new URL('./warehouses.js', import.meta.url)), 'utf8')
  for (const name of ['getWarehouses', 'createWarehouse', 'getWarehouseInventory', 'adjustWarehouseInventory', 'reserveWarehouseStock', 'getWarehouseReservations', 'getWarehouseLedger', 'releaseWarehouseReservation', 'fulfillWarehouseReservation']) {
    assert.match(source, new RegExp(`export function ${name}`))
  }
  assert.match(source, /encodeURIComponent\(code\)/)
  assert.match(source, /encodeURIComponent\(key\)/)
  assert.match(source, /URLSearchParams/)
})
