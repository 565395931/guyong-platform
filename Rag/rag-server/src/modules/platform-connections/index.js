const { sequelize } = require('../../config/database')
const { createCredentialCipher } = require('./credentialCipher')
const { createPlatformConnectionsRepository } = require('./platformConnections.repository')
const { createWecomClient } = require('./wecomClient')
const { createPlatformConnectionsService } = require('./platformConnections.service')
const { createPlatformConnectionsRouter } = require('./platformConnections.routes')
const { createRuntimeConfigCipher } = require('./runtimeConfigCipher')
const { createRuntimeConfigPublisher } = require('./runtimeConfigPublisher')
const { getGatewayLink } = require('../cloud-gateway/runtime')

const repository = createPlatformConnectionsRepository(sequelize)
const credentialCipher = createCredentialCipher()
const wecomClient = createWecomClient()
const runtimeConfigPublisher = process.env.WECOM_RUNTIME_CONFIG_KEY
  ? createRuntimeConfigPublisher({
      getLink: getGatewayLink,
      cipher: createRuntimeConfigCipher({ key: process.env.WECOM_RUNTIME_CONFIG_KEY })
    })
  : null
const service = createPlatformConnectionsService({
  repository,
  credentialCipher,
  wecomClient,
  runtimeConfigPublisher,
  publicCallbackBaseUrl: process.env.WECOM_PUBLIC_CALLBACK_BASE_URL || '',
  protectedAccountNames: String(process.env.WECOM_PROTECTED_ACCOUNT_NAMES || '客服1号')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
})

module.exports = createPlatformConnectionsRouter({ service })
