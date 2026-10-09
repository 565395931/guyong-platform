// 注意路径层级：本文件在 modules/channel-adapters/desktop-bridge/ 下，
// 而桥接模块在 modules/desktop-bridge/，所以要退两级（两者同名容易看错）。
const { getActiveBridgeCommandService } = require('../../desktop-bridge/bridgeCommandService')

/**
 * 桌面桥接适配器（adapter_type = 'desktop_bridge'）。
 *
 * 与 `bridgeCommerceAdapter` 的区别：后者对客服聊天硬编码返回 `bridge_required`，
 * 只用于订单/售后/商品事件；本适配器负责**客服聊天**——出站走指令队列下发到
 * 本机节点，由节点写入飞鸽输入框并点击发送。
 *
 * 客服聊天的**入站**不经过适配器，而是走 bridgeGateway -> inboundBridgeService。
 */
class DesktopBridgeAdapter {
  constructor({ channel = 'douyin' } = {}) {
    this.channel = channel
    this.adapterType = 'desktop_bridge'
  }

  /** 事件类能力不归它管，交给既有 commerce 适配器。 */
  async receiveEvent() {
    return []
  }

  /**
   * @param accountId 渠道账号 id
   * @param targetUserId 客户键（= 入站时的 platformCustomerId），节点据此防串会话
   */
  async sendMessage(accountId, targetUserId, standardMessage = {}) {
    const service = getActiveBridgeCommandService()
    if (!service) {
      return {
        success: false,
        status: 'failed',
        code: 'BRIDGE_NOT_ENABLED',
        error: '桌面桥接未启用：请在 .env 设置 BRIDGE_ENABLED=true 并重启后端'
      }
    }

    const content = standardMessage.content
    const text = typeof content === 'string'
      ? content
      : (content && (content.text || content.content)) || ''

    return service.sendMessage({
      accountId,
      targetUserId,
      // 沿用路由传入的本地消息 id，让指令能对应回 plat_messages 那一行
      localMessageId: standardMessage.localMessageId || null,
      content: text,
      messageType: standardMessage.messageType || 'text'
    })
  }

  async healthCheck() {
    const service = getActiveBridgeCommandService()
    return {
      status: service ? 'ok' : 'degraded',
      adapterType: this.adapterType,
      note: service ? '出站指令通道就绪' : '桌面桥接未启用'
    }
  }
}

module.exports = { DesktopBridgeAdapter }
