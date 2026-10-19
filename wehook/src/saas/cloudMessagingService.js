const crypto = require('crypto')

function fail(message, code) { throw Object.assign(new Error(message), { code }) }
function cleanText(value, limit = 4000) { return String(value || '').trim().slice(0, limit) }
function imageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

class CloudMessagingService {
  constructor({ store, cipher, modelClient, wecomSender, now = () => new Date().toISOString() }) {
    this.store = store
    this.cipher = cipher
    this.modelClient = modelClient
    this.wecomSender = {
      async sendText() { fail('企业微信尚未完成授权，暂时不能真实发送', 'wecom_not_ready') },
      async downloadMedia() { fail('企业微信媒体读取尚未完成授权', 'wecom_not_ready') },
      ...(wecomSender || {})
    }
    this.now = now
  }

  publicModelConfig(config) {
    if (!config) return { configured: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, maxTokens: 2000, systemPrompt: '你是专业、克制的企业客服。只根据已知信息回答；不确定时建议转人工。' }
    return { id: config.id, configured: Boolean(config.apiKeyEncrypted), baseUrl: config.baseUrl, model: config.model, visionBaseUrl: config.visionBaseUrl || '', visionModel: config.visionModel || '', visionKeyConfigured: Boolean(config.visionApiKeyEncrypted), temperature: config.temperature, maxTokens: config.maxTokens, systemPrompt: config.systemPrompt, apiKeyPreview: config.apiKeyPreview, lastTestedAt: config.lastTestedAt || null, lastTestStatus: config.lastTestStatus || 'untested', updatedAt: config.updatedAt }
  }

  async getModelConfig() {
    const data = await this.store.snapshot()
    return this.publicModelConfig(data.modelConfigs.find(item => item.id === 'default'))
  }

