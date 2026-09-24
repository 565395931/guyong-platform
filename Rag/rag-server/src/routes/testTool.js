/**
 * 测试工具路由 — 仅限 admin 使用
 * 用于测试会话池流转、重置会话状态、清除测试数据
 */
const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const axios = require('axios')
const crypto = require('crypto')
const { sequelize } = require('../config/database')
const { INTERNAL_EVENTS } = require('../modules/websocket/events')
const { resolveCloudGatewayCredential } = require('../modules/cloud-gateway/credentialResolver')
const {
  SUPPORTED_OPERATIONS,
  SUPPORTED_MESSAGE_TYPES,
  normalizeCloudGatewayTestRequest
} = require('../modules/cloud-gateway/testRequest')
const {
  MOCK_ADAPTER_TYPE,
  buildMockGatewayAccountId,
  listMockChannels,
  ensureMockAccount
} = require('../modules/cloud-gateway/mockAccount')
const systemLogger = require('../utils/systemLogger')

const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'

// ========== 认证中间件（仅 admin） ==========
router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    req.user = decoded
    req.eventEmitter = req.app.get('eventEmitter')
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可使用测试工具' })
    }
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

function getCloudGatewayTestConfig() {
  const credential = resolveCloudGatewayCredential(process.env, { preferMockToken: true })
  return {
    enabled: process.env.NODE_ENV !== 'production' &&
      String(process.env.CLOUD_GATEWAY_TEST_TOOL_ENABLED || 'true').toLowerCase() === 'true',
    baseUrl: String(process.env.CLOUD_GATEWAY_HTTP_URL || 'http://127.0.0.1:8788').replace(/\/$/, ''),
    credential
  }
}

function ensureCloudGatewayTestEnabled(res) {
  const config = getCloudGatewayTestConfig()
  if (!config.enabled) {
    res.status(404).json({ success: false, message: '云网关测试工具未启用' })
    return null
  }
  if (!config.credential.configured) {
    res.status(503).json({ success: false, message: '云网关 Mock token 未配置' })
    return null
  }
  return config
}

function gatewayProxyError(res, error, fallbackMessage) {
  const status = Number(error.response?.status) || 502
  const upstream = error.response?.data || {}
  return res.status(status).json({
    success: false,
    message: upstream.message || fallbackMessage,
    code: upstream.code || 'cloud_gateway_unavailable'
  })
}

async function listMappedCloudAccounts(req) {
  const [rows] = await sequelize.query(
    `SELECT id, channel, account_name, status, adapter_type
     FROM channel_accounts
     WHERE status = 'active'
     ORDER BY channel, account_name, id`
  )
  const mapper = req.app.get('cloudGateway')?.accountMapper
  return rows
    .map(row => {
      let mapping = mapper?.resolveByAccountId(row.id)
      if (!mapping && row.adapter_type === MOCK_ADAPTER_TYPE) {
        mapping = mapper?.set({
          accountId: row.id,
          gatewayAccountId: buildMockGatewayAccountId(row.id),
          channel: row.channel
        })
      }
      if (!mapping) return null
      return {
        id: Number(row.id),
        channel: row.channel,
        accountName: row.account_name,
        gatewayAccountId: mapping.gatewayAccountId,
        isMock: row.adapter_type === MOCK_ADAPTER_TYPE
      }
    })
    .filter(Boolean)
}

// ========== 云网关 Mock 入站测试 ==========
router.get('/cloud-gateway/status', async (req, res) => {
  const config = getCloudGatewayTestConfig()
  if (!config.enabled) return res.status(404).json({ success: false, message: '云网关测试工具未启用' })
  try {
    const [healthResponse, accounts, channels] = await Promise.all([
      axios.get(config.baseUrl + '/healthz', { timeout: 5000 }),
      listMappedCloudAccounts(req),
      listMockChannels()
    ])
    const link = req.app.get('cloudGateway')?.link
    return res.json({
      success: true,
      data: {
        gateway: healthResponse.data,
        ragLink: {
          ready: Boolean(link?.ready)
        },
        credential: {
          configured: config.credential.configured,
          source: config.credential.source
        },
        capabilities: {
          operations: SUPPORTED_OPERATIONS,
          messageTypes: SUPPORTED_MESSAGE_TYPES
        },
        accounts,
        channels
      }
    })
  } catch (error) {
    return gatewayProxyError(res, error, '无法连接云网关健康接口')
  }
})

