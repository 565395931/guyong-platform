'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const dotenv = require('dotenv')
const { runRealWarehouseConcurrencyTest } = require('./warehouse.mysqlConcurrency')

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

test('real MySQL dual connections serialize competing reservations', { timeout: 30_000 }, async t => {
  if (process.env.RUN_REAL_MYSQL !== '1') {
    t.skip('set RUN_REAL_MYSQL=1 to run against an isolated MySQL database')
    return
  }
  const evidence = await runRealWarehouseConcurrencyTest()
  assert.deepEqual(evidence, {
    database: evidence.database,
    firstResult: 'reserved',
    secondResult: 'rejected',
    finalReserved: '1.000'
  })
  assert.match(evidence.database, /^warehouse_it_\d+_[a-f0-9]{6}$/)
})
