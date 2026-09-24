const GatewayLink = require('./gatewayLink')
const GatewayInboundHandler = require('./gatewayInbound')
const GatewayOutboundDispatcher = require('./gatewayOutboundDispatcher')
const GatewayAccountMapper = require('./gatewayAccount')
const { createAck } = require('./gatewayProtocol')
const { setDispatcher, setGatewayLink } = require('./runtime')
const { INTERNAL_EVENTS } = require('../websocket/events')

function initCloudGateway({ eventEmitter, accountEntries = [], options = {} } = {}) {
  const accountMapper = new GatewayAccountMapper(accountEntries)
  const link = options.link || new GatewayLink(options)
  const platformConnectionsRepository = options.platformConnectionsRepository || null
  const updateMessageStatus = options.updateMessageStatus || (async payload => {
    const { sequelize } = require('../../config/database')
    const [updateResult, updateMetadata] = await sequelize.query(
      `UPDATE plat_messages
       SET send_status = :sendStatus,
           channel_message_id = COALESCE(:channelMessageId, channel_message_id),
           updated_at = NOW()
       WHERE id = :localMessageId`,
      {
        replacements: {
          sendStatus: payload.sendStatus,
          channelMessageId: payload.channelMessageId || null,
          localMessageId: payload.localMessageId || payload.commandId
        }
      }
    )
    return updateMetadata?.affectedRows ?? updateResult?.affectedRows ?? 0
  })
  setGatewayLink(link)
  const inbound = new GatewayInboundHandler({
    eventEmitter,
    accountMapper,
    accountLoader: options.accountLoader,
    afterProcessed: async ({ message }) => {
      if (message?.channel !== 'wecom_kf' || !message?.metadata?.connectionId || !message?.accountId) return
      const repository = platformConnectionsRepository || (() => {
        const { createPlatformConnectionsRepository } = require('../platform-connections/platformConnections.repository')
        const { sequelize } = require('../../config/database')
        return createPlatformConnectionsRepository(sequelize)
      })()
      await repository.markWecomInbound({
        connectionId: message.metadata.connectionId,
        accountId: message.accountId,
        occurredAt: new Date(message.clientTimestamp || Date.now())
      })
    }
  })
  link.on('inbound', envelope => {
    inbound.handle(envelope).then(ack => link.send(ack)).catch(error => link.emit('error', error))
  })
  const dispatcher = new GatewayOutboundDispatcher({
    cloudLink: link,
    useCloud: payload => Boolean(options.enabled && (payload.channel === 'wecom_kf' || accountMapper.has(payload.accountId))),
    gatewayAccountResolver: accountId => accountMapper.resolveByAccountId(accountId),
    adapterResolver: channel => require('../channel-adapters').getAdapterByChannel(channel)
  })
  link.on('status', async envelope => {
    const payload = envelope.payload || {}
    const sendStatus = payload.status === 'failed' ? 'failed' : payload.status === 'sent' ? 'sent' : 'received'
    try {
      const affectedRows = await updateMessageStatus({ ...payload, sendStatus })
      if (affectedRows === 0) throw new Error('cloud gateway status target message was not found')
      if (payload.status === 'sent' && payload.channel === 'wecom_kf' && payload.accountId) {
        const repository = platformConnectionsRepository || (() => {
          const { createPlatformConnectionsRepository } = require('../platform-connections/platformConnections.repository')
          const { sequelize } = require('../../config/database')
          return createPlatformConnectionsRepository(sequelize)
        })()
        await repository.markWecomOutbound({
          accountId: payload.accountId,
          occurredAt: new Date(payload.serverTimestamp || payload.sentAt || Date.now())
        })
      }
      eventEmitter?.emit?.(INTERNAL_EVENTS.MESSAGE_UPDATE, {
        conversationId: payload.conversationId,
        messageId: payload.localMessageId,
        commandId: payload.commandId,
        sendStatus,
        channelMessageId: payload.channelMessageId || null,
        errorCode: payload.errorCode || null,
        errorMessage: payload.errorMessage || null
      })
      if (envelope.eventId) link.send(createAck(envelope.eventId, 'processed', {
        localMessageId: payload.localMessageId,
        sendStatus
      }))
    } catch (error) {
      eventEmitter?.emit?.('cloud_gateway_status_error', { error: error.message, commandId: payload.commandId })
      if (envelope.eventId) {
        try {
          link.send(createAck(envelope.eventId, 'retryable_error', { errorCode: 'STATUS_UPDATE_FAILED' }))
        } catch (sendError) {
          link.emit('error', sendError)
        }
      }
    }
  })
  setDispatcher(dispatcher)
  if (options.enabled) link.start()
  return { link, inbound, dispatcher, accountMapper }
}

module.exports = { GatewayLink, GatewayInboundHandler, GatewayOutboundDispatcher, GatewayAccountMapper, initCloudGateway }