router.post('/cloud-gateway/mock-accounts', async (req, res) => {
  const config = getCloudGatewayTestConfig()
  if (!config.enabled) return res.status(404).json({ success: false, message: '云网关测试工具未启用' })
  try {
    const account = await ensureMockAccount(req.body.channel)
    req.app.get('cloudGateway')?.accountMapper?.set({
      accountId: account.accountId,
      gatewayAccountId: account.gatewayAccountId,
      channel: account.channel
    })
    systemLogger.info('cloud_gateway.mock_account_ready', {
      operatorId: req.user.userId || req.user.id || null,
      accountId: account.accountId,
      gatewayAccountId: account.gatewayAccountId,
      channel: account.channel,
      created: account.created
    })
    return res.status(account.created ? 201 : 200).json({ success: true, data: account })
  } catch (error) {
    systemLogger.error('cloud_gateway.mock_account_failed', {
      operatorId: req.user.userId || req.user.id || null,
      channel: String(req.body.channel || '').trim().toLowerCase(),
      error: error.message
    })
    return res.status(400).json({ success: false, message: error.message })
  }
})

async function handleCloudGatewayTestRequest(req, res) {
  const config = ensureCloudGatewayTestEnabled(res)
  if (!config) return
  let testRequest
  try {
    testRequest = normalizeCloudGatewayTestRequest(req.body)
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  const { operation, accountId, target, message, overrides } = testRequest
  const { channelUserId } = target

  try {
    const [accounts] = await sequelize.query(
      `SELECT id, channel, account_name, status, adapter_type
       FROM channel_accounts
       WHERE id = :accountId AND status = 'active'
       LIMIT 1`,
      { replacements: { accountId } }
    )
    if (!accounts.length) return res.status(404).json({ success: false, message: '测试账号不存在或已停用' })
    const account = accounts[0]
    const mapper = req.app.get('cloudGateway')?.accountMapper
    let mapping = mapper?.resolveByAccountId(accountId)
    if (!mapping && account.adapter_type === MOCK_ADAPTER_TYPE) {
      mapping = mapper?.set({
        accountId,
        gatewayAccountId: buildMockGatewayAccountId(accountId),
        channel: account.channel
      })
    }
    if (!mapping) return res.status(409).json({ success: false, message: '该账号尚未配置云网关映射' })
    if (mapping.channel && mapping.channel !== account.channel) {
      return res.status(409).json({ success: false, message: '云网关映射渠道与账号渠道不一致' })
    }

    const serverTimestamp = Date.now()
    const eventId = overrides.eventId || 'manual-' + crypto.randomUUID()
    const channelMessageId = overrides.channelMessageId || 'mock-' + crypto.randomUUID()
    const response = await axios.post(
      config.baseUrl + '/mock/inbound',
      {
        eventId,
        payload: {
          channel: account.channel,
          accountId,
          channelAccountId: mapping.gatewayAccountId,
          channelUserId,
          direction: 'inbound',
          messageType: message.type,
          content: message.content,
          channelMessageId,
          clientTimestamp: overrides.clientTimestamp,
          serverTimestamp
        }
      },
      {
        timeout: 10000,
        headers: { Authorization: 'Bearer ' + config.credential.token }
      }
    )
    systemLogger.info('cloud_gateway.mock_inbound_submitted', {
      operatorId: req.user.userId || req.user.id || null,
      eventId,
      accountId,
      channel: account.channel,
      channelUserId: systemLogger.maskValue(channelUserId),
      operation,
      messageType: message.type,
      contentTextLength: typeof message.content.text === 'string' ? message.content.text.length : 0,
      contentFieldCount: Object.keys(message.content).length
    })
    return res.status(response.status).json({
      success: true,
      data: {
        ...response.data.data,
        operation,
        accountId,
        accountName: account.account_name,
        channel: account.channel,
        channelUserId,
        channelMessageId,
        messageType: message.type
      }
    })
  } catch (error) {
    systemLogger.error('cloud_gateway.mock_inbound_failed', {
      operatorId: req.user.userId || req.user.id || null,
      accountId,
      error: error.message
    })
    return gatewayProxyError(res, error, '云网关 Mock 入站失败')
  }
}

router.post('/cloud-gateway/requests', handleCloudGatewayTestRequest)
router.post('/cloud-gateway/mock-inbound', handleCloudGatewayTestRequest)

router.get('/cloud-gateway/events/:eventId', async (req, res) => {
  const config = ensureCloudGatewayTestEnabled(res)
  if (!config) return
  try {
    const response = await axios.get(
      config.baseUrl + '/mock/events/' + encodeURIComponent(req.params.eventId),
      {
        timeout: 5000,
        headers: { Authorization: 'Bearer ' + config.credential.token }
      }
    )
    return res.json({ success: true, data: response.data.data })
  } catch (error) {
    return gatewayProxyError(res, error, '查询云网关事件失败')
  }
})

// ========== 1. 按外部 user_id 查找会话列表 ==========
router.get('/find-by-userId/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const [rows] = await sequelize.query(
      `SELECT id, channel, account_id, user_id, user_name, user_avatar,
              pool_type, conv_status, claimed_by, claimed_at, priority,
              last_reply_by, last_reply_time, last_message, last_message_time,
              unread_count, status, created_at, updated_at
       FROM conversations
       WHERE user_id = :userId
       ORDER BY updated_at DESC
       LIMIT 20`,
      { replacements: { userId } }
    )

    res.json({
      success: true,
      data: rows,
      count: rows.length
    })
  } catch (error) {
    console.error('[TestTool] 查找会话失败:', error)
    res.status(500).json({ success: false, message: '查找失败: ' + error.message })
  }
})

