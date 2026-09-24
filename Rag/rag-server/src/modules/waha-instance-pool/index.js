/**
 * WAHA 实例池 - 兼容层
 *
 * 此模块已迁移至 waha-registry，保留仅为向后兼容。
 * 新代码请直接 require('../waha-registry')
 */

const registry = require('../waha-registry')

module.exports = {
  /** 获取所有实例 */
  getAllInstances() {
    return registry.getAllInstances()
  },

  /** 根据端口获取实例 */
  getInstanceByPort(port) {
    return registry.getInstanceByPort(port)
  },

  /** 获取可用实例（未绑定账号的） */
  async getAvailableInstance() {
    return registry.getAvailableInstance()
  },

  /**
   * 根据 accountId 获取绑定的实例
   * @deprecated 请使用 registry.resolveByAccountId()
   */
  async getInstanceByAccountId(accountId) {
    const result = await registry.resolveByAccountId(accountId)
    return result ? result.instance : null
  },

  /**
   * 根据 session 名查找实例
   * @deprecated 请使用 registry.resolveBySessionName()
   */
  async getInstanceBySessionName(sessionName) {
    return registry.resolveBySessionName(sessionName)
  }
}
