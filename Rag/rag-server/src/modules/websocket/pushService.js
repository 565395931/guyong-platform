/**
 * 推送服务 - 监听 EventEmitter 事件，通过 Socket.IO 推送给前端
 *
 * 工作流程：
 * 1. 业务模块（如 messaging.service）收到新消息后，调用 eventEmitter.emit('newMessage', msg)
 * 2. pushService 监听该事件，查找消息所属会话的 pool_type 和 claimed_by
 * 3. 根据池类型决定推送目标：
 *    - AI自助池 → 推送到 pool:ai_self 房间（所有坐席可见）
 *    - 待人工池 → 推送到 pool:pending_human 房间
 *    - 公共池 → 推送到 public_pool 房间
 *    - 私有池 → 推送到 user:<claimed_by> 房间
 *    - 长期跟进池 → 推送到 user:<claimed_by> 房间 + 高亮提醒
 */
const { getIO } = require('./socketHandler')
const { INTERNAL_EVENTS, SOCKET_EVENTS, ROOMS } = require('./events')
const { POOL_TYPE } = require('../conversation-pool/constants')

function extractPhoneFromChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null
  const trimmed = chatId.trim()
  const cusMatch = trimmed.match(/^(\d+)@c\.us$/)
  if (cusMatch) return cusMatch[1]
  const barePhoneMatch = trimmed.match(/^\d{6,}$/)
  return barePhoneMatch ? trimmed : null
}

function onlyDigits(value) {
  return value ? String(value).replace(/\D/g, '') : ''
}

function isPhoneLikeDisplay(value) {
  if (!value || typeof value !== 'string') return false
  return onlyDigits(value).length >= 6 && /^[+\d\s().-]+$/.test(value.trim())
}

function formatPhoneForDisplay(phone, fallbackDisplay) {
  if (!phone) return null
  const digits = onlyDigits(phone)
  if (fallbackDisplay && isPhoneLikeDisplay(fallbackDisplay) && onlyDigits(fallbackDisplay) === digits) {
    return fallbackDisplay.trim()
  }
  if (/^1\d{10}$/.test(digits)) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return phone
}

// 延迟加载 User 模型，避免循环依赖
let User = null
function getUserModel() {
  if (!User) {
    User = require('../../models/User')
  }
  return User
}

/**
 * 查询会话的完整信息（含池类型、认领坐席等）
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
async function getConversationInfo(conversationId) {
  if (!conversationId) return null

  try {
    const { sequelize } = require('../../config/database')
    const [results] = await sequelize.query(
      `SELECT id, channel, account_id, user_id, user_name, agent_id,
              pool_type, conv_status, claimed_by, claimed_at, priority,
              last_reply_by, last_reply_time,
              last_message, last_message_time, unread_count, status, created_at
       FROM conversations WHERE id = :id LIMIT 1`,
      { replacements: { id: conversationId } }
    )
    return results.length > 0 ? results[0] : null
  } catch (err) {
    // conversations 表可能尚未创建，静默失败
    return null
  }
}

// 旧函数名兼容
async function getAgentIdByConversation(conversationId) {
  return getConversationInfo(conversationId)
}

/**
 * 初始化推送服务，绑定 EventEmitter 监听器
 * @param {EventEmitter} eventEmitter - 全局事件发射器
 */
