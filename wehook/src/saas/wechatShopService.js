const crypto = require('crypto')
const { createCallbackCrypto, decodeEncodingAesKey } = require('../wecom/callbackCrypto')
const { validateMediaUrl } = require('./wechatShopClient')

function fail(message, code = 'shop_invalid_config') { throw Object.assign(new Error(message), { code }) }
// Only documented message fields, never the decrypted envelope or signed media URLs.
function messageDetails(event) {
  const text = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : ''
  const duration = value => Number.isFinite(value) && value >= 0 ? value : null
  const details = {}
  if (event.msg_type === 'product_share') details.productId = text(event.product_share?.product_id)
  if (event.msg_type === 'order_share') details.orderId = text(event.order_share?.order_id)
  if (event.msg_type === 'voice') details.voice = { durationMs: duration(event.voice?.play_length), translationSucceeded: event.voice?.translation_succ === true }
  if (event.msg_type === 'video') details.video = { durationSeconds: duration(event.video?.play_length) }
  if (event.msg_type === 'reference') {
    const ref = event.reference?.ref_msg || {}
    details.reference = { messageId: text(ref.msg_id), messageType: Number.isInteger(ref.msg_type) ? ref.msg_type : null, text: text(ref.content, 12000), senderName: text(ref.from_name, 100) }
  }
  return details
}
function same(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

class WechatShopService {
  constructor({ store, cipher, client, messaging, now = () => Date.now() }) {
    Object.assign(this, { store, cipher, client, messaging, now })
    this.tokenLocks = new Map()
    this.sendLocks = new Map()
  }

  publicConfig(item) {
    return { id: item.id, tenantId: item.tenantId, name: item.name, appId: item.appId,
      hasAppSecret: Boolean(item.appSecretEncrypted), hasToken: Boolean(item.tokenEncrypted), hasEncodingAESKey: Boolean(item.aesKeyEncrypted),
      callbackPath: `/v1/shop/callback/${item.id}`, verifiedAt: item.verifiedAt || null,
      lastMessageAt: item.lastMessageAt || null, lastTestedAt: item.lastTestedAt || null,
      updatedAt: item.updatedAt }
  }

  async list() { return (await this.store.snapshot()).shopInstallations.map(item => this.publicConfig(item)) }

  async remove(id, confirmName, actorId) {
    if ([...this.sendLocks.keys()].some(key => key.startsWith(id + ':'))) fail('该店铺有回复正在发送，请稍后删除', 'shop_conflict')
    return this.store.transaction(async data => {
      const item = data.shopInstallations.find(row => row.id === id)
      if (!item) fail('店铺已删除，请刷新列表', 'shop_not_found')
      if (confirmName !== item.name) fail('请输入完整店铺名称确认删除', 'shop_invalid_config')
      const ids = new Set(data.conversations.filter(row => row.channel === 'wechat_shop' && row.installationId === id).map(row => row.id))
      const clients = data.localClients.filter(row => row.tenantId === item.tenantId && row.bindings?.some(binding => binding.gatewayAccountId === id))
      const backup = { installation: item, conversations: data.conversations.filter(row => ids.has(row.id)), messages: data.messages.filter(row => ids.has(row.conversationId) || (row.channel === 'wechat_shop' && row.installationId === id)), profiles: data.customerProfiles.filter(row => row.installationId === id), sends: data.shopSends.filter(row => row.installationId === id), clients, pairings: data.localPairings.filter(row => row.installationIds?.includes(id)) }
      const fs = require('node:fs'), path = require('node:path')
      const directory = path.join(path.dirname(this.store.filePath), 'shop-delete-backups')
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(directory, `${crypto.randomUUID()}.enc`), this.cipher.encrypt(JSON.stringify(backup)), { flag: 'wx', mode: 0o600 })
      await this.purgeDelivery?.(id, clients)
      for (const client of clients) {
        client.bindings = client.bindings.filter(row => row.gatewayAccountId !== id)
        client.installationIds = (client.installationIds || data.shopInstallations.filter(row => row.tenantId === item.tenantId).map(row => row.id)).filter(value => value !== id)
        if (!client.bindings.length) client.status = 'revoked'
      }
      data.localPairings = data.localPairings.filter(row => !row.installationIds?.includes(id))
      data.messages = data.messages.filter(row => !ids.has(row.conversationId) && !(row.channel === 'wechat_shop' && row.installationId === id))
      data.conversations = data.conversations.filter(row => !ids.has(row.id))
      data.customerProfiles = data.customerProfiles.filter(row => row.installationId !== id)
      data.shopSends = data.shopSends.filter(row => row.installationId !== id)
      data.shopInstallations = data.shopInstallations.filter(row => row.id !== id)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'shop.delete', targetType: 'shop', targetId: id, createdAt: new Date(this.now()).toISOString(), messageCount: backup.messages.length })
      return { deleted: true, conversationCount: ids.size, messageCount: backup.messages.length }
    })
  }

  createDraft(input, actorId) {
    return this.store.transaction(data => {
      data.shopDrafts = (data.shopDrafts || []).filter(row => row.expiresAt > this.now())
      if (input.replaceId) {
        const previous = data.shopDrafts.find(row => row.id === input.replaceId && row.actorId === actorId)
        if (!previous) fail('草稿已过期，请关闭窗口后重新新增', 'shop_not_ready')
        data.shopDrafts = data.shopDrafts.filter(row => row.id !== previous.id)
      }
      if (data.shopDrafts.filter(row => row.actorId === actorId).length >= 30) fail('未保存草稿过多，请稍后再试', 'shop_not_ready')
      const token = crypto.randomBytes(16).toString('hex')
      let aes = ''
      for (let attempt = 0; attempt < 128; attempt++) {
        const candidate = crypto.randomBytes(32).toString('base64').replace(/=+$/, '')
        if (/^[a-zA-Z0-9]{43}$/.test(candidate)) { aes = candidate; break }
      }
      if (!aes) fail('无法生成消息密钥，请重试')
      const row = { id: crypto.randomUUID(), actorId, expiresAt: this.now() + 2 * 60 * 60 * 1000, tokenEncrypted: this.cipher.encrypt(token), aesKeyEncrypted: this.cipher.encrypt(aes) }
      data.shopDrafts.push(row)
      return { id: row.id, callbackPath: `/v1/shop/callback/${row.id}`, token, encodingAESKey: aes }
    })
  }

  async callbackConfig(id, actorId) {
    return this.store.transaction(data => {
      const item = data.shopInstallations.find(row => row.id === id)
      if (!item) fail('小店接入不存在', 'shop_not_found')
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'shop.callback_config_view', targetType: 'shop', targetId: id, createdAt: new Date(this.now()).toISOString() })
      // Explicit operator-only disclosure: never return AppSecret or access tokens.
      return { token: this.cipher.decrypt(item.tokenEncrypted), encodingAESKey: this.cipher.decrypt(item.aesKeyEncrypted) }
    })
  }

  save(input, actorId) {
    return this.store.transaction(data => {
      const existing = input.id ? data.shopInstallations.find(item => item.id === input.id) : null
      if (input.id && !existing) fail('小店接入不存在', 'shop_not_found')
      const tenantId = String(input.tenantId || '')
      if (!data.tenants.some(item => item.id === tenantId && item.status === 'active')) fail('请选择有效客户', 'tenant_not_found')
      const appId = String(input.appId || '').trim()
      if (!/^wx[a-zA-Z0-9]{16}$/.test(appId)) fail('AppID 应为 wx 开头的 18 位小店编号')
      if (existing && (existing.appId !== appId || existing.tenantId !== tenantId)) fail('已登记小店不能改绑客户或更换 AppID，请新建接入')
      if (data.shopInstallations.some(item => item.appId === appId && item.id !== existing?.id)) fail('该小店 AppID 已登记', 'shop_conflict')
      const callbackId = String(input.callbackId || '')
      if (callbackId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(callbackId)) fail('服务器地址编号无效，请重新新增店铺')
      if (!existing && callbackId && data.shopInstallations.some(row => row.id === callbackId)) fail('该服务器地址已保存，请打开已登记店铺核对配置', 'shop_conflict')
      const item = existing || { id: callbackId || crypto.randomUUID(), tenantId, appId, createdAt: new Date(this.now()).toISOString() }
      const draft = !existing && callbackId ? (data.shopDrafts || []).find(row => row.id === callbackId) : null
      if (!existing && input.draftRequired && !draft) fail('草稿已过期，请重新新增店铺', 'shop_not_ready')
      if (draft && (draft.actorId !== actorId || draft.expiresAt <= this.now())) fail('草稿已过期或不属于当前管理员，请重新新增', 'shop_not_ready')
      const name = String(input.name || '').trim().slice(0, 100)
      if (!name) fail('请填写店铺名称')
      const secret = String(input.appSecret || '').trim()
      const token = String(input.token || '').trim()
      const aes = String(input.encodingAESKey || '').trim()
      if (!existing && (!secret || !token || !aes)) fail('首次接入请填写 AppSecret、Token 和 EncodingAESKey')
      if (draft && (!same(token, this.cipher.decrypt(draft.tokenEncrypted)) || !same(aes, this.cipher.decrypt(draft.aesKeyEncrypted)))) fail('回调参数与已启用草稿不一致，请重新生成回调')
      if (token && !/^[a-zA-Z0-9]{3,32}$/.test(token)) fail('Token 只能包含 3–32 位英文或数字')
      if (aes) {
        if (!/^[a-zA-Z0-9+/]{43}$/.test(aes)) fail('EncodingAESKey 必须为 43 位 Base64 字符')
        try { decodeEncodingAesKey(aes) } catch { fail('EncodingAESKey 无效') }
      }
      item.name = name
      if (secret) { item.appSecretEncrypted = this.cipher.encrypt(secret); delete item.accessTokenEncrypted; delete item.tokenExpiresAt; item.lastTestedAt = null }
      if (token) item.tokenEncrypted = this.cipher.encrypt(token)
      if (aes) item.aesKeyEncrypted = this.cipher.encrypt(aes)
      if (token || aes) item.verifiedAt = null
      if (draft) { item.verifiedAt = draft.verifiedAt || null; data.shopDrafts = data.shopDrafts.filter(row => row.id !== draft.id) }
      item.updatedAt = new Date(this.now()).toISOString()
      if (!existing) data.shopInstallations.push(item)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'shop.config_save', targetType: 'shop', targetId: item.id, createdAt: item.updatedAt })
      return this.publicConfig(item)
    })
  }

  async installation(id) {
    const data = await this.store.snapshot()
    const item = data.shopInstallations.find(item => item.id === id)
    if (!item) fail('小店接入不存在', 'shop_not_found')
    if (!data.tenants.some(tenant => tenant.id === item.tenantId && tenant.status === 'active')) fail('小店所属客户未启用', 'shop_not_ready')
    return item
  }

  async accessToken(id) {
    if (this.tokenLocks.has(id)) return this.tokenLocks.get(id)
    const task = (async () => {
      const item = await this.installation(id)
      if (item.accessTokenEncrypted && item.tokenExpiresAt > this.now() + 60000) return this.cipher.decrypt(item.accessTokenEncrypted)
      const result = await this.client.getToken({ appId: item.appId, appSecret: this.cipher.decrypt(item.appSecretEncrypted) })
      await this.store.transaction(data => {
        const current = data.shopInstallations.find(row => row.id === id)
        if (current.appSecretEncrypted !== item.appSecretEncrypted) fail('配置已变化，请重新测试连接', 'shop_not_ready')
        current.accessTokenEncrypted = this.cipher.encrypt(result.accessToken)
        current.tokenExpiresAt = this.now() + result.expiresIn * 1000
      })
      return result.accessToken
    })()
    this.tokenLocks.set(id, task)
    try { return await task } finally { this.tokenLocks.delete(id) }
  }

  async test(id, actorId) {
    await this.accessToken(id)
    await this.store.transaction(data => {
      const item = data.shopInstallations.find(row => row.id === id)
      item.lastTestedAt = new Date(this.now()).toISOString()
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'shop.credentials_test', targetType: 'shop', targetId: id, createdAt: item.lastTestedAt })
    })
    return { ok: true, message: '小店访问凭据有效；客服收发权限和模式仍需真实联调确认' }
  }

  validateTime(params, maxAgeMs) {
    const timestamp = params.get('timestamp'); const nonce = params.get('nonce')
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !nonce || nonce.length > 200 || Math.abs(this.now() - Number(timestamp) * 1000) > maxAgeMs) {
      fail('回调时间戳或随机数无效', 'shop_callback_rejected')
    }
    return { timestamp, nonce }
  }

  async verify(id, params) {
    const snapshot = await this.store.snapshot()
    const draft = (snapshot.shopDrafts || []).find(row => row.id === id && row.expiresAt > this.now())
    const item = draft || await this.installation(id)
    if (!params.size) return 'callback ready'
    const { timestamp, nonce } = this.validateTime(params, 5 * 60 * 1000)
    const token = this.cipher.decrypt(item.tokenEncrypted)
    const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
    const echo = params.get('echostr')
    if (!same(signature, params.get('signature')) || !echo || echo.length > 1024) fail('回调签名无效', 'shop_callback_rejected')
    await this.store.transaction(data => {
      const current = (draft ? data.shopDrafts : data.shopInstallations).find(row => row.id === id)
      if (!current || current.tokenEncrypted !== item.tokenEncrypted || (draft && current.expiresAt <= this.now())) fail('回调配置已变化，请重试验证', 'shop_callback_rejected')
      current.verifiedAt = new Date(this.now()).toISOString()
    })
    return echo
  }

  async receive(id, params, envelope) {
    const item = await this.installation(id)
    // Platform retries last approximately 3.5 hours. Persistence deduplicates repeats.
    const { timestamp, nonce } = this.validateTime(params, 4 * 60 * 60 * 1000)
    let event
    try {
      const callback = createCallbackCrypto({ token: this.cipher.decrypt(item.tokenEncrypted), encodingAesKey: this.cipher.decrypt(item.aesKeyEncrypted), receiveId: item.appId })
      event = JSON.parse(callback.decrypt({ signature: params.get('msg_signature'), timestamp, nonce, encrypted: envelope.Encrypt }))
    } catch { fail('小店回调验签或解密失败', 'shop_callback_rejected') }
    if (event.Event !== 'commkf_send_msg_to_kf') return { ignored: true }
    const type = String(event.msg_type || '')
    const eventType = typeof event.msg_event === 'object' ? Object.keys(event.msg_event || {})[0] : event.msg_event
    if (eventType && eventType !== 'EVENT_TYPE_SEND_MSG') return { ignored: true }
    const openId = String(event.FromUserName || '')
    const messageId = String(event.msg_id || '')
    const eventSeconds = Number(event.CreateTime)
    if (!openId || openId.length > 160 || !messageId || messageId.length > 200 || !Number.isFinite(eventSeconds) || eventSeconds <= 0 || eventSeconds * 1000 > this.now() + 5 * 60 * 1000 || !type) fail('小店消息字段不完整', 'shop_callback_rejected')
    const receivedAt = new Date(eventSeconds * 1000).toISOString()
    let mediaId = ''
    if (type === 'image' && event.image?.cos_url) mediaId = validateMediaUrl(event.image.cos_url)
    const labels = { image: '[图片消息]', video: '[视频消息]', file: '[文件消息]', voice: '[语音消息]', product_share: `[商品卡片] ${String(event.product_share?.product_id || '').slice(0, 100)}`, order_share: `[订单卡片] ${String(event.order_share?.order_id || '').slice(0, 100)}` }
    const text = String(event.text?.content || event.voice?.translated_msg || event.reference?.content || labels[type] || `[${type}消息]`)
    const message = await this.messaging.ingestInbound({ channel: 'wechat_shop', shopInstallationId: id, externalUserId: openId, unionId: typeof event.union_id === 'string' ? event.union_id.slice(0, 160) : '', openKfId: item.appId, channelMessageId: messageId, text, messageType: type, mediaId, receivedAt, shopDetails: messageDetails(event) })
    await this.store.transaction(data => { data.shopInstallations.find(row => row.id === id).lastMessageAt = new Date(this.now()).toISOString() })
    return message
  }

  async sendText({ installation, conversation, text, requestId, image = null }) {
    const id = installation?.id
    const key = `${id}:${requestId}`
    if (this.sendLocks.has(key)) return this.sendLocks.get(key)
    const task = this._sendText({ installation, conversation, text, requestId, image })
    this.sendLocks.set(key, task)
    try { return await task } finally { this.sendLocks.delete(key) }
  }

  async _sendText({ installation, conversation, text, requestId, image }) {
    if (!installation || installation.tenantId !== conversation.tenantId || !requestId) fail('小店发送归属无效', 'shop_not_ready')
    const operation = await this.store.transaction(data => {
      if (!data.shopInstallations.some(row => row.id === installation.id && row.tenantId === conversation.tenantId) || !data.conversations.some(row => row.id === conversation.id)) fail('店铺或会话已删除，消息未发送', 'shop_not_ready')
      const previous = data.shopSends.find(row => row.installationId === installation.id && row.requestId === requestId)
      if (previous) {
        if (previous.conversationId !== conversation.id || previous.textHash !== crypto.createHash('sha256').update(image ? image.buffer : text).digest('hex')) fail('同一发送任务不能更改内容', 'shop_conflict')
        return previous
      }
      const inbound = data.messages.filter(row => row.conversationId === conversation.id && row.direction === 'inbound').reverse().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
      if (!inbound || this.now() - Date.parse(inbound.createdAt) >= 48 * 60 * 60 * 1000) fail('客户最后发消息已超过 48 小时，请等待客户再次发消息', 'shop_reply_limit')
      const sent = data.shopSends.filter(row => row.conversationId === conversation.id && row.inboundId === inbound.id && row.status !== 'failed')
      if (sent.length >= 5) fail('本轮已达到 5 条回复上限，请等待客户再次发消息', 'shop_reply_limit')
      const row = { installationId: installation.id, requestId, conversationId: conversation.id, inboundId: inbound.id, textHash: crypto.createHash('sha256').update(image ? image.buffer : text).digest('hex'), textEncrypted: this.cipher.encrypt(text), status: 'pending', createdAt: new Date(this.now()).toISOString() }
      data.shopSends.push(row)
      return row
    })
    if (operation.status === 'sent') return { channelMessageId: operation.channelMessageId }
    if (operation.status === 'failed') fail(operation.errorMessage || '此任务被小店拒绝，请调整内容后重新发送', 'shop_api_error')
    if (operation.status === 'uncertain') fail('发送结果待确认，请勿重复发送', 'shop_transport_error')
    try {
      const accessToken = await this.accessToken(installation.id)
      let result
      if (image) {
        const uploaded = await this.client.uploadImage({ accessToken, openId: conversation.externalUserId, ...image })
        result = await this.client.sendImage({ accessToken, openId: conversation.externalUserId, cosUrl: uploaded.cosUrl, requestId })
      } else result = await this.client.sendText({ accessToken, openId: conversation.externalUserId, text, requestId })
      await this.store.transaction(data => { const row = data.shopSends.find(row => row.installationId === installation.id && row.requestId === requestId); row.status = 'sent'; row.channelMessageId = result.channelMessageId })
      return result
    } catch (error) {
      await this.store.transaction(data => {
        const row = data.shopSends.find(row => row.installationId === installation.id && row.requestId === requestId)
        row.status = error.code === 'shop_transport_error' ? 'uncertain' : 'failed'
        row.errorCode = error.code; row.shopCode = error.shopCode || null; row.errorMessage = error.message
        if ([40014, 42001].includes(error.shopCode)) { const item = data.shopInstallations.find(item => item.id === installation.id); delete item.accessTokenEncrypted }
      })
      throw error
    }
  }

  sender() {
    return { sendText: input => this.sendText(input), sendImage: input => this.sendText({ ...input, text: '[图片]', image: input.image }), downloadMedia: ({ mediaId }) => this.client.downloadMedia({ url: mediaId }) }
  }
}

module.exports = WechatShopService
