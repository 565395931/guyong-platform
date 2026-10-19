const crypto = require('crypto')

class WecomSuiteService {
  constructor({ store, cipher, client, messaging, suiteId, suiteSecret, installAuthType = 0, now = () => new Date().toISOString() }) {
    this.store = store; this.cipher = cipher; this.client = client; this.messaging = messaging
    this.suiteId = String(suiteId || ''); this.suiteSecret = String(suiteSecret || ''); this.now = now
    this.installAuthType = Number(installAuthType) === 1 ? 1 : 0
  }

  async suiteConfig() {
    const data = await this.store.snapshot()
    const state = data.wecomProviderState || {}
    return { suiteId: this.suiteId, suiteSecret: this.suiteSecret, suiteTicket: state.suiteTicketEncrypted ? this.cipher.decrypt(state.suiteTicketEncrypted) : '' }
  }

  async handleCommand(metadata) {
    if (metadata.infoType === 'suite_ticket' && metadata.suiteTicket) {
      await this.store.transaction(data => {
        data.wecomProviderState = { ...(data.wecomProviderState || {}), suiteId: metadata.suiteId || this.suiteId, suiteTicketEncrypted: this.cipher.encrypt(metadata.suiteTicket), suiteTicketReceivedAt: this.now(), lastInfoType: metadata.infoType }
      })
      return { accepted: true, type: 'suite_ticket' }
    }
    if (['create_auth', 'change_auth'].includes(metadata.infoType) && metadata.authCode) {
      if (metadata.state) {
        const valid = await this.store.transaction(data => {
          const states = Array.isArray(data.wecomProviderState?.installStates) ? data.wecomProviderState.installStates : []
          const index = states.findIndex(item => item.value === metadata.state && Date.parse(item.expiresAt) > Date.now())
          if (index < 0) return false
          states.splice(index, 1)
          data.wecomProviderState = { ...(data.wecomProviderState || {}), installStates: states }
          return true
        })
        if (!valid) throw Object.assign(new Error('安装链接已失效，请重新生成'), { code: 'wecom_install_state_invalid' })
      }
      const exchanged = await this.client.exchangeAuthCode(await this.suiteConfig(), metadata.authCode)
      await this.store.transaction(data => {
        let installation = data.wecomInstallations.find(item => item.corpId === exchanged.corpId)
        if (!installation) {
          installation = { id: crypto.randomUUID(), tenantId: null, corpId: exchanged.corpId, createdAt: this.now() }
          data.wecomInstallations.push(installation)
        }
        installation.companyName = exchanged.companyName || installation.companyName || ''
        installation.permanentCodeEncrypted = this.cipher.encrypt(exchanged.permanentCode)
        installation.status = installation.tenantId ? 'authorized' : 'pending_tenant_assignment'
        installation.updatedAt = this.now()
      })
      return { accepted: true, type: metadata.infoType, corpId: exchanged.corpId }
    }
    return { accepted: true, type: metadata.infoType || 'unknown' }
  }

  async createInstallUrl(redirectUri) {
    const target = new URL(String(redirectUri || ''))
    if (target.protocol !== 'https:' || target.hostname !== 'provider.thelonelybrave.cn') throw Object.assign(new Error('安装回调地址不受信任'), { code: 'wecom_install_redirect_invalid' })
    const config = await this.suiteConfig()
    const result = await this.client.getPreAuthCode(config)
    await this.client.setSessionInfo(config, result.preAuthCode, this.installAuthType)
    const state = crypto.randomBytes(18).toString('base64url')
    const expiresAt = new Date(Date.now() + Math.min(1200, Math.max(60, result.expiresIn)) * 1000).toISOString()
    await this.store.transaction(data => {
      const current = Array.isArray(data.wecomProviderState?.installStates) ? data.wecomProviderState.installStates.filter(item => Date.parse(item.expiresAt) > Date.now()) : []
      data.wecomProviderState = { ...(data.wecomProviderState || {}), installStates: [...current, { value: state, expiresAt }] }
    })
    const url = new URL('https://open.work.weixin.qq.com/3rdapp/install')
    url.searchParams.set('suite_id', this.suiteId)
    url.searchParams.set('pre_auth_code', result.preAuthCode)
    url.searchParams.set('redirect_uri', target.toString())
    url.searchParams.set('state', state)
    return { url: url.toString(), expiresAt, authType: this.installAuthType === 1 ? 'test' : 'formal' }
  }

  async resolvedInstallation(corpId) {
    const data = await this.store.snapshot()
    const installation = data.wecomInstallations.find(item => item.corpId === corpId)
    if (!installation?.permanentCodeEncrypted || !installation.tenantId) throw Object.assign(new Error('企业微信授权尚未绑定到客户租户'), { code: 'wecom_not_ready' })
    return { ...installation, permanentCode: this.cipher.decrypt(installation.permanentCodeEncrypted) }
  }

  async handleData(event) {
    const installation = await this.resolvedInstallation(event.corpId)
    let cursor = String(installation.syncCursor || '')
    for (let page = 0; page < 50; page += 1) {
      const result = await this.client.syncMessages(await this.suiteConfig(), installation, { token: event.token, cursor, openKfId: event.openKfId })
      for (const message of result.messages) {
        if (Number(message.origin) !== 3) continue
        const text = message.msgtype === 'text' ? message.text?.content
          : message.msgtype === 'image' ? '[图片消息]'
            : message.msgtype === 'voice' ? '[语音消息]'
              : message.msgtype === 'video' ? '[视频消息]'
                : message.msgtype === 'file' ? `[文件消息] ${message.file?.filename || ''}`.trim()
                  : message.msgtype === 'link' ? `[链接] ${message.link?.title || message.link?.url || ''}`.trim()
                    : message.msgtype === 'location' ? `[位置] ${message.location?.name || message.location?.address || ''}`.trim()
                      : `[${message.msgtype || '未知'}消息]`
        await this.messaging.ingestInbound({ corpId: event.corpId, openKfId: message.open_kfid, externalUserId: message.external_userid, channelMessageId: message.msgid, messageType: message.msgtype, mediaId: message.msgtype === 'image' ? message.image?.media_id : null, text, receivedAt: Number(message.send_time) ? new Date(Number(message.send_time) * 1000).toISOString() : this.now() })
      }
      cursor = result.nextCursor || cursor
      if (!result.hasMore) break
    }
    await this.store.transaction(data => { const target = data.wecomInstallations.find(item => item.id === installation.id); if (target) { target.syncCursor = cursor; target.lastMessageSyncAt = this.now(); target.status = 'active' } })
    return { accepted: true }
  }

  sender() {
    return {
      sendText: async ({ installation, conversation, text }) => {
        const resolved = await this.resolvedInstallation(installation.corpId)
        return this.client.sendText(await this.suiteConfig(), resolved, { openKfId: conversation.openKfId, externalUserId: conversation.externalUserId, text })
      },
      downloadMedia: async ({ installation, mediaId }) => {
        const resolved = await this.resolvedInstallation(installation.corpId)
        return this.client.downloadMedia(await this.suiteConfig(), resolved, mediaId)
      }
    }
  }
}

module.exports = WecomSuiteService
