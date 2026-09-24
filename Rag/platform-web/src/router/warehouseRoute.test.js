import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('warehouse workspace is registered for supervisor and admin users', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')
  assert.match(source, /path: 'warehouses'/)
  assert.match(source, /WarehouseView\.vue/)
  assert.match(source, /requiredRoles: \['supervisor', 'admin'\]/)
})

test('warehouse workspace is visible in system navigation', () => {
  const sidebar = readFileSync(fileURLToPath(new URL('../modules/navigation/channelNavigation.js', import.meta.url)), 'utf8')
  assert.match(sidebar, /path: '\/warehouses'/)
  assert.match(sidebar, /label: '仓库与库存'/)
  assert.match(sidebar, /icon: 'Box'/)
})
