/**
 * 渠道适配器基类
 *
 * 定义所有渠道适配器必须实现的接口。
 * 每个渠道（WhatsApp/WAHA、抖音、微信等）继承此类并实现所有方法。
 */

class BaseAdapter {
  /**
   * 渠道标识，子类必须覆盖
   */
  channel = 'base'

  /**
   * 适配器类型标识，子类必须覆盖
   */
  adapterType = 'base'

  /**
   * 接收渠道 Webhook 事件，转换为平台标准消息数组
   * @param {Object} payload - 渠道 Webhook 的原始 body
   * @returns {Promise<Array>} StandardMessage[]
   */
  async receiveEvent(payload) {
    throw new Error(`[${this.adapterType}] receiveEvent 未实现`)
  }

  /**
   * 发送消息到渠道
   * @param {number} accountId - 平台渠道账号 ID
   * @param {string} targetUserId - 接收者的渠道用户标识
   * @param {Object} standardMessage - 平台标准消息体
   * @returns {Promise<{ success: boolean, channelMsgId?: string, error?: string }>}
   */
  async sendMessage(accountId, targetUserId, standardMessage) {
    throw new Error(`[${this.adapterType}] sendMessage 未实现`)
  }

  /**
   * 绑定账号
   * @param {Object} config - 渠道配置
   * @returns {Promise<{ success: boolean }>}
   */
  async bindAccount(config) {
    throw new Error(`[${this.adapterType}] bindAccount 未实现`)
  }

  /**
   * 解绑账号
   * @param {number} accountId
   * @returns {Promise<{ success: boolean }>}
   */
  async unbindAccount(accountId) {
    throw new Error(`[${this.adapterType}] unbindAccount 未实现`)
  }
}

module.exports = BaseAdapter
