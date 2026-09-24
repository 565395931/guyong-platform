'use strict'

const { sequelize } = require('../../config/database')
const { createWarehouseRepository } = require('./warehouse.repository')
const { createWarehouseService } = require('./warehouse.service')
const { createWarehouseRouter } = require('./warehouse.routes')

const repository = createWarehouseRepository(sequelize)
const service = createWarehouseService({ repository })

module.exports = createWarehouseRouter({ service })
module.exports.createWarehouseRepository = createWarehouseRepository
module.exports.createWarehouseService = createWarehouseService
module.exports.createWarehouseRouter = createWarehouseRouter