function initializePushService(eventEmitter) {
  // ========== 新消息到达 ==========
  eventEmitter.on(INTERNAL_EVENTS.NEW_MESSAGE, async (message) => {
    try {
      const io = getIO()
      if (!io) {
        console.warn('[PushService] Socket.IO 未初始化，跳过推送')
        return
      }

      // 查找会话信息（含池类型和认领坐席）
      const convInfo = await getConversationInfo(message.conversationId)
      const poolType = convInfo?.pool_type || POOL_TYPE.AI_SELF
      const claimedBy = convInfo?.claimed_by || null

      // 构建附带会话信息的消息体
      const messageWithConv = {
        ...message,
        conversation: convInfo ? {
          id: message.conversationId,
          channel: convInfo.channel,
          account_id: convInfo.account_id,
          user_id: convInfo.user_id,
          customer_phone: formatPhoneForDisplay(extractPhoneFromChatId(convInfo.user_id), convInfo.user_name),
          user_name: convInfo.user_name,
          agent_id: convInfo.agent_id,
          pool_type: convInfo.pool_type,
          conv_status: convInfo.conv_status,
          claimed_by: convInfo.claimed_by,
          claimed_at: convInfo.claimed_at,
          priority: convInfo.priority,
          last_reply_by: convInfo.last_reply_by,
          last_reply_time: convInfo.last_reply_time ? new Date(convInfo.last_reply_time).getTime() : null,
          last_message: convInfo.last_message,
          last_message_time: convInfo.last_message_time ? new Date(convInfo.last_message_time).getTime() : null,
          unread_count: convInfo.unread_count || 0,
          status: convInfo.status,
          created_at: convInfo.created_at
        } : null
      }

      // 根据池类型决定推送目标
      if (poolType === POOL_TYPE.PRIVATE || poolType === POOL_TYPE.LONG_TERM) {
        // 私有池/长期跟进池 → 推送给认领坐席；同时推送给当前会话房间，支持
        // admin/supervisor 或已授权坐席打开会话时实时收到消息。
        const conversationRoom = ROOMS.conversationRoom(message.conversationId)
        if (claimedBy) {
          io.to(ROOMS.userRoom(claimedBy))
            .to(conversationRoom)
            .emit(SOCKET_EVENTS.NEW_MESSAGE, messageWithConv)
          console.log(`[PushService] 新消息已推送给坐席 ${claimedBy} 和会话房间（${poolType}），会话 ${message.conversationId}`)
        } else {
          io.to(conversationRoom).emit(SOCKET_EVENTS.NEW_MESSAGE, messageWithConv)
          console.log(`[PushService] 新消息已推送到会话房间（${poolType}），会话 ${message.conversationId}`)
        }
      } else {
        // AI自助池/待人工池/公共池 → 推送到对应池房间；同时覆盖公共池坐席。
        // 注意：客户端可能同时加入 public_pool 和 pool:xxx，必须用一次链式 emit，Socket.IO 会按 socket 去重；
        // 分两次 emit 会导致前端收到两条完全相同的 new_message。
        const poolRoom = ROOMS.poolRoom(poolType)
        const target = poolRoom === ROOMS.PUBLIC_POOL
          ? io.to(poolRoom)
          : io.to(poolRoom).to(ROOMS.PUBLIC_POOL)
        target.emit(SOCKET_EVENTS.NEW_MESSAGE, messageWithConv)
        console.log(`[PushService] 新消息已推送到 ${poolType} 池，会话 ${message.conversationId}`)
      }
    } catch (err) {
      console.error('[PushService] 推送新消息失败:', err.message)
    }
  })

  // ========== 消息状态变更 ==========
  eventEmitter.on(INTERNAL_EVENTS.MESSAGE_UPDATE, async (data) => {
    try {
      const io = getIO()
      if (!io) return

      const convInfo = await getConversationInfo(data.conversationId)
      const claimedBy = convInfo?.claimed_by || null
      const conversationRoom = data.conversationId ? ROOMS.conversationRoom(data.conversationId) : null
      if (claimedBy) {
        const target = conversationRoom
          ? io.to(ROOMS.userRoom(claimedBy)).to(conversationRoom)
          : io.to(ROOMS.userRoom(claimedBy))
        target.emit(SOCKET_EVENTS.MESSAGE_UPDATE, data)
      } else if (conversationRoom) {
        io.to(conversationRoom).emit(SOCKET_EVENTS.MESSAGE_UPDATE, data)
      }
    } catch (err) {
      console.error('[PushService] 推送消息状态变更失败:', err.message)
    }
  })

  // ========== 会话变更（分配/转接/结束/池变更）==========
  eventEmitter.on(INTERNAL_EVENTS.CONVERSATION_UPDATE, async (data) => {
    try {
      const io = getIO()
      if (!io) return

      const { type, previousAgentId, operatorId } = data

      // 池变更/抢单/释放 → 广播到所有池房间（让坐席列表更新）
      if (['pool_change', 'claimed', 'transferred_in', 'transferred_out'].includes(type)) {
        // 广播池变更事件到所有池房间；使用一次链式 emit 避免同一 socket 加入多个房间时重复收到事件
        io.to(ROOMS.PUBLIC_POOL)
          .to(ROOMS.AI_SELF_POOL)
          .to(ROOMS.PENDING_HUMAN_POOL)
          .emit(SOCKET_EVENTS.POOL_CHANGE, data)

        // 如果有具体的目标坐席，也推送到个人房间
        if (data.conversation?.claimed_by) {
          io.to(ROOMS.userRoom(data.conversation.claimed_by)).emit(SOCKET_EVENTS.CONVERSATION_UPDATE, data)
        }
        if (operatorId) {
          io.to(ROOMS.userRoom(operatorId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATE, data)
        }

        // 推送池统计更新
        broadcastPoolStats(io)

        console.log(`[PushService] 池变更已广播: ${type}，会话 ${data.conversationId}`)
      } else if (type === 'archived') {
        // 归档 → 通知相关坐席
        const convInfo = await getConversationInfo(data.conversationId)
        if (convInfo?.claimed_by) {
          io.to(ROOMS.userRoom(convInfo.claimed_by)).emit(SOCKET_EVENTS.CONVERSATION_UPDATE, data)
        }
        io.to(ROOMS.PUBLIC_POOL).emit(SOCKET_EVENTS.POOL_CHANGE, data)
        broadcastPoolStats(io)
      } else if (type === 'new_message') {
        // 新消息触发的会话更新 → 走 NEW_MESSAGE 通道，这里不重复推送
      } else {
        // 其他类型的会话更新
        let agentId = data.agentId || data.conversation?.claimed_by || null
        if (!agentId && data.conversationId) {
          const convInfo = await getConversationInfo(data.conversationId)
          agentId = convInfo?.claimed_by || null
        }

        if (agentId) {
          io.to(ROOMS.userRoom(agentId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATE, data)
        }
        if (previousAgentId && previousAgentId !== agentId) {
          io.to(ROOMS.userRoom(previousAgentId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATE, {
            ...data,
            type: 'transferred_out'
          })
        }
      }
    } catch (err) {
      console.error('[PushService] 推送会话变更失败:', err.message)
    }
  })

  // ========== RAG 推荐结果生成完毕 ==========
  eventEmitter.on(INTERNAL_EVENTS.RAG_SUGGESTION_READY, async (data) => {
    try {
      const io = getIO()
      if (!io) return

      const convInfo = await getConversationInfo(data.conversationId)
      const claimedBy = convInfo?.claimed_by || null
      if (claimedBy) {
        io.to(ROOMS.userRoom(claimedBy)).emit(SOCKET_EVENTS.RAG_SUGGESTION_READY, data)
        console.log(`[PushService] RAG 推荐结果已推送给坐席 ${claimedBy}`)
      }
    } catch (err) {
      console.error('[PushService] 推送 RAG 推荐结果失败:', err.message)
    }
  })

  // ========== AI 自动回复任务状态（仅客服工作台内部可见） ==========
  eventEmitter.on(INTERNAL_EVENTS.AI_REPLY_STATUS, async (data) => {
    try {
      const io = getIO()
      if (!io || !data?.conversationId) return

      const convInfo = await getConversationInfo(data.conversationId)
      const poolType = convInfo?.pool_type || POOL_TYPE.AI_SELF
      const claimedBy = convInfo?.claimed_by || null
      const conversationRoom = ROOMS.conversationRoom(data.conversationId)
      const payload = {
        ...data,
        serverTimestamp: Date.now()
      }

      if (poolType === POOL_TYPE.PRIVATE || poolType === POOL_TYPE.LONG_TERM) {
        if (claimedBy) {
          io.to(ROOMS.userRoom(claimedBy))
            .to(conversationRoom)
            .emit(SOCKET_EVENTS.AI_REPLY_STATUS, payload)
        } else {
          io.to(conversationRoom).emit(SOCKET_EVENTS.AI_REPLY_STATUS, payload)
        }
      } else {
        const poolRoom = ROOMS.poolRoom(poolType)
        const target = poolRoom === ROOMS.PUBLIC_POOL
          ? io.to(poolRoom).to(conversationRoom)
          : io.to(poolRoom).to(ROOMS.PUBLIC_POOL).to(conversationRoom)
        target.emit(SOCKET_EVENTS.AI_REPLY_STATUS, payload)
      }
    } catch (err) {
      console.error('[PushService] 推送 AI 回复状态失败:', err.message)
    }
  })

  // ========== 坐席状态变更 ==========
  eventEmitter.on(INTERNAL_EVENTS.SEAT_STATUS_CHANGE, async (data) => {
    try {
      const io = getIO()
      if (!io) return

      // 广播坐席状态变更到公共池房间
      io.to(ROOMS.PUBLIC_POOL).emit(SOCKET_EVENTS.SEAT_STATUS_CHANGE, data)
      console.log(`[PushService] 坐席状态变更已广播: 坐席 ${data.userId} → ${data.status}`)
    } catch (err) {
      console.error('[PushService] 推送坐席状态变更失败:', err.message)
    }
  })

  console.log('[PushService] 推送服务已初始化，正在监听事件')
}

/**
 * 广播池统计更新（节流：每次池变更时触发）
 */
let statsBroadcastTimer = null
async function broadcastPoolStats(io) {
  // 节流：500ms 内只推送一次
  if (statsBroadcastTimer) return
  statsBroadcastTimer = setTimeout(async () => {
    statsBroadcastTimer = null
    try {
      const poolService = require('../conversation-pool/pool.service')
      const stats = await poolService.getPoolStats(null, 'admin')
      io.to(ROOMS.PUBLIC_POOL).emit(SOCKET_EVENTS.POOL_STATS_UPDATE, stats)
    } catch (err) {
      console.error('[PushService] 广播池统计失败:', err.message)
    }
  }, 500)
}

/**
 * 供业务模块直接调用的便捷方法 - 推送新消息
 * @param {Object} message - PlatformMessage 对象
 * @param {EventEmitter} eventEmitter
 */
function emitNewMessage(message, eventEmitter) {
  eventEmitter.emit(INTERNAL_EVENTS.NEW_MESSAGE, message)
}

/**
 * 供业务模块直接调用的便捷方法 - 推送 RAG 推荐
 * @param {Object} data - { conversationId, messageId, suggestions }
 * @param {EventEmitter} eventEmitter
 */
function emitRagSuggestion(data, eventEmitter) {
  eventEmitter.emit(INTERNAL_EVENTS.RAG_SUGGESTION_READY, data)
}

/**
 * 供业务模块直接调用的便捷方法 - 推送池变更
 * @param {Object} data
 * @param {EventEmitter} eventEmitter
 */
function emitPoolChange(data, eventEmitter) {
  eventEmitter.emit(INTERNAL_EVENTS.POOL_CHANGE, data)
}

/**
 * 供业务模块直接调用的便捷方法 - 推送坐席状态变更
 * @param {Object} data - { userId, status }
 * @param {EventEmitter} eventEmitter
 */
function emitSeatStatusChange(data, eventEmitter) {
  eventEmitter.emit(INTERNAL_EVENTS.SEAT_STATUS_CHANGE, data)
}

module.exports = {
  initializePushService,
  emitNewMessage,
  emitRagSuggestion,
  emitPoolChange,
  emitSeatStatusChange,
  getConversationInfo,
  getAgentIdByConversation
}
