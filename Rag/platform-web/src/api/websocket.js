/**
 * WebSocket 服务 - 基于 Socket.IO 的实时消息推送
 *
 * 使用方式：
 *   import { websocketService } from '@/api/websocket'
 *   websocketService.connect(token)        // 登录后连接
 *   websocketService.disconnect()          // 退出时断开
 *   websocketService.on('new_message', cb) // 监听事件
 *   websocketService.emit('join_conversation', convId) // 加入会话房间
 */

import { io } from 'socket.io-client'
import { useConversationStore } from '@/stores/conversation'
import { markConversationRead } from '@/api/conversations'
import { messageReminder } from '@/utils/messageReminder'
import { runtimeConfig } from '@/utils/runtimeConfig'

const messageSummary = (message, fallback = '[消息]') => {
  const content = typeof message?.content === 'string'
    ? safeParseJSON(message.content)
    : (message?.content || {})
  const type = message?.messageType || 'text'
  if (type !== 'text') {
    const label = { image: '图片', video: '视频', audio: '语音', file: '文件' }[type] || '文件'
    const detail = content.transcription || content.translatedText || content.text || content.caption || content.fileName || content.filename || ''
    return `[${label}] ${detail}`.trim()
  }
  return content.translatedText || content.text || fallback
}

const safeParseJSON = (str) => {
  try { return JSON.parse(str) } catch { return {} }
}

// WebSocket 地址：开发环境通过 Vite 代理（同源），生产环境需配置
// 空字符串表示同源连接（通过 /socket.io 代理）
const WS_URL = runtimeConfig.wsUrl

class WebSocketService {
  constructor() {
    this.socket = null
    this.listeners = new Map()
    this.connected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.activeConversationId = null
  }

