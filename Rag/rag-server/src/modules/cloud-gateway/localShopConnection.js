const { initCloudGateway } = require('./index')
const { getDispatcher, setDispatcher } = require('./runtime')

const REMOTE_ORIGIN = 'https://provider.thelonelybrave.cn'
const ADAPTER = 'wechat_shop_cloud'

class LocalShopConnection {
  constructor({ accounts, encrypt, decrypt, eventEmitter, http = fetch, origin = REMOTE_ORIGIN, gatewayFactory = initCloudGateway, imageLoader = null }) {
    Object.assign(this, { accounts, encrypt, decrypt, eventEmitter, http, origin, gatewayFactory, imageLoader })
    this.runtimes = new Map()
    this.byAccount = new Map()
    this.busy = false
  }

  installDispatcher() {
    if (this.installed) return
    const previous = getDispatcher()
    setDispatcher({ dispatch: async message => {
      const runtime = this.byAccount.get(Number(message.accountId))
      if (runtime) {
        if (runtime.deleting || !runtime.link.ready) throw new Error('远端连接已断开，请等待重连后再发送；消息未发送')
        if (!['text', 'image'].includes(message.messageType || 'text')) throw new Error('微信小店目前支持文字和图片回复')
        const pending = message.messageType === 'image' ? this.sendImage(message) : runtime.dispatcher.dispatch(message)
        runtime.pendingOutbound.add(pending)
        try { return await pending } finally { runtime.pendingOutbound.delete(pending) }
      }
      // Cloud shop credentials must never fall through to a commerce adapter/noop.
      const account = await this.accounts.findByPk(Number(message.accountId))
      if (account?.adapter_type === ADAPTER) throw new Error('此店铺尚未连接远端，消息未发送')
      if (!previous) throw new Error('发送通道未就绪')
      return previous.dispatch(message)
    } })
    this.installed = true
  }

