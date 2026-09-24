/**
 * WAHA 客户端工具 - 通过 account_id 获取 WAHA 客户端
 *
 * 所有实例解析通过 WahaRegistry 统一处理，不再有降级路径。
 * 找不到实例时返回 null，由调用方决定如何处理。
 */

const registry = require('../../modules/waha-registry')

/**
 * 通过 account_id 获取 WAHA 客户端
 * @param {number} accountId - channel_accounts 表的 ID
 * @returns {Promise<{client: import('axios').AxiosInstance, sessionName: string, accountId: number} | null>}
 */
async function getWahaClientByAccount(accountId) {
  if (!accountId) {
    console.warn('[wahaClient] accountId 为空，无法获取 WAHA 客户端')
    return null
  }

  const resolved = await registry.resolveByAccountId(accountId)
  if (!resolved) {
    console.warn(`[wahaClient] 账号 ${accountId} 未找到对应 WAHA 实例`)
    return null
  }

  const { instance, account } = resolved
  const config = require('../../shared/utils/wahaConfig').parseWahaAccountConfig(account.config, `accountId=${accountId}`)

  return {
    client: registry.createClient(instance),
    sessionName: config.sessionName || 'default',
    accountId: account.id
  }
}

module.exports = { getWahaClientByAccount }
