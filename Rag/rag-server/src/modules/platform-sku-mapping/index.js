'use strict'

const { sequelize } = require('../../config/database')
const { ensurePlatformSkuMappingSchema } = require('./platformSkuMapping.schema')
const { createPlatformSkuMappingRepository } = require('./platformSkuMapping.repository')
const { createPlatformSkuMappingService } = require('./platformSkuMapping.service')
const { createPlatformSkuMappingRouter } = require('./platformSkuMapping.routes')

const repository = createPlatformSkuMappingRepository(sequelize)
const service = createPlatformSkuMappingService({ repository })

module.exports = createPlatformSkuMappingRouter({ service })
module.exports.ensurePlatformSkuMappingSchema = ensurePlatformSkuMappingSchema
module.exports.createPlatformSkuMappingRepository = createPlatformSkuMappingRepository
module.exports.createPlatformSkuMappingService = createPlatformSkuMappingService
