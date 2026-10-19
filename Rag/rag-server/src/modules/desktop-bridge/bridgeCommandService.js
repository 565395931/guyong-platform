const { randomUUID } = require('node:crypto')
const { QueryTypes } = require('sequelize')
const { createCommand } = require('./bridgeProtocol')

// 节点侧耗时 = 等下一轮轮询（约 3s）+ UIA 读取写入（实测约 10s）+ 状态回报往返。
// 20 秒实测会撞线（已成功的发送被记成超时），放宽到 60 秒。
const COMMAND_TIMEOUT_MS = 60_000

/**
 * 出站指令通道：服务端 -> 节点 -> 桌面客户端。
 *
 * 这是此前完全缺失的一环（`desktop_bridge_commands` 从来没有代码写入）。
 * 流程：
 *   1. 找到持有该账号租约的在线节点
 *   2. `message.send` 落库（队列 + 审计），状态 dispatching
 *   3. 通过节点已认证的 WS 连接把指令发下去
 *   4. 等节点回 `message.command.status`，更新状态并返回结果
 *
 * 超时不重发：桌面发送是不可撤回的对外动作，宁可让操作员看到失败后自己决定重试，
 * 也不要在不确定的情况下再发一次。
 */

// 适配器实例在模块加载时就注册好了，拿不到 app 初始化时的依赖，
// 因此用一个共享持有者把命令服务传进去（与 cloudGateway 的 registry 做法一致）。
let activeService = null
function setActiveBridgeCommandService(service) { activeService = service }
function getActiveBridgeCommandService() { return activeService }

