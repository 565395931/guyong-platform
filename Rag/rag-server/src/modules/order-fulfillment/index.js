'use strict'

const { sequelize } = require('../../config/database')
const { createWarehouseRepository } = require('../warehouse/warehouse.repository')
const { createWarehouseService } = require('../warehouse/warehouse.service')
const { createPlatformSkuMappingRepository } = require('../platform-sku-mapping/platformSkuMapping.repository')
const { createPlatformSkuMappingService } = require('../platform-sku-mapping/platformSkuMapping.service')
const { ensureOrderFulfillmentSchema } = require('./orderFulfillment.schema')
const { createOrderFulfillmentRepository } = require('./orderFulfillment.repository')
const { createOrderFulfillmentService } = require('./orderFulfillment.service')
const { createOrderFulfillmentRouter } = require('./orderFulfillment.routes')

const warehouseService = createWarehouseService({ repository: createWarehouseRepository(sequelize) })
const skuMappingService = createPlatformSkuMappingService({ repository: createPlatformSkuMappingRepository(sequelize) })
const repository = createOrderFulfillmentRepository(sequelize)
const service = createOrderFulfillmentService({ repository, warehouseService, skuMappingService })

module.exports = createOrderFulfillmentRouter({ service })
module.exports.ensureOrderFulfillmentSchema = ensureOrderFulfillmentSchema
module.exports.createOrderFulfillmentService = createOrderFulfillmentService
module.exports.createOrderFulfillmentRepository = createOrderFulfillmentRepository
