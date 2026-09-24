'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

test('warehouse schema is wired into database startup and router is mounted', () => {
  const database = readFileSync(require.resolve('../../config/database'), 'utf8')
  const app = readFileSync(require.resolve('../../app'), 'utf8')
  assert.match(database, /require\('\.\.\/modules\/warehouse\/warehouse\.schema'\)/)
  assert.match(database, /await ensureWarehouseSchema\(sequelize\)/)
  assert.match(app, /require\('\.\/modules\/warehouse'\)/)
  assert.match(app, /app\.use\('\/api\/v1\/warehouses', warehouseRoutes\)/)
})
