const { QueryTypes } = require('sequelize')
const defaultRegistry = require('./currentConversationRegistry')

const ARCHIVED = 'archived'
const POOL_AI_SELF = 'ai_self'
const STATUS_AI_SERVING = 'ai_serving'

/**
 * 按"当前打开的会话"维护会话归属：
 *   - 不是当前会话的 -> 归档（客户已结束该会话，我方也无法再继续，除非客户重新拉起）
 *   - 又成为当前会话的 -> 从归档拉回 AI 池
 *
 * 通道用协议里既有的 `account.snapshot`。
 *
 * ⚠️ 为什么以 currentCustomerKey 为准，而不是扫会话列表
 * ---------------------------------------------------
 * 早先按"会话项列表"判断，但会话项识别可能把**聊天区的消息行**也算成会话项，
 * 算出来的键是错的 → 真实会话被判为"已消失"而误归档。
 * 顶栏 `topbar-left-info` 是当前会话的权威来源，可靠得多。
 *
 * ⚠️ 读不到当前会话时**什么都不做**
 * ------------------------------------
 * 节点在上报里不带 currentCustomerKey（窗口最小化、顶栏为空、列表读不到）时，
 * 必须跳过而不是"视为没有当前会话"——否则一次误判会把所有会话清空。
 */
function createAccountSnapshotService({
  sequelize,
  logger = console,
  registry = defaultRegistry
} = {}) {
  if (!sequelize) throw new Error('sequelize is required')

  async function archiveConversations(accountId, keysToArchive) {
    if (!keysToArchive.length) return 0
    const [result] = await sequelize.query(
      `UPDATE conversations
          SET conv_status = :archived, status = 'closed', updated_at = NOW(3)
        WHERE account_id = :accountId
          AND conv_status <> :archived
          AND user_id IN (:keys)`,
      {
        replacements: { accountId, archived: ARCHIVED, keys: keysToArchive }
      }
    )
    return (result && result.affectedRows) || 0
  }

  async function restoreConversations(accountId, keysToRestore) {
    if (!keysToRestore.length) return 0
    const [result] = await sequelize.query(
      `UPDATE conversations
          SET conv_status = :status, pool_type = :pool, status = 'active', updated_at = NOW(3)
        WHERE account_id = :accountId
          AND conv_status = :archived
          AND user_id IN (:keys)`,
      {
        replacements: {
          accountId,
          archived: ARCHIVED,
          status: STATUS_AI_SERVING,
          pool: POOL_AI_SELF,
          keys: keysToRestore
        }
      }
    )
    return (result && result.affectedRows) || 0
  }

  async function handle({ envelope, nodeId } = {}) {
    const payload = envelope && envelope.payload
    const accounts = (payload && Array.isArray(payload.accounts)) ? payload.accounts : []
    if (!accounts.length) {
      return { status: 'rejected', errorCode: 'ACCOUNTS_REQUIRED', message: 'account.snapshot 需要 accounts 数组' }
    }

    const summary = []
    for (const entry of accounts) {
      const accountId = Number(entry && entry.accountId)
      if (!Number.isInteger(accountId) || accountId <= 0) continue

      const currentKey = entry && entry.currentCustomerKey ? String(entry.currentCustomerKey) : ''
      if (!currentKey) {
        // 读不到当前会话 -> 跳过，绝不当成"没有会话"
        summary.push({ accountId, skipped: 'no_current_customer' })
        continue
      }

      // 登记"此刻打开的会话"，供 bridgeExpiryService 的 TTL 扫描跳过。
      // 不登记的话，客户端里还开着的会话会被 TTL 反复归档，与下面的恢复互相覆写。
      registry.setCurrentKey(accountId, currentKey)

      // 客户端会话列表里的客户键。
      // ⚠️ 必须区分两件事，节点用 conversationListReadable 告诉我们：
      //   - 列表**可读**（哪怕里面一条都没有）→ 不在列表里就该归档
      //   - 列表**读不到**（容器缺失/解析失败）→ 跳过归档，否则一次失败会清空所有会话
      const activeKeys = Array.isArray(entry.activeConversationKeys)
        ? entry.activeConversationKeys.map(key => String(key))
        : []
      // 老节点不带这个字段 → 按"读不到"处理（保守，维持旧行为，不会误清）
      const listReadable = entry.conversationListReadable === undefined
        ? false
        : Boolean(entry.conversationListReadable)

      const known = await sequelize.query(
        'SELECT user_id, conv_status FROM conversations WHERE account_id = :accountId',
        { replacements: { accountId }, type: QueryTypes.SELECT }
      )
      const knownKeys = known.map(row => String(row.user_id))

      // 归档：
      //   列表可读 → 不在列表里的全部归档，**包括顶栏还停着的那个会话**。
      //     实测场景：客户会话倒计时结束后会从列表消失（容器里只剩"暂无会话中用户"），
      //     界面却仍停在那条会话上、顶栏还显示它——只看顶栏永远等不到归档，
      //     表现成"会话已经不在列表里了，却还留在 AI 池"。
      //   列表读不到 → 退回旧行为：只保留当前会话，其余归档。
      const toArchive = listReadable
        ? knownKeys.filter(key => !activeKeys.includes(key))
        : knownKeys.filter(key => key !== currentKey)
      // 当前会话必须是已存在的会话之一、且没有被归档判定命中，才恢复
      const toRestore = (knownKeys.includes(currentKey) && !toArchive.includes(currentKey))
        ? [currentKey]
        : []

      const restored = await restoreConversations(accountId, toRestore)
      const archived = await archiveConversations(accountId, toArchive)

      if (restored || archived) {
        logger.info(
          '[AccountSnapshot] 账号 %s 归档 %d 条、恢复 %d 条（当前会话 %s，列表 %d 个%s）',
          accountId, archived, restored, currentKey, activeKeys.length,
          listReadable ? '' : '，列表读不到'
        )
      }
      summary.push({
        accountId,
        archived,
        restored,
        currentCustomer: currentKey,
        activeConversationCount: activeKeys.length,
        conversationListReadable: listReadable
      })
    }

    return { status: 'processed', summary }
  }

  return { handle, archiveConversations, restoreConversations }
}

module.exports = { createAccountSnapshotService, ARCHIVED, POOL_AI_SELF, STATUS_AI_SERVING }
