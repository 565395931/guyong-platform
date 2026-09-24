const { createBridgeGateway } = require('./bridgeGateway')
const { createBridgeRepository, createPairingService } = require('./bridgeRepository')
const { createLeaseService } = require('./leaseService')

function initDesktopBridge({ httpServer, sequelize, eventEmitter, options = {} }) {
  const repository = options.repository || createBridgeRepository(sequelize)
  const pairingService = options.pairingService || createPairingService({ repository })
  const leaseService = options.leaseService || createLeaseService({ repository })
  const gateway = createBridgeGateway({
    httpServer,
    repository,
    pairingService,
    leaseService,
    inboundService: options.inboundService,
    commandStatusService: options.commandStatusService,
    configurationProvider: options.configurationProvider,
    environment: options.environment,
    allowInsecureLan: options.allowInsecureLan,
    tlsEnabled: options.tlsEnabled,
    enabled: options.enabled !== false
  })
  gateway.start()
  return { gateway, repository, pairingService, leaseService, eventEmitter, stop: () => gateway.stop() }
}

module.exports = { initDesktopBridge }
