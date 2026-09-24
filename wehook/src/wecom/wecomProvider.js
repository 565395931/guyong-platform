function blocked(message, code = 'WECOM_SEND_BLOCKED') {
  const error = new Error(message)
  error.code = code
  return error
}

class WecomProvider {
  constructor({ runtimeConfigService, apiClient }) {
    this.runtimeConfigService = runtimeConfigService
    this.apiClient = apiClient
  }

  async send(command) {
    const payload = command?.payload || {}
    const resolved = await this.runtimeConfigService.getActiveByAccountId(payload.accountId)
    if (!resolved) throw blocked('WeCom account runtime configuration is unavailable')
    const { runtimeConfig, account } = resolved
    if (account.status !== 'active') throw blocked('WeCom account is not active')
    if (account.protectionLevel === 'locked') throw blocked('WeCom account is protected')
    const targetUserId = String(payload.targetUserId || '').trim()
    if (!targetUserId) throw blocked('WeCom target user is required')
    if (account.protectionLevel === 'test') {
      const allowlist = Array.isArray(account.allowlist) ? account.allowlist.map(String) : []
      if (!account.allowlistEnabled || !allowlist.includes(targetUserId)) {
        throw blocked('WeCom target is not in the test allowlist')
      }
    }
    if (payload.senderType === 'ai' && !account.aiEnabled) {
      throw blocked('WeCom AI sending is disabled for this account')
    }
    if (payload.messageType !== 'text') {
      throw blocked('WeCom media sending is not enabled in this phase', 'WECOM_UNSUPPORTED_MESSAGE_TYPE')
    }
    const text = String(payload.content?.text || '').trim()
    if (!text) throw blocked('WeCom text content is required')
    const result = await this.apiClient.sendTextMessage(runtimeConfig, {
      openKfId: account.openKfId,
      externalUserId: targetUserId,
      text
    })
    return {
      success: true,
      status: 'sent',
      channelMessageId: result.channelMessageId || null
    }
  }
}

module.exports = WecomProvider

