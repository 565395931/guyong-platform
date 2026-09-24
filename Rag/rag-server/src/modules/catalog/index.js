const { sequelize } = require('../../config/database')
const { createRepository } = require('./catalog.repository')
const { createCatalogService } = require('./catalog.service')
const { createImportService } = require('./catalog.import.service')
const { createQuoteService } = require('./quote.service')
const { createCatalogRouter } = require('./catalog.routes')

const repository = createRepository(sequelize)
const catalogService = createCatalogService({ repository })
const importService = createImportService({ repository, catalogService })
const quoteService = createQuoteService({ repository })

module.exports = createCatalogRouter({ catalogService, importService, quoteService })
