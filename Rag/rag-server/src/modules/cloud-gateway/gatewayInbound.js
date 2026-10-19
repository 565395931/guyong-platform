const { createAck } = require('./gatewayProtocol')

class GatewayInboundHandler {
  constructor({ messagingService, inboundPostProcessor, eventEmitter, accountMapper, accountLoader, afterProcessed, allowShopAutoReply = false }) {
    this.messagingService = messagingService
    this.inboundPostProcessor = inboundPostProcessor
    this.eventEmitter = eventEmitter
    this.accountMapper = accountMapper
    this.accountLoader = accountLoader
    this.afterProcessed = afterProcessed
    this.allowShopAutoReply = allowShopAutoReply
  }

  async handle(envelope) {
    const message = envelope.payload || {}
    let mapping = null
    if (message.accountId) {
      mapping = this.accountMapper?.resolveByAccountId?.(message.accountId) ||
        (this.accountMapper?.has?.(message.accountId) ? { accountId: Number(message.accountId) } : null)
    }
    if (!mapping && message.accountId && this.accountLoader) {
      mapping = await this.accountLoader(message.accountId)
      if (mapping) this.accountMapper?.set?.(mapping)
    }
    if (!message.accountId || !mapping) {
      return createAck(envelope.eventId, 'rejected', { reason: 'unknown accountId' })
    }
    if ((mapping.channel && mapping.channel !== message.channel) ||
        (message.gatewayAccountId && mapping.gatewayAccountId !== message.gatewayAccountId)) {
      return createAck(envelope.eventId, 'rejected', { reason: 'account binding mismatch' })
    }
    try {
      const service = this.messagingService || require('../messaging/messaging.service')
      const result = await service.processIncomingMessage(message, this.eventEmitter)
      if (!result?.duplicate) {
        message.conversationId = result?.conversationId || message.conversationId
        const postProcessor = this.inboundPostProcessor || require('../messaging/inboundMessage.service').processInboundMessageAfterStore
        await postProcessor(message, this.eventEmitter, {
          source: 'cloud_gateway',
          eventId: envelope.eventId,
          ...(message.channel === 'wechat_shop' ? { allowAutoReply: this.allowShopAutoReply === true } : {})
        })
        if (this.afterProcessed) {
          await this.afterProcessed({ envelope, message, mapping, result })
        }
      }
      return createAck(envelope.eventId, result?.duplicate ? 'duplicate' : 'processed', {
        messageId: result?.id || result?.messageId,
        conversationId: result?.conversationId,
        duplicate: Boolean(result?.duplicate)
      })
    } catch (error) {
      return createAck(envelope.eventId, 'retryable_error', { error: error.message })
    }
  }
}

module.exports = GatewayInboundHandler