function createBridgeCommandService({
  sequelize,
  registry,
  logger = console,
  timeoutMs = COMMAND_TIMEOUT_MS
} = {}) {
  if (!sequelize) throw new Error('sequelize is required')
  if (!registry) throw new Error('registry is required')

  const pending = new Map()

  async function findOnlineLeaseOwner(accountId) {
    const rows = await sequelize.query(
      `SELECT l.node_id, l.generation, n.node_key
         FROM desktop_bridge_leases l
         JOIN desktop_bridge_nodes n ON n.id = l.node_id
        WHERE l.channel_account_id = :accountId
          AND l.expires_at > NOW(3)
          AND n.disabled_at IS NULL`,
      { replacements: { accountId }, type: QueryTypes.SELECT }
    )
    const lease = rows[0]
    if (!lease) return { ok: false, code: 'NO_ACTIVE_LEASE', error: '账号当前没有节点持有有效租约' }
    const connection = registry.get(lease.node_key)
    if (!connection || !connection.socket) {
      return { ok: false, code: 'NODE_OFFLINE', error: '节点未连接或已断线' }
    }
    return { ok: true, lease, connection }
  }

  async function markCommand(commandId, state, extra = {}) {
    await sequelize.query(
      `UPDATE desktop_bridge_commands
          SET state = :state, attempts = attempts + :attemptInc,
              platform_message_id = :platformMessageId,
              error_code = :errorCode, error_message = :errorMessage,
              accepted_at = COALESCE(accepted_at, :acceptedAt),
              completed_at = :completedAt, updated_at = NOW(3)
        WHERE command_id = :commandId`,
      {
        replacements: {
          commandId,
          state,
          attemptInc: extra.attemptInc || 0,
          platformMessageId: extra.platformMessageId || null,
          errorCode: extra.errorCode || null,
          errorMessage: extra.errorMessage ? String(extra.errorMessage).slice(0, 500) : null,
          acceptedAt: extra.acceptedAt || null,
          completedAt: extra.completedAt || null
        }
      }
    ).catch(error => logger.warn('[BridgeCommand] 更新指令状态失败:', error.message))
  }

  /**
   * 发送一条消息到指定账号对应的桌面客户端。
   *
   * targetUserId 是**客户键**（入站时 platformCustomerId 映射成的 conversations.user_id），
   * 节点会用它校验"当前客户端里打开的会话是不是这个客户"，防止操作员切了会话后
   * 消息发错人。所以它是必填的，且必须与入站用的是同一套派生方式。
   *
   * @returns {Promise<{success:boolean, status:string, code?:string, error?:string, platformMessageId?:string}>}
   */
  async function sendMessage({ accountId, targetUserId, content, messageType = 'text', localMessageId = null }) {
    const account = Number(accountId)
    if (!Number.isInteger(account) || account <= 0) {
      return { success: false, status: 'failed', code: 'INVALID_ACCOUNT', error: 'accountId 无效' }
    }
    const text = typeof content === 'string' ? content : ''
    if (!text.trim()) {
      return { success: false, status: 'failed', code: 'EMPTY_CONTENT', error: '消息内容为空' }
    }
    if (!targetUserId) {
      return {
        success: false, status: 'failed', code: 'TARGET_REQUIRED',
        error: '桌面桥接发送必须带客户键（targetUserId）：节点要靠它确认当前打开的会话就是这个客户，否则会把消息发给别人'
      }
    }

    const owner = await findOnlineLeaseOwner(account)
    if (!owner.ok) return { success: false, status: 'failed', code: owner.code, error: owner.error }

    const commandId = randomUUID()
    const payload = {
      accountId: account,
      platformConversationId: String(targetUserId),
      targetUserId: String(targetUserId),
      content: text,
      messageType
    }

    await sequelize.query(
      `INSERT INTO desktop_bridge_commands
         (command_id, local_message_id, node_id, channel_account_id, payload, state,
          attempts, deadline_at, created_at, updated_at)
       VALUES (:commandId, :localMessageId, :nodeId, :accountId, :payload, 'dispatching',
               1, DATE_ADD(NOW(3), INTERVAL :timeoutMs MICROSECOND), NOW(3), NOW(3))`,
      {
        replacements: {
          commandId,
          // local_message_id 是 NOT NULL：调用方没给时退回用 commandId，
          // 否则整条发送会因为 "Column 'local_message_id' cannot be null" 失败（实测踩过）。
          localMessageId: localMessageId ? String(localMessageId).slice(0, 36) : commandId,
          nodeId: owner.lease.node_id,
          accountId: account,
          payload: JSON.stringify(payload),
          timeoutMs: timeoutMs * 1000
        }
      }
    )

    let envelope
    try {
      envelope = createCommand({ nodeId: owner.lease.node_key, payload, commandId })
    } catch (error) {
      await markCommand(commandId, 'failed', {
        errorCode: 'INVALID_COMMAND', errorMessage: error.message, completedAt: new Date()
      })
      return { success: false, status: 'failed', code: 'INVALID_COMMAND', error: error.message }
    }

    const result = await new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(commandId)
        resolve({ status: 'timeout' })
      }, timeoutMs)
      pending.set(commandId, {
        resolve: value => { clearTimeout(timer); resolve(value) }
      })
      try {
        owner.connection.socket.send(JSON.stringify(envelope))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(commandId)
        resolve({ status: 'send_failed', error: error.message })
      }
    })

    if (result.status === 'succeeded') {
      await markCommand(commandId, 'succeeded', {
        platformMessageId: result.platformMessageId || null,
        acceptedAt: new Date(), completedAt: new Date()
      })
      return { success: true, status: 'sent', platformMessageId: result.platformMessageId || null, commandId }
    }

    if (result.status === 'failed') {
      await markCommand(commandId, 'failed', {
        errorCode: result.errorCode || 'NODE_SEND_FAILED',
        errorMessage: result.errorMessage, completedAt: new Date()
      })
      return {
        success: false, status: 'failed', commandId,
        code: result.errorCode || 'NODE_SEND_FAILED',
        error: result.errorMessage || '节点发送失败'
      }
    }

    await markCommand(commandId, result.status === 'timeout' ? 'expired' : 'failed', {
      errorCode: result.status === 'timeout' ? 'COMMAND_TIMEOUT' : 'DISPATCH_FAILED',
      errorMessage: result.error || '指令未在超时前得到确认',
      completedAt: new Date()
    })
    return {
      success: false, status: 'failed', commandId,
      code: result.status === 'timeout' ? 'COMMAND_TIMEOUT' : 'DISPATCH_FAILED',
      error: result.status === 'timeout'
        ? `指令超时（${Math.round(timeoutMs / 1000)} 秒内节点未确认）`
        : (result.error || '指令下发失败')
    }
  }

  /** 处理节点回的 message.command.status。 */
  async function handleStatus({ envelope, nodeId } = {}) {
    const payload = envelope && envelope.payload
    if (!payload || !payload.commandId) {
      return { status: 'rejected', errorCode: 'COMMAND_ID_REQUIRED' }
    }
    if (!nodeId) return { status: 'rejected', errorCode: 'NODE_REQUIRED' }
    const rows = await sequelize.query(
      'SELECT node_id, state FROM desktop_bridge_commands WHERE command_id = :commandId',
      { replacements: { commandId: payload.commandId }, type: QueryTypes.SELECT }
    )
    if (!rows[0] || Number(rows[0].node_id) !== Number(nodeId)) {
      return { status: 'rejected', errorCode: 'COMMAND_NODE_MISMATCH' }
    }
    if (['succeeded', 'failed'].includes(rows[0].state) ||
        (rows[0].state === 'expired' && payload.status === 'accepted')) return { status: 'duplicate' }
    if (payload.status === 'accepted') {
      await markCommand(payload.commandId, 'accepted', { acceptedAt: new Date() })
      return { status: 'processed' }
    }
    const waiter = pending.get(payload.commandId)
    if (waiter) {
      pending.delete(payload.commandId)
      waiter.resolve({
        status: payload.status,
        platformMessageId: payload.platformMessageId,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage
      })
    } else {
      // 迟到的状态（例如超时之后才回）：仍然落库，避免状态悬空
      await markCommand(payload.commandId, payload.status === 'failed' ? 'failed' : 'succeeded', {
        platformMessageId: payload.platformMessageId,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        completedAt: new Date()
      })
    }
    return { status: 'processed' }
  }

  return { sendMessage, handleStatus, _pending: pending }
}

module.exports = {
  createBridgeCommandService,
  setActiveBridgeCommandService,
  getActiveBridgeCommandService,
  COMMAND_TIMEOUT_MS
}