  /**
   * 连接 WebSocket
   * @param {string} token - JWT Token
   */
  connect(token) {
    if (this.socket?.connected) {
      console.log('[WS] 已连接，跳过')
      return
    }

    if (!token) {
      console.warn('[WS] 无 token，不连接')
      return
    }

    console.log('[WS] 正在连接:', WS_URL)

    this.socket = io(WS_URL, {
      auth: { token: 'Bearer ' + token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: this.maxReconnectAttempts
    })

    // ========== 连接事件 ==========
    this.socket.on('connect', () => {
      this.connected = true
      this.reconnectAttempts = 0
      console.log('[WS] 连接成功，socket id:', this.socket.id)
      if (this.activeConversationId) {
        this.emit('join_conversation', this.activeConversationId)
      }
    })

    this.socket.on('disconnect', (reason) => {
      this.connected = false
      console.warn('[WS] 连接断开:', reason)
    })

    this.socket.on('connect_error', (err) => {
      this.reconnectAttempts++
      console.error('[WS] 连接失败:', err.message, `(尝试 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
    })

    // ========== 业务事件 ==========
    // 新消息到达
    this.socket.on('new_message', (message) => {
      console.log('[WS] 收到新消息:', message)
      this._handleNewMessage(message)
    })

    // 消息状态变更
    this.socket.on('message_update', (data) => {
      console.log('[WS] 消息状态变更:', data)
      this._dispatch('message_update', data)
    })

    // 会话变更（分配/转接/结束/池变更）
    this.socket.on('conversation_update', (data) => {
      console.log('[WS] 会话变更:', data)
      this._handleConversationUpdate(data)
    })

    // RAG 推荐结果就绪
    this.socket.on('rag_suggestion_ready', (data) => {
      console.log('[WS] RAG 推荐就绪:', data)
      this._dispatch('rag_suggestion_ready', data)
    })

    // AI 自助池自动回复状态（仅客服工作台内部提示）
    this.socket.on('ai_reply_status', (data) => {
      console.log('[WS] AI 回复状态:', data)
      this._dispatch('ai_reply_status', data)
    })

    this.socket.on('message_review_updated', (data) => {
      this._dispatch('message_review_updated', data)
    })

    // 池变更事件
    this.socket.on('pool_change', (data) => {
      console.log('[WS] 池变更:', data)
      this._handlePoolChange(data)
    })

    // 池统计更新
    this.socket.on('pool_stats_update', (stats) => {
      console.log('[WS] 池统计更新:', stats)
      this._handlePoolStatsUpdate(stats)
    })

    // 坐席状态变更
    this.socket.on('seat_status_change', (data) => {
      console.log('[WS] 坐席状态变更:', data)
      this._dispatch('seat_status_change', data)
    })
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
      this.connected = false
      this.listeners.clear()
      this.activeConversationId = null
      console.log('[WS] 已断开连接')
    }
  }

  /**
   * 监听事件
   * @param {string} event - 事件名
   * @param {Function} callback - 回调函数
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push(callback)
  }

  /**
   * 取消监听
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    if (!this.listeners.has(event)) return
    if (callback) {
      const cbs = this.listeners.get(event)
      const idx = cbs.indexOf(callback)
      if (idx !== -1) cbs.splice(idx, 1)
    } else {
      this.listeners.delete(event)
    }
  }

  /**
   * 发送事件到服务端
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    if (this.socket?.connected) {
      this.socket.emit(event, data)
    } else {
      console.warn('[WS] 未连接，无法发送事件:', event)
    }
  }

  /**
   * 加入会话房间（打开会话时调用）
   * @param {string} conversationId
   */
  joinConversation(conversationId) {
    this.activeConversationId = conversationId || null
    this.emit('join_conversation', conversationId)
  }

  /**
   * 离开会话房间（关闭会话时调用）
   * @param {string} conversationId
   */
  leaveConversation(conversationId) {
    if (this.activeConversationId === conversationId) {
      this.activeConversationId = null
    }
    this.emit('leave_conversation', conversationId)
  }

  // ========== 内部处理 ==========

  /**
   * 处理新消息：更新会话列表 + 如果是当前会话则追加消息
   * 长期跟进池的新消息会高亮提醒
   */
  _handleNewMessage(message) {
    const convStore = useConversationStore()

    // 如果消息附带会话信息，用 upsert 插入或更新会话列表
    const convId = message.conversationId
    const convData = message.conversation
    const existingConversation = convStore.list.find(c => c.id === convId)
    const isNewConversation = !existingConversation && Boolean(convData)
    const isCurrentConversation = convStore.current?.id === convId
    const shouldIncreaseUnread = message.direction === 'inbound' && (message.senderType || 'customer') === 'customer'

    // 先 upsert 会话（新会话会插入列表）
    const summary = messageSummary(message, convData?.last_message || '[消息]')
    let nextConversation = convData || existingConversation || null
    if (convData) {
      const nextUnreadCount = isCurrentConversation
        ? 0
        : Math.max(
          Number(convData.unread_count || 0),
          Number(existingConversation?.unread_count || 0) + (shouldIncreaseUnread ? 1 : 0)
        )
      nextConversation = {
        ...convData,
        last_message: summary,
        last_message_time: message.serverTimestamp || Date.now(),
        unread_count: nextUnreadCount
      }
      if (this._shouldShowInActiveTab(convStore, nextConversation)) {
        convStore.upsertConversation(convId, nextConversation, { moveToTop: true })
      } else {
        convStore.removeConversation(convId, { preserveCurrent: true })
      }
    } else {
      // 没有会话信息，尝试更新已有会话
      const conv = convStore.list.find(c => c.id === convId)
      if (conv) {
        conv.last_message = summary
        conv.last_message_time = message.serverTimestamp || Date.now()
        if (convStore.current?.id !== convId) {
          conv.unread_count = (conv.unread_count || 0) + 1
        }
        nextConversation = conv
        if (this._shouldShowInActiveTab(convStore, conv)) {
          convStore.upsertConversation(convId, conv, { moveToTop: true })
        } else {
          convStore.removeConversation(convId, { preserveCurrent: true })
        }
      }
    }

    const conversation = convStore.list.find(c => c.id === convId) || nextConversation
    const conversationTab = this._getConversationTab(conversation || nextConversation)
    if (shouldIncreaseUnread && conversationTab && conversationTab !== convStore.activePoolTab) {
      convStore.flashPoolTab(conversationTab)
    }

    if (isNewConversation) {
      convStore.fetchPoolStats()
    }

    if (messageReminder.shouldNotify(message, conversation)) {
      if (!isCurrentConversation) {
        convStore.highlightConversation(convId)
      }
      messageReminder.notify({
        message,
        conversation,
        summary,
        isCurrentConversation
      })
    }

    // 如果是当前会话，追加消息到聊天流
    if (convStore.current?.id === convId) {
      const msgContent = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : (message.content || {})
      convStore.addMessage(convId, {
        id: message.id,
        role: message.direction === 'inbound' ? 'user' : 'agent',
        senderType: message.senderType || (message.direction === 'inbound' ? 'customer' : 'agent'),
        // 重构后 text=原文，translatedText=译文。正文始终显示原文，译文在下方折叠区展示
        content: msgContent?.text || msgContent?.translatedText || msgContent?.caption || '',
        quotedMsg: msgContent?.quotedMsg?.text || null,
        type: message.messageType || 'text',
        fileUrl: msgContent?.fileUrl || msgContent?.url || '',
        fileName: msgContent?.fileName || msgContent?.filename || '',
        mimeType: msgContent?.mimeType || msgContent?.mimetype || '',
        transcription: msgContent?.transcription || '',
        transcriptionStatus: msgContent?.transcriptionStatus || '',
        timestamp: message.serverTimestamp || Date.now(),
        // 翻译相关字段（与 ChatWindow loadMessages 保持一致）：新结构中 text=原文，translatedText=译文
        translated: msgContent?.translated || false,
        originalText: msgContent?.text || '',
        translatedText: msgContent?.translatedText || '',
        originalLang: msgContent?.originalLang || '',
        langLabel: msgContent?.langLabel || ''
      })
      // 当前会话收到新消息，通知后端清零未读数（后端入库时已 +1）
      markConversationRead(convId).catch(() => {})
    }

    // 长期跟进池的新消息高亮提醒
    if (convData?.pool_type === 'long_term' && convStore.current?.id !== convId) {
      // 可以通过 ElNotification 或其他方式提醒
      console.log('[WS] 长期跟进池会话有新消息:', convData.user_name)
    }

    // 通知外部监听器
    this._dispatch('new_message', message)
  }

  /**
   * 处理会话变更
   */
  _handleConversationUpdate(data) {
    const convStore = useConversationStore()
    // 如果有完整会话数据，用 upsert（新会话也能插入）
    if (data.id) {
      const isCurrentConversation = convStore.current?.id === data.id
      if (this._shouldShowInActiveTab(convStore, data)) {
        convStore.upsertConversation(data.id, data)
      } else if (!isCurrentConversation) {
        convStore.removeConversation(data.id, { preserveCurrent: true })
      }
      if (isCurrentConversation) {
        convStore.updateCurrentConversation(data)
      }
    } else {
      convStore.updateConversation(data)
    }

    // 如果是被转出（当前坐席不再持有该会话），从列表移除
    if (data.type === 'transferred_out' && data.conversationId) {
      convStore.removeConversation(data.conversationId)
    }

    this._dispatch('conversation_update', data)
  }

  /**
   * 处理池变更
   * 会话从一个池移到另一个池时触发
   */
  _handlePoolChange(data) {
    const convStore = useConversationStore()

    // 更新会话数据：测试工具/池服务会携带完整 conversation，前端据此决定列表插入或移除
    if (data.conversationId || data.id) {
      const convId = data.conversationId || data.id
      const conversation = data.conversation || null
      const toPool = data.toPool || conversation?.pool_type
      const isCurrentConversation = convStore.current?.id === convId

      // 当前正在打开的会话必须实时更新头部池状态，即使它已经移出当前列表 Tab
      if (isCurrentConversation && conversation) {
        convStore.updateCurrentConversation(conversation)
      }

      const currentTab = convStore.activePoolTab
      const shouldShowInCurrentTab = conversation
        ? this._shouldShowInActiveTab(convStore, conversation)
        : currentTab === 'all' || (toPool && toPool === currentTab)

      if (conversation && shouldShowInCurrentTab) {
        convStore.upsertConversation(convId, conversation)
      } else if (!isCurrentConversation && currentTab !== 'all' && toPool && toPool !== currentTab) {
        // 移出当前 Tab 时只从列表移除，不关闭右侧正在查看的会话
        convStore.removeConversation(convId, { preserveCurrent: true })
      } else if (conversation && !isCurrentConversation) {
        convStore.updateConversation(conversation)
      }
    }

    this._dispatch('pool_change', data)
  }

  /**
   * 处理池统计更新
   */
  _handlePoolStatsUpdate(stats) {
    const convStore = useConversationStore()
    convStore.updatePoolStats(stats)
  }

  _shouldShowInActiveTab(convStore, conversation) {
    const currentTab = convStore.activePoolTab
    if (currentTab === 'all') return true
    const conversationTab = this._getConversationTab(conversation)
    return Boolean(conversationTab && conversationTab === currentTab)
  }

  _getConversationTab(conversation) {
    if (!conversation) return null
    if (conversation.conv_status === 'archived') return 'archived'
    return conversation.pool_type || null
  }

  /**
   * 分发事件给外部监听器
   */
  _dispatch(event, data) {
    const cbs = this.listeners.get(event)
    if (cbs) {
      cbs.forEach(cb => {
        try { cb(data) } catch (e) { console.error('[WS] 事件回调异常:', e) }
      })
    }
  }
}

// 导出单例
export const websocketService = new WebSocketService()
