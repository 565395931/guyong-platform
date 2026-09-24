'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const dotenv = require('dotenv')
const { Sequelize } = require('sequelize')
const { ensureWarehouseSchema } = require('../warehouse/warehouse.schema')
const { createWarehouseRepository } = require('../warehouse/warehouse.repository')
const { createWarehouseService } = require('../warehouse/warehouse.service')
const { ensurePlatformSkuMappingSchema } = require('../platform-sku-mapping/platformSkuMapping.schema')
const { createPlatformSkuMappingRepository } = require('../platform-sku-mapping/platformSkuMapping.repository')
const { createPlatformSkuMappingService } = require('../platform-sku-mapping/platformSkuMapping.service')
const { ensureOrderFulfillmentSchema } = require('./orderFulfillment.schema')
const { createOrderFulfillmentRepository } = require('./orderFulfillment.repository')
const { createOrderFulfillmentService } = require('./orderFulfillment.service')

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

function databaseName() { return `fulfillment_it_${Date.now()}_${crypto.randomBytes(3).toString('hex')}` }

test('real MySQL supports mapped order allocation, shipment, and writeback outbox', { timeout: 30_000 }, async t => {
  if (process.env.RUN_REAL_MYSQL !== '1') {
    t.skip('set RUN_REAL_MYSQL=1 to run against an isolated MySQL database')
    return
  }
  const database = databaseName()
  const admin = new Sequelize('mysql', process.env.DB_USER, process.env.DB_PASSWORD, { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), dialect: 'mysql', logging: false })
  const sequelize = new Sequelize(database, process.env.DB_USER, process.env.DB_PASSWORD, { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), dialect: 'mysql', logging: false })
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await ensureWarehouseSchema(sequelize)
    await ensurePlatformSkuMappingSchema(sequelize)
    await ensureOrderFulfillmentSchema(sequelize)
    await sequelize.query(`CREATE TABLE order_items (id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, external_sku VARCHAR(191), sku_code VARCHAR(100), quantity DECIMAL(12,3) NOT NULL, sort_order INT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    await sequelize.query(`CREATE TABLE orders (id VARCHAR(36) PRIMARY KEY, order_no VARCHAR(40) NOT NULL, channel VARCHAR(30), account_id INT, raw_payload JSON, status VARCHAR(30), updated_by INT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    await sequelize.query(`CREATE TABLE order_shipments (id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36), shipment_type VARCHAR(30), courier VARCHAR(120), tracking_no VARCHAR(160), status VARCHAR(30), shipped_at DATETIME, metadata JSON, created_at DATETIME, updated_at DATETIME)`)

    const warehouseRepository = createWarehouseRepository(sequelize)
    const warehouseService = createWarehouseService({ repository: warehouseRepository })
    const mappingService = createPlatformSkuMappingService({ repository: createPlatformSkuMappingRepository(sequelize) })
    const repository = createOrderFulfillmentRepository(sequelize)
    const service = createOrderFulfillmentService({
      repository,
      warehouseService,
      skuMappingService: mappingService,
      writebackAdapter: { writeShipment: async () => ({ accepted: true }) }
    })

    const warehouseId = crypto.randomUUID()
    await sequelize.query('INSERT INTO warehouses (id, code, name, status) VALUES (:id, :code, :name, \'active\')', { replacements: { id: warehouseId, code: 'WH-IT', name: 'Integration warehouse' } })
    await sequelize.query('INSERT INTO warehouse_inventory (id, warehouse_id, sku_code, on_hand_quantity, reserved_quantity) VALUES (:id, :warehouseId, :skuCode, 2, 0)', { replacements: { id: crypto.randomUUID(), warehouseId, skuCode: 'SKU-001' } })
    await mappingService.upsert({ channel: 'taobao', accountId: 7, externalSku: 'TB-001', internalSkuCode: 'SKU-001', operatorId: 1 })
    const orderId = crypto.randomUUID()
    await sequelize.query('INSERT INTO orders (id, order_no, channel, account_id, raw_payload, status) VALUES (:id, :orderNo, :channel, :accountId, :rawPayload, :status)', { replacements: { id: orderId, orderNo: 'SO-IT-1', channel: 'taobao', accountId: 7, rawPayload: JSON.stringify({ externalOrderId: 'TB-IT-1' }), status: 'paid' } })
    await sequelize.query('INSERT INTO order_items (id, order_id, external_sku, quantity) VALUES (:id, :orderId, :externalSku, :quantity)', { replacements: { id: crypto.randomUUID(), orderId, externalSku: 'TB-001', quantity: 2 } })

    const reserved = await service.reserve({ orderId, warehouseCode: 'WH-IT', idempotencyKey: 'alloc-1', operatorId: 1 })
    const shipped = await service.ship({ orderId, courier: 'STO', trackingNo: 'ST-IT-1', operatorId: 1 })
    assert.equal(reserved.status, 'reserved')
    assert.equal(shipped.status, 'shipped')
    assert.equal(shipped.writebackStatus, 'succeeded')
    const [inventory] = await sequelize.query('SELECT on_hand_quantity, reserved_quantity FROM warehouse_inventory WHERE warehouse_id=:warehouseId AND sku_code=:skuCode', { replacements: { warehouseId, skuCode: 'SKU-001' } })
    const [shipments] = await sequelize.query('SELECT tracking_no, status FROM order_shipments WHERE order_id=:orderId', { replacements: { orderId } })
    const [outbox] = await sequelize.query('SELECT status, event_type FROM fulfillment_writeback_outbox WHERE fulfillment_id=:fulfillmentId', { replacements: { fulfillmentId: reserved.id } })
    assert.equal(String(inventory[0].on_hand_quantity), '0.000')
    assert.equal(String(inventory[0].reserved_quantity), '0.000')
    assert.deepEqual(shipments[0], { tracking_no: 'ST-IT-1', status: 'shipped' })
    assert.deepEqual(outbox[0], { status: 'succeeded', event_type: 'shipment.created' })
  } finally {
    await sequelize.close().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {})
    await admin.close().catch(() => {})
  }
})
