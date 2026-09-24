const { createSendCommand } = require('./gatewayProtocol')

class GatewayOutboundDispatcher {
  constructor({ cloudLink = null, adapterResolver = null, useCloud = () => false, gatewayAccountResolver = () => null }) {
    this.cloudLink = cloudLink
    this.adapterResolver = adapterResolver
    this.useCloud = useCloud
    this.gatewayAccountResolver = gatewayAccountResolver
  }

  async dispatch(message) {
    const payload = {
      commandId: message.commandId || message.localMessageId,
      conversationId: message.conversationId,
      localMessageId: message.localMessageId,
      channel: message.channel,
      accountId: message.accountId,
      gatewayAccountId: message.gatewayAccountId || this.gatewayAccountResolver(message.accountId)?.gatewayAccountId,
      targetUserId: message.targetUserId,
      messageType: message.messageType || 'text',
      content: message.content || {},
      replyToChannelMessageId: message.replyToChannelMessageId || null
    }
    if (this.cloudLink && this.useCloud(payload)) {
      const command = createSendCommand(payload)
      await this.cloudLink.send(command)
      return { success: true, status: 'accepted', commandId: command.commandId, transport: 'cloud_gateway' }
    }
    const adapter = this.adapterResolver?.(message.channel)
    // 保持现有未实现渠道行为：没有本地适配器时不伪造平台失败，等待未来渠道接入。
    if (!adapter) return { success: true, status: 'sent', transport: 'noop' }
    const result = await adapter.sendMessage(message.accountId, message.targetUserId, {
      content: payload.content,
      messageType: payload.messageType
    })
    return { ...result, status: result.success ? 'sent' : 'failed', transport: 'local_adapter' }
  }
}

module.exports = GatewayOutboundDispatcher
