/**
 * 节点当前打开的会话（每账号一个客户键）。
 *
 * 为什么需要它
 * ------------
 * `accountSnapshotService` 会把"当前打开的会话"从归档恢复回 AI 池，
 * 而 `bridgeExpiryService` 会把 idle 超时的会话归档。两者作用在**同一个**
 * 会话上时会互相覆写：客户端里明明还开着的会话，每 30 秒被 TTL 归档一次、
 * 又被下一份快照恢复一次，`conv_status` 在 archived / ai_serving 之间反复横跳。
 * 实测后果：发送约有一半概率撞上 archived，被 409「会话已归档」挡下。
 *
 * 收敛方式：TTL 扫描跳过"当前打开的会话"。归属判定由 AccountSnapshot 独占
 * （它的输入就是客户端此刻的状态），TTL 只负责清理节点静默/离线时的陈旧会话。
 *
 * 只放内存、不落库：这是"节点此刻的状态"，后端重启后由下一份快照（约 3 秒）
 * 重新填充。宁可短暂漏保护，也不要多一份会不同步的持久状态。
 */

const currentKeys = new Map()

function normalizeAccountId(accountId) {
  const value = Number(accountId)
  return Number.isInteger(value) && value > 0 ? value : null
}

/** 记录某账号当前打开的会话键（空值表示"读不到"，按未上报处理）。 */
function setCurrentKey(accountId, customerKey) {
  const id = normalizeAccountId(accountId)
  if (id === null) return false
  const key = customerKey ? String(customerKey) : ''
  if (key) {
    currentKeys.set(id, key)
  } else {
    // 读不到当前会话时清除保护：否则一次残留会把该账号的会话永久护住，
    // TTL 再也不归档它（与"读不到就什么都不做"的既有约定保持一致）。
    currentKeys.delete(id)
  }
  return true
}

/** 该账号当前打开的会话键，未上报返回 null。 */
function getCurrentKey(accountId) {
  const id = normalizeAccountId(accountId)
  if (id === null) return null
  return currentKeys.get(id) || null
}

/** 该会话是否正是节点当前打开的那个。 */
function isCurrent(accountId, customerKey) {
  const current = getCurrentKey(accountId)
  if (!current || !customerKey) return false
  return current === String(customerKey)
}

function reset() {
  currentKeys.clear()
}

module.exports = { setCurrentKey, getCurrentKey, isCurrent, reset }