  saveModelConfig(input, actorId) {
    return this.store.transaction(data => {
      const existing = data.modelConfigs.find(item => item.id === 'default')
      const baseUrl = this.modelClient.normalizeBaseUrl(input.baseUrl)
      const model = cleanText(input.model, 160)
      if (!model) fail('请填写模型名称', 'model_name_required')
      const apiKey = String(input.apiKey || '').trim()
      if (!existing && !apiKey) fail('首次配置必须填写 API Key', 'model_api_key_required')
      const now = this.now()
      const config = existing || { id: 'default', createdAt: now }
      config.baseUrl = baseUrl
      config.model = model
      if ('visionModel' in input) config.visionModel = cleanText(input.visionModel, 160)
      if ('visionBaseUrl' in input) config.visionBaseUrl = input.visionBaseUrl ? this.modelClient.normalizeBaseUrl(input.visionBaseUrl) : ''
      if (input.visionApiKey) config.visionApiKeyEncrypted = this.cipher.encrypt(String(input.visionApiKey).trim())
      config.temperature = Math.min(2, Math.max(0, Number(input.temperature ?? 0.8)))
      config.maxTokens = Math.min(8192, Math.max(1, Number(input.maxTokens || 2000)))
      config.systemPrompt = cleanText(input.systemPrompt, 6000) || '你是专业、克制的企业客服。'
      if (apiKey) {
        config.apiKeyEncrypted = this.cipher.encrypt(apiKey)
        config.apiKeyPreview = `${apiKey.slice(0, 5)}••••${apiKey.slice(-4)}`
        config.lastTestStatus = 'untested'
      }
      config.updatedAt = now
      if (!existing) data.modelConfigs.push(config)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'model.config_update', targetType: 'model_config', targetId: config.id, metadata: { baseUrl, model }, createdAt: now })
      return this.publicModelConfig(config)
    })
  }

  async resolvedModelConfig(overrides = {}) {
    const data = await this.store.snapshot()
    const stored = data.modelConfigs.find(item => item.id === 'default')
    const apiKey = String(overrides.apiKey || '').trim() || (stored?.apiKeyEncrypted ? this.cipher.decrypt(stored.apiKeyEncrypted) : '')
    const visionApiKey = stored?.visionApiKeyEncrypted ? this.cipher.decrypt(stored.visionApiKeyEncrypted) : ''
    return { ...(stored || {}), ...overrides, apiKey, visionApiKey, baseUrl: overrides.baseUrl || stored?.baseUrl, model: overrides.model || stored?.model }
  }

  async testModel(input, actorId) {
    const config = await this.resolvedModelConfig(input)
    const started = Date.now()
    try {
      const result = await this.modelClient.complete(config, { messages: [{ role: 'user', content: '只回复四个字：连接成功' }], maxTokens: 128, temperature: 0 })
      const testedAt = this.now()
      await this.store.transaction(data => {
        const saved = data.modelConfigs.find(item => item.id === 'default')
        if (saved) { saved.lastTestedAt = testedAt; saved.lastTestStatus = 'passed' }
        data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'model.connection_test', targetType: 'model_config', targetId: 'default', metadata: { result: 'passed', latencyMs: Date.now() - started }, createdAt: testedAt })
      })
      return { ok: true, latencyMs: Date.now() - started, model: result.model, response: result.content }
    } catch (error) {
      await this.store.transaction(data => { const saved = data.modelConfigs.find(item => item.id === 'default'); if (saved) { saved.lastTestedAt = this.now(); saved.lastTestStatus = 'failed' } })
      throw error
    }
  }

  ingestInbound(input) {
    return this.store.transaction(data => {
      const shop = input.channel === 'wechat_shop'
      const installation = shop ? data.shopInstallations.find(item => item.id === input.shopInstallationId) : input.tenantId
        ? data.wecomInstallations.find(item => item.tenantId === input.tenantId)
        : data.wecomInstallations.find(item => item.corpId === input.corpId)
      if (!installation) fail('消息对应的企业尚未登记', 'wecom_installation_not_found')
      const externalUserId = cleanText(input.externalUserId, 160)
      const openKfId = cleanText(input.openKfId, 160)
      const channelMessageId = cleanText(input.channelMessageId, 200)
      const content = cleanText(input.text, 12000)
      if (!externalUserId || !openKfId || !channelMessageId || !content) fail('入站消息字段不完整', 'invalid_inbound_message')
      const duplicate = data.messages.find(item => item.channelMessageId === channelMessageId && item.direction === 'inbound' && item.tenantId === installation.tenantId && (item.channel || 'wecom') === (shop ? 'wechat_shop' : 'wecom') && (!shop || item.installationId === installation.id))
      if (duplicate) return duplicate
      let conversation = data.conversations.find(item => item.tenantId === installation.tenantId && item.openKfId === openKfId && item.externalUserId === externalUserId && (item.channel || 'wecom') === (shop ? 'wechat_shop' : 'wecom'))
      const receivedAt = input.receivedAt || this.now()
      if (!conversation) {
        conversation = { id: crypto.randomUUID(), channel: shop ? 'wechat_shop' : 'wecom', tenantId: installation.tenantId, installationId: installation.id, corpId: installation.corpId, openKfId, externalUserId, customerName: cleanText(input.customerName, 100) || `客户 ${externalUserId.slice(-6)}`, status: 'open', unreadCount: 0, createdAt: receivedAt }
        data.conversations.push(conversation)
      }
      const messageType = cleanText(input.messageType, 40) || 'text'
      if (shop && input.unionId) conversation.unionId = cleanText(input.unionId, 160)
      const mediaId = cleanText(input.mediaId, shop ? 8192 : 600)
      const message = { id: crypto.randomUUID(), channel: shop ? 'wechat_shop' : 'wecom', installationId: installation.id, conversationId: conversation.id, tenantId: installation.tenantId, channelMessageId, messageType, direction: 'inbound', sender: 'customer', text: content, status: 'received', createdAt: receivedAt }
      if (shop && input.shopDetails) message.shopDetails = input.shopDetails
      if (messageType === 'image' && mediaId) message.mediaIdEncrypted = this.cipher.encrypt(mediaId)
      data.messages.push(message)
      conversation.unreadCount = Number(conversation.unreadCount || 0) + 1
      if (!conversation.lastMessageAt || receivedAt >= conversation.lastMessageAt) {
        conversation.lastMessageAt = receivedAt
        conversation.lastMessagePreview = content.slice(0, 120)
      }
      conversation.updatedAt = receivedAt
      return message
    })
  }

  async inbox(conversationId) {
    const data = await this.store.snapshot()
    const conversations = data.conversations.map(item => {
      return { ...item }
    }).sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)))
    const selected = conversations.find(item => item.id === conversationId) || conversations[0] || null
    const messages = selected ? data.messages.filter(item => item.conversationId === selected.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(item => {
      const { mediaIdEncrypted, ...publicMessage } = item
      if (item.messageType === 'image' && mediaIdEncrypted) publicMessage.mediaUrl = `/v1/admin/messages/${encodeURIComponent(item.id)}/media`
      return publicMessage
    }) : []
    const pending = selected?.channel === 'wechat_shop' ? data.shopSends.find(item => item.conversationId === selected.id && ['pending', 'uncertain'].includes(item.status)) : null
    const pendingReply = pending ? { requestId: pending.requestId, text: this.cipher.decrypt(pending.textEncrypted), status: pending.status } : null
    return { conversations, selected, messages, ...(pendingReply ? { pendingReply } : {}) }
  }

  saveCustomerProfile(conversationId, input, actorId) {
    return Promise.reject(Object.assign(new Error('远端备注已停用，请在本地工作台备注'), { code: 'customer_profile_retired' }))
  }

  async image(messageId) {
    const data = await this.store.snapshot()
    const message = data.messages.find(item => item.id === messageId && item.direction === 'inbound' && item.messageType === 'image')
    if (!message?.mediaIdEncrypted) fail('图片不存在或已过期', 'wecom_media_missing')
    const conversation = data.conversations.find(item => item.id === message.conversationId)
    const shop = conversation?.channel === 'wechat_shop'
    const installation = (shop ? data.shopInstallations : data.wecomInstallations).find(item => item.id === conversation?.installationId)
    if (!installation) fail('图片对应的企业授权不存在', 'wecom_not_ready')
    const result = await (shop ? this.shopSender : this.wecomSender).downloadMedia({ installation, mediaId: this.cipher.decrypt(message.mediaIdEncrypted) })
    const contentType = imageContentType(result.buffer)
    if (!contentType) fail('企业微信返回的文件不是受支持的图片', 'wecom_media_invalid')
    return { buffer: result.buffer, contentType }
  }

  async generateDraft(conversationId, actorId) {
    const inbox = await this.inbox(conversationId)
    if (!inbox.selected) fail('会话不存在', 'conversation_not_found')
    const config = await this.resolvedModelConfig()
    const history = []
    let imageCount = 0
    for (const item of inbox.messages.filter(message => message.direction !== 'draft')) {
      const role = item.direction === 'inbound' ? 'user' : 'assistant'
      if (item.direction === 'inbound' && item.messageType === 'image') {
        try {
          const image = await this.image(item.id)
          history.push({
            role,
            content: [
              { type: 'text', text: item.text && item.text !== '[图片消息]' ? item.text : '客户发送了这张图片，请结合图片内容和完整会话回答。' },
              { type: 'image_url', image_url: { url: `data:${image.contentType};base64,${image.buffer.toString('base64')}`, detail: 'auto' } }
            ]
          })
          imageCount += 1
        } catch (error) {
          const unavailable = ['wecom_media_missing', 'wecom_media_invalid', 'shop_media_missing', 'shop_media_invalid'].includes(error.code) || Number(error.wecomCode) === 40007
          if (!unavailable) throw error
          history.push({ role, content: `${item.text || '[图片消息]'}（该历史图片不可读取或已过期）` })
        }
        continue
      }
      history.push({ role, content: item.text })
    }
    const messages = [{ role: 'system', content: config.systemPrompt || '你是专业客服。' }, ...history]
    const response = this.billing ? await this.billing.complete({ tenantId: inbox.selected.tenantId, id: actorId }, { model: 'customer-auto', messages, max_tokens: config.maxTokens }, crypto.randomUUID()) : null
    const selectedConfig = imageCount && config.visionModel ? { ...config, model: config.visionModel, baseUrl: config.visionBaseUrl || config.baseUrl, apiKey: config.visionApiKey || config.apiKey } : config
    const result = response ? { content: response.choices[0].message.content, usage: response.usage, model: response.model } : await this.modelClient.complete(selectedConfig, { messages })
    const createdAt = this.now()
    const draft = { id: crypto.randomUUID(), conversationId: inbox.selected.id, tenantId: inbox.selected.tenantId, direction: 'draft', sender: 'ai', text: result.content, status: 'draft', usage: result.usage, model: result.model, createdAt }
    await this.store.transaction(data => {
      if (!data.conversations.some(row => row.id === inbox.selected.id)) fail('会话已删除', 'conversation_not_found')
      data.messages.push(draft); data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'message.ai_draft', targetType: 'conversation', targetId: inbox.selected.id, metadata: { model: result.model, historyMessages: history.length, imageCount }, createdAt })
    })
    return draft
  }

  async sendReply(conversationId, text, actorId, requestId = crypto.randomUUID(), localInstallationId = null, image = null) {
    const content = image ? '[图片]' : cleanText(text, 4000)
    if (!content) fail('回复内容不能为空', 'reply_required')
    const data = await this.store.snapshot()
    const conversation = data.conversations.find(item => item.id === conversationId)
    if (!conversation) fail('会话不存在', 'conversation_not_found')
    const shop = conversation.channel === 'wechat_shop'
    if (shop && data.localClients?.some(client => client.status === 'active' && client.bindings?.some(binding => binding.gatewayAccountId === conversation.installationId)) && localInstallationId !== conversation.installationId) {
      fail('此店铺已交给本地工作台回复，请在本地操作；断线不会自动切回远端。', 'local_shop_owned')
    }
    const previous = data.messages.find(item => item.conversationId === conversationId && item.replyRequestId === requestId)
    if (previous) {
      if (previous.text !== content || (image && previous.imageHash !== crypto.createHash('sha256').update(image.buffer).digest('hex'))) fail('同一发送任务不能更改内容', 'shop_conflict')
      return previous
    }
    const installation = (shop ? data.shopInstallations : data.wecomInstallations).find(item => item.id === conversation.installationId)
    if (image && !shop) fail('此渠道不支持图片发送', 'shop_media_invalid')
    const sender = shop ? this.shopSender : this.wecomSender
    const result = await (image ? sender.sendImage({ installation, conversation, requestId, image }) : sender.sendText({ installation, conversation, text: content, requestId }))
    const createdAt = this.now()
    const message = { id: crypto.randomUUID(), channel: conversation.channel || 'wecom', replyRequestId: requestId, conversationId, tenantId: conversation.tenantId, channelMessageId: result.channelMessageId || null, direction: 'outbound', sender: 'operator', text: content, status: 'sent', createdAt }
    if (image) { message.messageType = 'image'; message.imageHash = crypto.createHash('sha256').update(image.buffer).digest('hex') }
    return this.store.transaction(current => {
      const duplicate = current.messages.find(item => item.conversationId === conversationId && item.replyRequestId === requestId)
      if (duplicate) return duplicate
      current.messages.push(message)
      const target = current.conversations.find(item => item.id === conversationId)
      target.unreadCount = 0; target.lastMessageAt = createdAt; target.lastMessagePreview = content.slice(0, 120); target.updatedAt = createdAt
      current.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'message.manual_reply', targetType: 'conversation', targetId: conversationId, metadata: { channelMessageId: message.channelMessageId }, createdAt })
      return message
    })
  }
}

module.exports = CloudMessagingService