// ========== 2. 查看会话完整状态 ==========
router.get('/conversation/:id', async (req, res) => {
  try {
    const { id } = req.params

    // 查询会话
    const [convRows] = await sequelize.query(
      `SELECT id, channel, account_id, user_id, user_name, user_avatar,
              pool_type, conv_status, claimed_by, claimed_at, priority,
              last_reply_by, last_reply_time, last_message, last_message_time,
              unread_count, status, follow_up_reminder_at, created_at, updated_at
       FROM conversations WHERE id = :id`,
      { replacements: { id } }
    )

    if (convRows.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    const conv = convRows[0]

    // 查询消息统计
    const [msgStats] = await sequelize.query(
      `SELECT
         COUNT(*) AS total_messages,
         SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
         SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
         SUM(CASE WHEN sender_type = 'ai' THEN 1 ELSE 0 END) AS ai_reply_count,
         SUM(CASE WHEN sender_type = 'agent' THEN 1 ELSE 0 END) AS agent_reply_count,
         SUM(CASE WHEN sender_type = 'customer' THEN 1 ELSE 0 END) AS customer_msg_count
       FROM plat_messages WHERE conversation_id = :id`,
      { replacements: { id } }
    )

    // 查询池操作日志
    const [poolLogs] = await sequelize.query(
      `SELECT action, from_pool, to_pool, operator_type, operator_name, reason, created_at
       FROM conversation_pool_logs
       WHERE conversation_id = :id
       ORDER BY created_at DESC
       LIMIT 10`,
      { replacements: { id } }
    )

    // 查询最近 5 条消息预览
    const [recentMsgs] = await sequelize.query(
      `SELECT direction, sender_type, message_type, content, created_at
       FROM plat_messages
       WHERE conversation_id = :id
       ORDER BY created_at DESC
       LIMIT 5`,
      { replacements: { id } }
    )

    res.json({
      success: true,
      data: {
        conversation: conv,
        stats: msgStats[0] || {},
        poolLogs,
        recentMessages: recentMsgs
      }
    })
  } catch (error) {
    console.error('[TestTool] 查看会话状态失败:', error)
    res.status(500).json({ success: false, message: '查询失败: ' + error.message })
  }
})

// ========== 3. 重置会话为"新客户"状态 ==========
router.post('/conversation/:id/reset-to-new', async (req, res) => {
  try {
    const { id } = req.params

    // 检查会话是否存在
    const [existing] = await sequelize.query(
      'SELECT id, pool_type, conv_status FROM conversations WHERE id = :id',
      { replacements: { id } }
    )
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    // 重置为新客户状态
    await sequelize.query(
      `UPDATE conversations SET
         pool_type = 'ai_self',
         conv_status = 'ai_serving',
         claimed_by = NULL,
         claimed_at = NULL,
         last_reply_by = NULL,
         last_reply_time = NULL,
         follow_up_reminder_at = NULL,
         unread_count = 0,
         status = 'open',
         updated_at = NOW()
       WHERE id = :id`,
      { replacements: { id } }
    )

    // 清除 AI 回复轮次数据：删除该会话所有 AI outbound 消息 + AI 回复日志
    // 这样 AI 回复轮数计数器归零，不会因轮数上限触发转人工
    const [delMsgs] = await sequelize.query(
      `DELETE FROM plat_messages
       WHERE conversation_id = :id AND direction = 'outbound' AND sender_type = 'ai'`,
      { replacements: { id } }
    )
    await sequelize.query(
      'DELETE FROM ai_reply_logs WHERE conversation_id = :id',
      { replacements: { id } }
    )

    // 清除该会话的 Redis 串行锁和 latest marker，确保重置后可以正常触发新任务
    try {
      const redis = require('../config/redis')
      await redis.del(`ai_reply:lock:${id}`)
      await redis.del(`ai_reply:latest:${id}`)
    } catch {
      // Redis 清理失败不影响重置结果
    }

    // 记录操作日志
    await sequelize.query(
      `INSERT INTO conversation_pool_logs
        (conversation_id, action, from_pool, to_pool, operator_id, operator_name, operator_type, reason, created_at)
       VALUES (:id, 'reset_to_new', NULL, 'ai_self', :operatorId, :operatorName, 'admin', '测试工具重置为新客户（已清除AI回复轮次+日志+锁）', NOW())`,
      {
        replacements: {
          id,
          operatorId: req.user.userId || req.user.id || 0,
          operatorName: req.user.username || 'admin'
        }
      }
    )

    const [updatedRows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at, c.updated_at,
              u.username AS agent_name,
              cu.username AS claimed_by_name,
              ca.account_name, ca.phone_number,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'outbound' AND pm.sender_type = 'ai' AND pm.send_status = 'sent') AS ai_reply_count,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'inbound') AS inbound_count
       FROM conversations c
       LEFT JOIN users u ON c.agent_id = u.id
       LEFT JOIN users cu ON c.claimed_by = cu.id
       LEFT JOIN channel_accounts ca ON c.account_id = ca.id
       WHERE c.id = :id
       LIMIT 1`,
      { replacements: { id } }
    )
    const updatedConversation = updatedRows[0] || null
    if (req.eventEmitter && updatedConversation) {
      req.eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        type: 'pool_change',
        conversationId: id,
        fromPool: existing[0].pool_type,
        toPool: updatedConversation.pool_type,
        fromStatus: existing[0].conv_status,
        toStatus: updatedConversation.conv_status,
        operatorId: req.user.userId || req.user.id || 0,
        conversation: updatedConversation,
        reason: '测试工具重置为新客户'
      })
    }

    res.json({
      success: true,
      message: `会话已重置为新客户状态（ai_self / ai_serving），已清除 ${delMsgs.affectedRows} 条AI回复消息及日志`,
      data: { conversation: updatedConversation }
    })
  } catch (error) {
    console.error('[TestTool] 重置会话失败:', error)
    res.status(500).json({ success: false, message: '重置失败: ' + error.message })
  }
})

// ========== 4. 清除会话所有消息 ==========
router.post('/conversation/:id/clear-messages', async (req, res) => {
  try {
    const { id } = req.params

    const [result] = await sequelize.query(
      'DELETE FROM plat_messages WHERE conversation_id = :id',
      { replacements: { id } }
    )

    // 同时清空会话的 last_message
    await sequelize.query(
      `UPDATE conversations SET last_message = NULL, last_message_time = NULL, updated_at = NOW() WHERE id = :id`,
      { replacements: { id } }
    )

    res.json({
      success: true,
      message: `已清除该会话的所有消息`
    })
  } catch (error) {
    console.error('[TestTool] 清除消息失败:', error)
    res.status(500).json({ success: false, message: '清除失败: ' + error.message })
  }
})

// ========== 5. 清除会话池操作日志 ==========
router.post('/conversation/:id/clear-pool-logs', async (req, res) => {
  try {
    const { id } = req.params

    await sequelize.query(
      'DELETE FROM conversation_pool_logs WHERE conversation_id = :id',
      { replacements: { id } }
    )

    res.json({
      success: true,
      message: '已清除该会话的池操作日志'
    })
  } catch (error) {
    console.error('[TestTool] 清除池日志失败:', error)
    res.status(500).json({ success: false, message: '清除失败: ' + error.message })
  }
})

// ========== 6. 手动设置会话池类型和状态 ==========
router.post('/conversation/:id/set-pool', async (req, res) => {
  try {
    const { id } = req.params
    const { poolType, convStatus, claimedBy } = req.body

    const validPoolTypes = ['ai_self', 'pending_human', 'public', 'private', 'long_term']
    const validConvStatuses = ['ai_serving', 'pending_claim', 'handling', 'following', 'archived']

    if (poolType && !validPoolTypes.includes(poolType)) {
      return res.status(400).json({ success: false, message: `无效的 pool_type，可选值: ${validPoolTypes.join(', ')}` })
    }
    if (convStatus && !validConvStatuses.includes(convStatus)) {
      return res.status(400).json({ success: false, message: `无效的 conv_status，可选值: ${validConvStatuses.join(', ')}` })
    }

    // 获取当前状态（用于日志记录）
    const [current] = await sequelize.query(
      'SELECT pool_type, conv_status FROM conversations WHERE id = :id',
      { replacements: { id } }
    )
    if (current.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    const oldPool = current[0].pool_type
    const oldStatus = current[0].conv_status

    // 构建动态 UPDATE
    const updates = []
    const replacements = { id }

    if (poolType) {
      updates.push('pool_type = :poolType')
      replacements.poolType = poolType
    }
    if (convStatus) {
      updates.push('conv_status = :convStatus')
      replacements.convStatus = convStatus
    }
    if (claimedBy !== undefined) {
      if (claimedBy === null) {
        updates.push('claimed_by = NULL, claimed_at = NULL')
      } else {
        updates.push('claimed_by = :claimedBy, claimed_at = NOW()')
        replacements.claimedBy = claimedBy
      }
    }
    updates.push('updated_at = NOW()')

    await sequelize.query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = :id`,
      { replacements }
    )

    // 记录日志
    await sequelize.query(
      `INSERT INTO conversation_pool_logs
        (conversation_id, action, from_pool, to_pool, operator_id, operator_name, operator_type, reason, created_at)
       VALUES (:id, 'manual_set_pool', :fromPool, :toPool, :operatorId, :operatorName, 'admin', :reason, NOW())`,
      {
        replacements: {
          id,
          fromPool: oldPool,
          toPool: poolType || oldPool,
          operatorId: req.user.userId || req.user.id || 0,
          operatorName: req.user.username || 'admin',
          reason: `手动设置: pool=${poolType || oldPool}, status=${convStatus || oldStatus}`
        }
      }
    )

    // 测试工具直接改库，也需要主动发池变更事件，否则 platform-web 不会实时更新
    const [updatedRows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at, c.updated_at,
              u.username AS agent_name,
              cu.username AS claimed_by_name,
              ca.account_name, ca.phone_number,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'outbound' AND pm.sender_type = 'ai' AND pm.send_status = 'sent') AS ai_reply_count,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'inbound') AS inbound_count
       FROM conversations c
       LEFT JOIN users u ON c.agent_id = u.id
       LEFT JOIN users cu ON c.claimed_by = cu.id
       LEFT JOIN channel_accounts ca ON c.account_id = ca.id
       WHERE c.id = :id
       LIMIT 1`,
      { replacements: { id } }
    )
    const updatedConversation = updatedRows[0] || null
    if (req.eventEmitter && updatedConversation) {
      req.eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        type: 'pool_change',
        conversationId: id,
        fromPool: oldPool,
        toPool: updatedConversation.pool_type,
        fromStatus: oldStatus,
        toStatus: updatedConversation.conv_status,
        operatorId: req.user.userId || req.user.id || 0,
        conversation: updatedConversation,
        reason: '测试工具手动设置会话池'
      })
    }

    res.json({
      success: true,
      message: `已设置会话池: pool_type=${poolType || '不变'}, conv_status=${convStatus || '不变'}`,
      data: { conversation: updatedConversation }
    })
  } catch (error) {
    console.error('[TestTool] 设置会话池失败:', error)
    res.status(500).json({ success: false, message: '设置失败: ' + error.message })
  }
})

// ========== 7. 彻底删除会话（含消息+日志） ==========
router.delete('/conversation/:id', async (req, res) => {
  try {
    const { id } = req.params

    // 检查会话是否存在
    const [existing] = await sequelize.query(
      'SELECT id FROM conversations WHERE id = :id',
      { replacements: { id } }
    )
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    // 按顺序删除关联数据
    await sequelize.query('DELETE FROM conversation_pool_logs WHERE conversation_id = :id', { replacements: { id } })
    await sequelize.query('DELETE FROM plat_messages WHERE conversation_id = :id', { replacements: { id } })
    await sequelize.query('DELETE FROM conversations WHERE id = :id', { replacements: { id } })

    res.json({
      success: true,
      message: '会话及其所有关联数据已彻底删除'
    })
  } catch (error) {
    console.error('[TestTool] 删除会话失败:', error)
    res.status(500).json({ success: false, message: '删除失败: ' + error.message })
  }
})

// ========== 8. 清除 AI 回复日志 ==========
router.post('/conversation/:id/clear-ai-logs', async (req, res) => {
  try {
    const { id } = req.params

    await sequelize.query(
      'DELETE FROM ai_reply_logs WHERE conversation_id = :id',
      { replacements: { id } }
    )

    res.json({
      success: true,
      message: '已清除该会话的 AI 回复日志'
    })
  } catch (error) {
    console.error('[TestTool] 清除AI日志失败:', error)
    res.status(500).json({ success: false, message: '清除失败: ' + error.message })
  }
})

module.exports = router