  async sendImage(message) {
    const account = await this.accounts.findByPk(Number(message.accountId))
    const config = this.decrypt(account.config)
    const { loadShopImage } = require('./outgoingShopImage')
    const image = await (this.imageLoader || loadShopImage)(message.content?.mediaFileId)
    try {
      return await this.remote('/v1/local-shop/send-image', { token: config.token, body: {
        installationId: config.gatewayAccountId, targetUserId: message.targetUserId,
        requestId: message.commandId || message.localMessageId, localConversationId: message.conversationId, imageBase64: image.buffer.toString('base64')
      } })
    } catch (error) {
      if (['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) return { success: false, status: 'unknown', error: '发送结果待确认，请勿重复发送' }
      throw error
    }
  }

  async remote(path, { token, body } = {}) {
    const response = await this.http(this.origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(path === '/v1/local-shop/send-image' ? 45000 : 15000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    if (!response.ok) { const detail = await response.json().catch(() => null); throw Object.assign(new Error(response.status === 401 ? '配对码已失效或连接已撤销，请重新生成配对码' : (detail?.message || '远端请求未完成，请检查连接后重试')), { code: response.status === 401 ? 'REMOTE_UNAUTHORIZED' : 'REMOTE_ERROR' }) }
    const result = await response.json()
    if (!result.success) throw new Error('远端未接受请求')
    return result.data
  }

  async pair(code) {
    if (this.busy) throw new Error('正在连接，请稍候')
    if (typeof code !== 'string' || !/^lwp_[A-Za-z0-9_-]{20,100}$/.test(code.trim())) throw new Error('请粘贴远端生成的配对码')
    this.busy = true
    try {
      // Check local encryption before consuming a one-use remote pairing code.
      this.encrypt({ preflight: true })
      const credentials = await this.remote('/v1/local-shop/pair', { body: { code: code.trim(), name: '本地工作台' } })
      const discovery = await this.remote('/v1/local-shop/discovery', { token: credentials.token })
      if (!discovery.shops.length) throw new Error('该客户尚未登记小店，请先在远端登记')
      // Save each account atomically. Restoring reads the encrypted config and
      // groups by client, so no separate plaintext token file is needed.
      await this.accounts.sequelize.transaction(async transaction => {
        const current = await this.accounts.findAll({ where: { adapter_type: ADAPTER }, transaction })
        for (const shop of discovery.shops) {
          const config = { kind: ADAPTER, remoteOrigin: this.origin, clientId: credentials.client.id, tenantId: credentials.client.tenantId,
            token: credentials.token, gatewayAccountId: shop.gatewayAccountId, appId: shop.appId, manualOnly: false }
          const previous = current.find(row => {
            try { const saved = this.decrypt(row.config); return saved.remoteOrigin === this.origin && saved.gatewayAccountId === shop.gatewayAccountId } catch { return false }
          })
          if (previous?.status === 'active') throw new Error('此店铺已在本地登记，请先断开原连接；不会自动覆盖已有配置')
          const values = { channel: 'wechat_shop', account_name: shop.name, adapter_type: ADAPTER, config: this.encrypt(config),
            status: 'active', knowledge_scope: 'domestic', knowledge_channels: ['wechat_shop'] }
          if (previous) await previous.update(values, { transaction })
          else await this.accounts.create(values, { transaction })
        }
      })
      await this.restore()
      return this.status()
    } finally { this.busy = false }
  }

  async restore() {
    this.installDispatcher()
    const rows = await this.accounts.findAll({ where: { adapter_type: ADAPTER, status: 'active' } })
    const groups = new Map()
    for (const row of rows) {
      const config = this.decrypt(row.config)
      if (config.kind !== ADAPTER || config.remoteOrigin !== this.origin) continue
      if (!groups.has(config.clientId)) groups.set(config.clientId, { config, rows: [] })
      groups.get(config.clientId).rows.push(row)
    }
    for (const [id, group] of groups) {
      const bindings = group.rows.map(row => ({ accountId: Number(row.id), gatewayAccountId: this.decrypt(row.config).gatewayAccountId }))
      const existing = this.runtimes.get(id)
      if (existing) continue
      const runtime = this.gatewayFactory({ eventEmitter: this.eventEmitter, accountEntries: bindings.map(row => ({ ...row, channel: 'wechat_shop' })),
        options: { enabled: true, registerRuntime: false, url: this.origin.replace(/^http/, 'ws') + '/v1/local-shop/socket',
          authToken: group.config.token, clientId: id, accountBindings: bindings, allowShopAutoReply: true } })
      runtime.names = group.rows.map(row => row.account_name)
      runtime.bindings = bindings
      runtime.lastError = null
      runtime.pendingInbound = new Set()
      runtime.pendingOutbound = new Set()
      runtime.link.on('gateway_error', () => { runtime.lastError = '远端拒绝了连接，请检查店铺授权或重新配对' })
      runtime.link.on('ready', () => { runtime.lastError = null })
      runtime.link.on('authentication_rejected', () => { runtime.lastError = '连接授权被撤销、店铺已被接管或绑定被拒绝；请断开后重新配对' })
      this.runtimes.set(id, runtime)
      for (const binding of bindings) this.byAccount.set(binding.accountId, runtime)
      // Private HTTPS image reference becomes a local authenticated proxy path.
      const handle = runtime.inbound.handle.bind(runtime.inbound)
      runtime.inbound.handle = async envelope => {
        if (runtime.deleting) throw new Error('店铺正在断开，消息未入库')
        const message = envelope.payload
        if (message?.messageType === 'image' && /^\/v1\/local-shop\/media\/[a-zA-Z0-9-]+$/.test(message.content?.url || '')) {
          message.content.url = `/api/v1/local-workbench/media/${message.accountId}/${message.content.url.split('/').at(-1)}`
        }
        const pending = handle(envelope)
        runtime.pendingInbound.add(pending)
        try { return await pending } finally { runtime.pendingInbound.delete(pending) }
      }
    }
  }

  status() {
    return [...this.runtimes.entries()].map(([id, runtime]) => ({ id, shopNames: runtime.names, accounts: runtime.bindings.map(row => row.accountId),
      state: runtime.link.ready ? 'connected' : runtime.link.stopped ? 'rejected' : 'reconnecting', message: runtime.lastError, manualOnly: false }))
  }

  async disconnect(id) {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('连接不存在')
    const rows = await this.accounts.findAll({ where: { adapter_type: ADAPTER } })
    const row = rows.find(item => this.decrypt(item.config).clientId === id)
    const config = this.decrypt(row.config)
    try { await this.remote('/v1/local-shop/disconnect', { token: config.token, body: {} }) }
    catch (error) { if (error.code !== 'REMOTE_UNAUTHORIZED') throw error }
    runtime.link.stop()
    for (const accountId of runtime.bindings.map(binding => binding.accountId)) {
      await this.accounts.update({ status: 'inactive' }, { where: { id: accountId } })
      this.byAccount.delete(accountId)
    }
    this.runtimes.delete(id)
  }

  async detachAccount(account) {
    const config = this.decrypt(account.config)
    const runtime = this.runtimes.get(config.clientId)
    if (runtime?.pendingOutbound.size) throw Object.assign(new Error('该连接有回复正在发送，请稍后删除'), { status: 409 })
    if (runtime) runtime.deleting = true
    try { await this.remote('/v1/local-shop/detach', { token: config.token, body: { installationId: config.gatewayAccountId } }) }
    catch (error) { if (error.code !== 'REMOTE_UNAUTHORIZED') { if (runtime) runtime.deleting = false; throw error } }
    if (runtime) {
      runtime.deleting = true; runtime.link.stop()
      await Promise.allSettled([...runtime.pendingInbound])
      for (const binding of runtime.bindings) this.byAccount.delete(binding.accountId)
      this.runtimes.delete(config.clientId)
    }
    await this.accounts.update({ status: 'inactive' }, { where: { id: account.id } })
  }

  async image(accountId, messageId) {
    const row = await this.accounts.findByPk(accountId)
    if (!row || row.adapter_type !== ADAPTER || row.status !== 'active') throw new Error('连接不存在')
    const config = this.decrypt(row.config)
    const response = await this.http(this.origin + `/v1/local-shop/media/${messageId}`, { redirect: 'error',
      headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15000) })
    const type = response.headers.get('content-type')?.split(';')[0]
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) throw new Error('图片暂时无法读取，请重试')
    const limit = 10 * 1024 * 1024
    let size = 0; const parts = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) { await response.body.cancel?.().catch(() => {}); throw new Error('图片超过大小限制') }
      parts.push(chunk)
    }
    return { buffer: Buffer.concat(parts), type }
  }
}
module.exports = { LocalShopConnection, ADAPTER, REMOTE_ORIGIN }
