const crypto = require('crypto')

function reject(code, message) { throw Object.assign(new Error(message), { code }) }

// Trusted account bindings are supplied by the control plane, never by an inbound callback.
// This adapter does not publish credentials or browser-only media URLs to Rag.
class ShopGatewayAdapter {
  constructor({ store, messaging, gateway, bindings = [], exportImage, imageReference }) {
    this.store = store
    this.messaging = messaging
    this.gateway = gateway
    this.exportImage = exportImage
    this.imageReference = imageReference
    this.bindings = bindings
    const installations = new Set()
    const accounts = new Set()
    for (const binding of bindings) {
      if (!binding.tenantId || !binding.installationId || !Number.isSafeInteger(binding.accountId) || binding.accountId <= 0 || installations.has(binding.installationId) || accounts.has(binding.accountId)) {
        reject('shop_binding_invalid', 'Each shop must have one unique local account binding')
      }
      installations.add(binding.installationId)
      accounts.add(binding.accountId)
    }
  }

  async context(messageId) {
    const data = await this.store.snapshot()
    const message = data.messages.find(item => item.id === messageId && item.channel === 'wechat_shop' && item.direction === 'inbound')
    const conversation = data.conversations.find(item => item.id === message?.conversationId)
    const binding = this.bindings.find(item => item.installationId === conversation?.installationId && item.tenantId === conversation?.tenantId)
    if (!message || !binding || message.tenantId !== binding.tenantId || message.installationId !== binding.installationId) reject('shop_binding_missing', 'Shop message has no authorized local account binding')
    return { message, conversation, binding }
  }

  async ingest(messageId) {
    const { message, conversation, binding } = await this.context(messageId)
    const eventId = 'shop-' + crypto.createHash('sha256').update(`${binding.installationId}:${message.channelMessageId}`).digest('hex')
    const existing = await this.gateway.store?.getEvent(eventId)
    if (existing) return this.gateway.ingestInbound(existing.payload, eventId)
    const content = { text: message.text || '' }
    if (message.messageType === 'image') {
      if (this.imageReference) {
        const reference = await this.imageReference(message)
        if (!reference?.url) reject('shop_media_export_failed', 'Private media reference is missing')
        content.url = reference.url
      } else {
      if (!this.exportImage) reject('shop_media_export_required', 'A private local media exporter is required for images')
      const image = await this.messaging.image(message.id)
      // Stable ID lets the exporter reuse the same local asset on replay.
      const exported = await this.exportImage({ id: message.id, accountId: binding.accountId, ...image })
      if (!exported?.url) reject('shop_media_export_failed', 'Local media export failed')
      content.url = exported.url
      content.mimeType = image.contentType
      }
    }
    if (message.shopDetails) content.shopDetails = message.shopDetails
    const payload = {
      channel: 'wechat_shop', accountId: binding.accountId,
      gatewayAccountId: binding.installationId,
      channelUserId: conversation.externalUserId,
      channelMessageId: message.channelMessageId,
      userName: `客户 ${conversation.externalUserId.slice(-6)}`,
      messageType: message.messageType === 'voice' ? 'audio' : message.messageType,
      content, clientTimestamp: message.createdAt,
      metadata: {
        cloudConversationId: conversation.id, cloudMessageId: message.id,
        shopInstallationId: binding.installationId,
        customerIdentitySource: 'openid',
        unionId: conversation.unionId || null
      }
    }
    // Rag persists content JSON; top-level metadata alone would be lost after restart.
    payload.content.shopContext = payload.metadata
    // Same platform message maps to the same durable gateway event after restart.
    return this.gateway.ingestInbound(payload, eventId)
  }

  async send(command) {
    const payload = command.payload || {}
    const binding = this.bindings.find(item => item.accountId === Number(payload.accountId) && item.installationId === payload.gatewayAccountId)
    if (!binding || payload.channel !== 'wechat_shop') reject('shop_binding_missing', 'Outgoing account binding does not match')
    if (!command.commandId || payload.messageType !== 'text' || typeof payload.content?.text !== 'string' || !payload.content.text.trim()) reject('shop_reply_invalid', 'Only text replies with a stable command ID are supported')
    const data = await this.store.snapshot()
    // Local conversation UUID is not a cloud conversation UUID. Resolve by trusted
    // shop binding and OpenID instead of accepting a client-supplied cloud ID.
    const conversation = data.conversations.find(item => item.channel === 'wechat_shop' && item.tenantId === binding.tenantId && item.installationId === binding.installationId && item.externalUserId === payload.targetUserId)
    if (!conversation) reject('shop_conversation_missing', 'Reply target does not belong to this shop')
    try {
      const result = await this.messaging.sendReply(conversation.id, payload.content.text, 'local-workbench', command.commandId, binding.installationId)
      return { success: true, status: 'sent', channelMessageId: result.channelMessageId }
    } catch (error) {
      if (error.code === 'shop_transport_error') return { success: false, status: 'unknown', errorCode: 'SEND_STATUS_UNKNOWN', errorMessage: '平台回复超时，发送结果待确认，请勿重复发送' }
      throw error
    }
  }
}

module.exports = { ShopGatewayAdapter }
