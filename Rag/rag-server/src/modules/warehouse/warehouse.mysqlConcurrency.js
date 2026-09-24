'use strict'

const crypto = require('node:crypto')
const mysql = require('mysql2/promise')
const { WAREHOUSE_SCHEMA_STATEMENTS } = require('./warehouse.schema')

function databaseName() {
  return `warehouse_it_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function connectionConfig(environment, database) {
  const config = {
    host: environment.DB_HOST || '127.0.0.1',
    port: Number(environment.DB_PORT || 3306),
    user: environment.DB_USER,
    password: environment.DB_PASSWORD,
    multipleStatements: false
  }
  if (database) config.database = database
  return config
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function runRealWarehouseConcurrencyTest({ environment = process.env, keepDatabase = false } = {}) {
  if (!environment.DB_USER || environment.DB_PASSWORD == null) {
    throw new Error('DB_USER and DB_PASSWORD are required for the real MySQL test')
  }

  const database = databaseName()
  const admin = await mysql.createConnection(connectionConfig(environment))
  const connections = []
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    const schema = await mysql.createConnection(connectionConfig(environment, database))
    connections.push(schema)
    for (const statement of WAREHOUSE_SCHEMA_STATEMENTS) await schema.query(statement)

    const warehouseId = crypto.randomUUID()
    const skuCode = 'CONCURRENCY-SKU'
    await schema.query(
      `INSERT INTO warehouses (id, code, name, status) VALUES (?, ?, ?, 'active')`,
      [warehouseId, `IT-${warehouseId.slice(0, 8)}`, 'Concurrency test warehouse']
    )
    await schema.query(
      `INSERT INTO warehouse_inventory (id, warehouse_id, sku_code, on_hand_quantity, reserved_quantity)
       VALUES (?, ?, ?, 1, 0)`,
      [crypto.randomUUID(), warehouseId, skuCode]
    )

    const first = await mysql.createConnection(connectionConfig(environment, database))
    const second = await mysql.createConnection(connectionConfig(environment, database))
    connections.push(first, second)
    await first.beginTransaction()
    const [firstRows] = await first.query(
      `SELECT on_hand_quantity AS onHand, reserved_quantity AS reserved
         FROM warehouse_inventory WHERE warehouse_id=? AND sku_code=? FOR UPDATE`,
      [warehouseId, skuCode]
    )
    if (firstRows.length !== 1 || Number(firstRows[0].onHand) - Number(firstRows[0].reserved) < 1) {
      throw new Error('first connection could not read available inventory')
    }

    await second.beginTransaction()
    const secondRead = second.query(
      `SELECT on_hand_quantity AS onHand, reserved_quantity AS reserved
         FROM warehouse_inventory WHERE warehouse_id=? AND sku_code=? FOR UPDATE`,
      [warehouseId, skuCode]
    )
    const lockRace = await Promise.race([
      secondRead.then(() => 'resolved'),
      sleep(150).then(() => 'blocked')
    ])
    if (lockRace !== 'blocked') throw new Error('second connection did not block on FOR UPDATE')

    await first.query(
      `UPDATE warehouse_inventory SET reserved_quantity=reserved_quantity+1 WHERE warehouse_id=? AND sku_code=?`,
      [warehouseId, skuCode]
    )
    await first.commit()

    const [secondRows] = await secondRead
    const secondAvailable = Number(secondRows[0].onHand) - Number(secondRows[0].reserved)
    let secondResult = 'rejected'
    if (secondAvailable >= 1) {
      await second.query(
        `UPDATE warehouse_inventory SET reserved_quantity=reserved_quantity+1 WHERE warehouse_id=? AND sku_code=?`,
        [warehouseId, skuCode]
      )
      secondResult = 'reserved'
      await second.commit()
    } else {
      await second.rollback()
    }

    const [finalRows] = await schema.query(
      `SELECT on_hand_quantity AS onHand, reserved_quantity AS reserved
         FROM warehouse_inventory WHERE warehouse_id=? AND sku_code=?`,
      [warehouseId, skuCode]
    )
    const finalReserved = String(finalRows[0]?.reserved || '0')
    if (secondResult !== 'rejected' || finalReserved !== '1.000') {
      throw new Error(`concurrency invariant failed: second=${secondResult}, reserved=${finalReserved}`)
    }
    return Object.freeze({ database, firstResult: 'reserved', secondResult, finalReserved })
  } finally {
    for (const connection of connections.reverse()) await connection.end().catch(() => {})
    if (!keepDatabase) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {})
    await admin.end().catch(() => {})
  }
}

module.exports = { runRealWarehouseConcurrencyTest }
