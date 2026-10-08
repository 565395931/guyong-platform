<template>
  <div class="chat-window">
    <template v-if="conversation">
      <div class="chat-window__header">
        <span class="chat-window__name">{{ displayName }}</span>
        <el-tag v-if="isGroupConversation" size="small" type="success" effect="plain">群聊</el-tag>
        <el-tag size="small" type="info" effect="plain">{{ channelLabel(conversation.channel) }}</el-tag>
        <!-- 池标签：AI 自助池不再显示"AI自助"字样（池本身保留，只是不打标签） -->
        <el-tag
          v-if="conversation.pool_type && conversation.pool_type !== 'ai_self'"
          size="small"
          :type="poolTagType(conversation.pool_type)"
          effect="dark"
        >
          {{ poolLabel(conversation.pool_type) }}
        </el-tag>
        <el-tag v-if="conversation.conv_status" size="small" :type="statusTagType(conversation.conv_status)" effect="plain">
          {{ statusLabel(conversation.conv_status) }}
        </el-tag>
        <!-- AI自助池提示标签 -->
        <el-tag v-if="conversation.pool_type === 'ai_self' && conversation.ai_reply_count > 0"
          size="small" type="warning" effect="dark">
          AI已服务{{ conversation.ai_reply_count }}轮
        </el-tag>
        <div class="chat-window__actions">
          <!-- 拉取历史按钮 -->
          <el-button
            v-if="conversation.channel === 'whatsapp'"
            size="small"
            :icon="Download"
            :loading="syncingHistory"
            @click="handleSyncHistory"
          >
            拉取历史
          </el-button>

          <el-button
            size="small"
            type="success"
            plain
            :icon="ShoppingCart"
            :loading="creatingOrder"
            @click="handleCreateOrder"
          >
            成单
          </el-button>

          <!-- 私有池/长期跟进池操作按钮 -->
          <template v-if="['private', 'long_term'].includes(conversation.pool_type)">
            <el-button type="warning" size="small" plain :icon="Top" @click="handleRelease">释放</el-button>
            <el-button v-if="conversation.pool_type === 'private'" type="success" size="small" plain :icon="Star" @click="handleMarkLongTerm">长期</el-button>
            <el-button type="info" size="small" plain :icon="Check" @click="handleArchive">归档</el-button>
          </template>

          <!-- AI自助池/待人工池/公共池 → 抢单按钮 -->
          <el-button
            v-if="canClaim"
            type="primary"
            size="small"
            :icon="Pointer"
            @click="handleClaim"
          >
            {{ claimActionLabel }}
          </el-button>

          <el-button size="small" :icon="Close" circle @click="closeChat" />
        </div>
      </div>
      <div class="chat-window__messages" ref="messageRef" @scroll="handleMessagesScroll">
        <LoadingSkeleton v-if="messagesLoading" :rows="3" />
        <template v-else>
          <div v-if="messages.length > 0" class="chat-window__history-loader">
            <el-button
              v-if="hasMoreHistory"
              text
              size="small"
              :loading="olderMessagesLoading"
              @click="loadOlderMessages"
            >
              加载更早消息
            </el-button>
            <span v-else class="chat-window__history-end">已到最早消息</span>
          </div>
          <MessageBubble
            v-for="msg in messages"
            :key="messageRenderKey(msg)"
            :message="msg"
            @adopt="handleAdopt"
            @retry="handleRetry"
          />
          <div v-if="showAiReplying" class="chat-window__ai-replying">
            <span class="chat-window__ai-replying-text">AI 正在回复中</span>
            <span class="chat-window__ai-replying-dots" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
          </div>
          <el-empty v-if="messages.length === 0 && !showAiReplying" description="暂无消息记录，可点击「拉取历史」从 WhatsApp 同步" :image-size="60" />
        </template>
      </div>
      <div v-if="transportReadOnly" class="chat-window__transport-notice" role="status">
        {{ props.readOnlyReason || '需要在线桌面节点' }}
      </div>
      <ChatInput
        ref="chatInputRef"
        :disabled="sending || transportReadOnly"
        :sending-mode="sendingMode"
        @send="handleSend"
      />
    </template>
    <EmptyState v-else description="请选择一个会话" />

    <AssignSeatDialog
      v-model="assignDialogVisible"
      :conversation="conversation"
      :submitting="assigningSeat"
      @confirm="handleAssignSeat"
    />
  </div>
</template>

<script setup>
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { Download, Close, Top, Star, Check, Pointer, ShoppingCart } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useConversationStore } from '@/stores/conversation'
import { useUserStore } from '@/stores/user'
import { useAiSuggestModelsStore } from '@/stores/aiSuggestModels'
import { getMessages, sendMessage } from '@/api/messages'
import { syncHistory, claimConversation, releaseConversation, markLongTerm, archiveConversation } from '@/api/conversations'
import { createOrderFromConversation } from '@/api/orders'
import { websocketService } from '@/api/websocket'
import MessageBubble from './MessageBubble.vue'
import ChatInput from './ChatInput.vue'
import AssignSeatDialog from '@/components/Conversation/AssignSeatDialog.vue'
import EmptyState from '@/components/Common/EmptyState.vue'
import LoadingSkeleton from '@/components/Common/LoadingSkeleton.vue'
import { getConversationDisplayName, isWhatsAppGroupConversation } from '@/utils/conversationDisplay'

const props = defineProps({
  conversation: { type: Object, default: null },
  readOnlyChannels: { type: Array, default: () => [] },
  readOnlyReason: { type: String, default: '' }
})

const displayName = computed(() => getConversationDisplayName(props.conversation))
const isGroupConversation = computed(() => isWhatsAppGroupConversation(props.conversation))
const transportReadOnly = computed(() =>
  props.readOnlyChannels.includes(props.conversation?.channel)
)

const conversationStore = useConversationStore()
const userStore = useUserStore()
const aiSuggestModelsStore = useAiSuggestModelsStore()
const router = useRouter()
const PAGE_SIZE = 200

const messages = ref([])
const messageRef = ref(null)
const chatInputRef = ref(null)
const messagesLoading = ref(false)
const olderMessagesLoading = ref(false)
const hasMoreHistory = ref(false)
const totalMessages = ref(0)
const sending = ref(false)
const sendingMode = ref('')
const syncingHistory = ref(false)
const creatingOrder = ref(false)
const assignDialogVisible = ref(false)
const assigningSeat = ref(false)
const aiReplyStatus = ref({ active: false, status: '', jobMarker: null })
let messagesRequestSeq = 0
let aiReplyStatusTimer = null

const showAiReplying = computed(() =>
  aiReplyStatus.value.active &&
  props.conversation?.pool_type === 'ai_self' &&
  props.conversation?.conv_status !== 'archived'
)

const safeParseJSON = (str) => {
  try { return JSON.parse(str) } catch { return {} }
}

const normalizeMessage = (rawMsg) => {
  const msgContent = typeof rawMsg.content === 'string'
    ? safeParseJSON(rawMsg.content)
    : (rawMsg.content || {})
  const fallbackText = typeof rawMsg.content === 'string' ? rawMsg.content : ''
  const timestamp = rawMsg.createdAt
    ? new Date(rawMsg.createdAt).getTime()
    : (rawMsg.serverTimestamp || rawMsg.timestamp || Date.now())
  return {
    id: rawMsg.id,
    clientId: rawMsg.clientId || rawMsg.tempId || rawMsg.localId || null,
    conversationId: rawMsg.conversationId || rawMsg.conversation_id || props.conversation?.id || null,
    role: rawMsg.role || (rawMsg.direction === 'inbound' ? 'user' : 'agent'),
    senderType: rawMsg.senderType || rawMsg.sender_type || (rawMsg.direction === 'inbound' ? 'customer' : 'agent'),
    direction: rawMsg.direction || (rawMsg.role === 'user' ? 'inbound' : 'outbound'),
    // 重构后 text=原文，translatedText=译文。正文始终显示原文，译文在下方折叠区展示
    content: msgContent?.text || msgContent?.translatedText || msgContent?.content || msgContent?.caption || fallbackText || '',
    quotedMsg: msgContent?.quotedMsg?.text || rawMsg.quotedMsg || null,
    type: rawMsg.messageType || rawMsg.type || 'text',
    fileUrl: msgContent?.fileUrl || msgContent?.url || rawMsg.fileUrl || '',
    fileName: msgContent?.fileName || msgContent?.filename || rawMsg.fileName || '',
    mimeType: msgContent?.mimeType || msgContent?.mimetype || rawMsg.mimeType || '',
    transcription: msgContent?.transcription || rawMsg.transcription || '',
    transcriptionStatus: msgContent?.transcriptionStatus || rawMsg.transcriptionStatus || '',
    timestamp,
    sendStatus: rawMsg.sendStatus || 'sent',
    // 发送失败后"重试"要原样重发，这里保留当时的请求负载。
    // 只按气泡显示的正文重发是不够的——媒体消息的 fileUrl/mimeType/mediaFileId
    // 不在正文里，重发会退化成一条纯文本。
    retryPayload: rawMsg.retryPayload || null,
    channelMsgId: rawMsg.channelMsgId || rawMsg.channelMessageId || null,
    // 翻译相关字段：新结构中 text=原文，translatedText=译文
    translated: msgContent?.translated || rawMsg.translated || false,
    originalText: msgContent?.text || rawMsg.originalText || '',
    translatedText: msgContent?.translatedText || rawMsg.translatedText || '',
    originalLang: msgContent?.originalLang || rawMsg.originalLang || '',
    langLabel: msgContent?.langLabel || rawMsg.langLabel || ''
  }
}

const getMessageKey = (msg) => {
  if (!msg) return ''
  if (msg.id && !msg.id.toString().startsWith('temp_')) return `id:${msg.id}`
  if (msg.clientId) return `client:${msg.clientId}`
  if (msg.id) return `temp:${msg.id}`
  return ''
}

/**
 * 渲染用的稳定 key：**优先 clientId**。
 *
 * 发送成功时 handleSend 会把临时消息合并成服务端真实 id，而 getMessageKey
 * 在合并前后会从 `client:` 变成 `id:`，导致组件被卸载重建——重建出来的实例
 * 一挂载就已是 sent，"发送中 → 绿勾"的状态跃迁根本不会发生，绿勾自然不显示。
 * 用 clientId 做 key 可以让这条气泡自始至终是同一个实例。
 */
const messageRenderKey = (msg) => {
  if (!msg) return ''
  if (msg.clientId) return `client:${msg.clientId}`
  if (msg.id) return `id:${msg.id}`
  return ''
}

const isSameOutgoingTempMessage = (existing, incoming) => {
  if (!existing?.id?.toString().startsWith('temp_')) return false
  if (existing.direction !== 'outbound' || incoming.direction !== 'outbound') return false
  if (existing.senderType !== incoming.senderType && incoming.senderType !== 'agent') return false
  if (existing.content !== incoming.content) return false
  return Math.abs((existing.timestamp || 0) - (incoming.timestamp || Date.now())) < 60 * 1000
}

const mergeMessage = (oldMsg, newMsg) => ({
  ...oldMsg,
  ...newMsg,
  id: newMsg.id || oldMsg.id,
  clientId: newMsg.clientId || oldMsg.clientId,
  sendStatus: newMsg.sendStatus || oldMsg.sendStatus,
  retryPayload: newMsg.retryPayload || oldMsg.retryPayload,
  channelMsgId: newMsg.channelMsgId || oldMsg.channelMsgId
})

const sortMessagesByTime = () => {
  messages.value.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}

const upsertMessage = (rawMsg, { scroll = true } = {}) => {
  const nextMsg = normalizeMessage(rawMsg)
  const nextKey = getMessageKey(nextMsg)
  let index = nextKey ? messages.value.findIndex(msg => getMessageKey(msg) === nextKey) : -1

  if (index === -1 && nextMsg.channelMsgId) {
    index = messages.value.findIndex(msg => msg.channelMsgId && msg.channelMsgId === nextMsg.channelMsgId)
  }

  if (index === -1) {
    index = messages.value.findIndex(msg => isSameOutgoingTempMessage(msg, nextMsg))
  }

  if (index !== -1) {
    messages.value[index] = mergeMessage(messages.value[index], nextMsg)
  } else {
    messages.value.push(nextMsg)
  }
  sortMessagesByTime()
  if (scroll) scrollToBottom()
}

const prependMessages = (rawMessages = []) => {
  const existingTop = messageRef.value
    ? { scrollHeight: messageRef.value.scrollHeight, scrollTop: messageRef.value.scrollTop }
    : null

  rawMessages.forEach(rawMsg => {
    const nextMsg = normalizeMessage(rawMsg)
    const nextKey = getMessageKey(nextMsg)
    const exists = (nextKey && messages.value.some(msg => getMessageKey(msg) === nextKey)) ||
      (nextMsg.channelMsgId && messages.value.some(msg => msg.channelMsgId === nextMsg.channelMsgId))
    if (!exists) messages.value.push(nextMsg)
  })
  sortMessagesByTime()

  nextTick(() => {
    requestAnimationFrame(() => {
      if (messageRef.value && existingTop) {
        messageRef.value.scrollTop = messageRef.value.scrollHeight - existingTop.scrollHeight + existingTop.scrollTop
      }
    })
  })
}

// 滚动到底部 — nextTick 等 Vue DOM 更新 + requestAnimationFrame 等浏览器绘制
const scrollToBottom = () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      if (messageRef.value) {
        messageRef.value.scrollTop = messageRef.value.scrollHeight
      }
    })
  })
}

/**
 * 刚发出的消息该用哪个时间戳 —— **必须保证它排在最后一条之后**。
 *
 * 踩过的坑：直接用 `Date.now()` 会让刚发的消息插到历史消息**中间**，用户在当前
 * 滚动位置根本看不到它，表现成"点发送没反应，要重新点一次会话才出现"。
 * 原因在时间基准不一致：历史消息来自服务端，`created_at` 因
 * `config/database.js` 的 `timezone: '+00:00'` 被当作 UTC 读取、再由前端转成
 * 本地时间，整体偏到 8 小时之后；而 `Date.now()` 是真实本地时间，比这些历史
 * 值都小，于是"最新"的消息按时间排序反而落在中间。
 *
 * 所以用"最后一条消息 + 1 毫秒"兜底。等服务端把自己的时间戳回传时，那个值本来
 * 就比历史值新，位置不会跳动。
 */
const nextOutboundTimestamp = () => {
  const last = messages.value[messages.value.length - 1]
  const now = Date.now()
  return last && last.timestamp >= now ? last.timestamp + 1 : now
}

const loadMessages = async (conv) => {
  const requestSeq = ++messagesRequestSeq
  if (!conv || !conv.id) {
    messages.value = []
    totalMessages.value = 0
    hasMoreHistory.value = false
    return
  }

  const conversationId = conv.id
  messagesLoading.value = true
  try {
    const res = await getMessages(conversationId, { limit: PAGE_SIZE, offset: 0 })
    if (requestSeq !== messagesRequestSeq || props.conversation?.id !== conversationId) {
      return
    }
    const data = res.data
    if (data && data.list) {
      const hasCustomerMessages = data.list.some(msg => msg.direction === 'inbound')
      if (hasCustomerMessages) {
        aiSuggestModelsStore.loadModels()
      }

      messages.value = []
      data.list.forEach(msg => upsertMessage(msg, { scroll: false }))
      totalMessages.value = data.total || data.list.length
      hasMoreHistory.value = messages.value.length < totalMessages.value
      scrollToBottom()
    }
  } catch (error) {
    if (requestSeq !== messagesRequestSeq || props.conversation?.id !== conversationId) {
      return
    }
    console.error('[ChatWindow] 加载消息失败:', error)
    messages.value = []
    totalMessages.value = 0
    hasMoreHistory.value = false
  } finally {
    if (requestSeq === messagesRequestSeq) {
      messagesLoading.value = false
    }
  }
}

watch(
  () => [props.conversation?.id, conversationStore.selectionVersion],
  () => loadMessages(props.conversation),
  { immediate: true }
)

watch(
  () => props.conversation?.id,
  () => resetAiReplyStatus()
)

const loadOlderMessages = async () => {
  if (!props.conversation?.id || olderMessagesLoading.value || !hasMoreHistory.value) return

  olderMessagesLoading.value = true
  try {
    const res = await getMessages(props.conversation.id, {
      limit: PAGE_SIZE,
      offset: messages.value.length
    })
    const data = res.data
    if (data && data.list) {
      prependMessages(data.list)
      totalMessages.value = data.total || totalMessages.value
      hasMoreHistory.value = messages.value.length < totalMessages.value
    }
  } catch (error) {
    console.error('[ChatWindow] 加载更早消息失败:', error)
    ElMessage.error('加载更早消息失败: ' + (error.message || '未知错误'))
  } finally {
    olderMessagesLoading.value = false
  }
}

const handleMessagesScroll = () => {
  const el = messageRef.value
  if (!el || messagesLoading.value || olderMessagesLoading.value || !hasMoreHistory.value) return
  if (el.scrollTop <= 24) {
    loadOlderMessages()
  }
}

// ========== WebSocket 实时消息处理 ==========
// ChatWindow 使用本地 messages ref，需要单独监听 WebSocket 事件
// 否则新消息只更新了 store.current.messages 但不会显示在对话框中

const handleWsNewMessage = (message) => {
  // 只处理当前会话的消息；同一 socket 可能同时在多个池房间中，重复事件由 upsertMessage 兜底去重
  const currentConvId = props.conversation?.id
  if (!currentConvId || message.conversationId !== currentConvId) return

  upsertMessage(message, { scroll: true })
  if (message.direction === 'outbound' && message.senderType === 'ai') {
    resetAiReplyStatus()
  }
  totalMessages.value = Math.max(totalMessages.value, messages.value.length)
  hasMoreHistory.value = messages.value.length < totalMessages.value
}

const handleWsMessageUpdate = (data) => {
  // 更新消息状态（如 sent → delivered → read）
  const currentConvId = props.conversation?.id
  if (!currentConvId || (data.conversationId && data.conversationId !== currentConvId)) return

  const msgId = data.id || data.messageId
  const idx = messages.value.findIndex(m =>
    (msgId && m.id === msgId) ||
    (data.channelMsgId && m.channelMsgId === data.channelMsgId)
  )
  if (idx !== -1) {
    messages.value[idx] = {
      ...messages.value[idx],
      sendStatus: data.sendStatus || messages.value[idx].sendStatus,
      channelMsgId: data.channelMsgId || messages.value[idx].channelMsgId
    }
  }
}

const clearAiReplyStatusTimer = () => {
  if (aiReplyStatusTimer) {
    clearTimeout(aiReplyStatusTimer)
    aiReplyStatusTimer = null
  }
}

const resetAiReplyStatus = () => {
  clearAiReplyStatusTimer()
  aiReplyStatus.value = { active: false, status: '', jobMarker: null }
}

const scheduleAiReplyStatusExpiry = () => {
  clearAiReplyStatusTimer()
  aiReplyStatusTimer = setTimeout(() => {
    resetAiReplyStatus()
  }, 5 * 60 * 1000)
}

const handleWsAiReplyStatus = (data) => {
  const currentConvId = props.conversation?.id
  if (!currentConvId || data.conversationId !== currentConvId) return

  const activeStatuses = ['queued', 'replying', 'retrying']
  const terminalStatuses = ['done', 'skipped', 'failed', 'transferred']
  const markerMatches = !aiReplyStatus.value.jobMarker ||
    !data.jobMarker ||
    aiReplyStatus.value.jobMarker === data.jobMarker

  if (activeStatuses.includes(data.status)) {
    aiReplyStatus.value = {
      active: true,
      status: data.status,
      jobMarker: data.jobMarker || aiReplyStatus.value.jobMarker || null
    }
    scheduleAiReplyStatusExpiry()
    scrollToBottom()
    return
  }

  if (terminalStatuses.includes(data.status) && markerMatches) {
    resetAiReplyStatus()
  }
}

onMounted(() => {
  websocketService.on('new_message', handleWsNewMessage)
  websocketService.on('message_update', handleWsMessageUpdate)
  websocketService.on('ai_reply_status', handleWsAiReplyStatus)
})

onBeforeUnmount(() => {
  websocketService.off('new_message', handleWsNewMessage)
  websocketService.off('message_update', handleWsMessageUpdate)
  websocketService.off('ai_reply_status', handleWsAiReplyStatus)
  clearAiReplyStatusTimer()
})

const channelLabel = (channel) => {
  const map = {
    whatsapp: 'WhatsApp', douyin: '抖店', 'wechat': '微信小程序', pinduoduo: '拼多多',
    taobao: '淘宝 / 千牛', alibaba1688: '1688', xiaohongshu: '小红书',
    wechat_shop: '微信小店', kuaishou: '快手小店'
  }
  return map[channel] || channel
}

const closeChat = () => {
  conversationStore.clearCurrent()
}

// 采纳 AI 推荐回答 — 填入输入框，客服可编辑后发送
const handleAdopt = (suggestion) => {
  if (chatInputRef.value) {
    chatInputRef.value.setText(suggestion)
    ElMessage.success('已填入输入框，可编辑后发送')
  }
}

// 池类型标签辅助
const poolTagType = (poolType) => {
  const map = { 'ai_self': 'primary', 'pending_human': 'warning', 'public': 'info', 'private': 'danger', 'long_term': 'success' }
  return map[poolType] || 'info'
}
const poolLabel = (poolType) => {
  const map = { 'ai_self': 'AI自助', 'pending_human': '待人工', 'public': '公共池', 'private': '私有', 'long_term': '长期跟进' }
  return map[poolType] || poolType || ''
}
const statusTagType = (status) => {
  const map = { 'ai_serving': 'primary', 'pending_claim': 'warning', 'handling': 'success', 'following': 'success', 'archived': 'info' }
  return map[status] || 'info'
}
const statusLabel = (status) => {
  const map = { 'ai_serving': 'AI服务中', 'pending_claim': '待认领', 'handling': '处理中', 'following': '跟进中', 'archived': '已归档' }
  return map[status] || status || ''
}

// 是否可抢单
const canClaim = computed(() => {
  const pool = props.conversation?.pool_type
  return ['ai_self', 'pending_human', 'public'].includes(pool) &&
    props.conversation?.conv_status !== 'archived'
})

const isAdminUser = computed(() => userStore.userInfo?.role === 'admin')
const claimActionLabel = computed(() => {
  if (isAdminUser.value) return '分配坐席'
  return props.conversation?.pool_type === 'ai_self' ? '接管' : '抢单'
})

// 抢单
const handleClaim = async () => {
  if (!props.conversation?.id) return
  if (isAdminUser.value) {
    assignDialogVisible.value = true
    return
  }
  try {
    const res = await claimConversation(props.conversation.id)
    if (res.success !== false) {
      ElMessage.success('抢单成功')
      if (res.data?.conversation) {
        conversationStore.selectConversation(res.data.conversation)
        conversationStore.updateConversation(res.data.conversation)
      }
      conversationStore.fetchPoolStats()
      conversationStore.fetchSeatLoad()
    } else {
      ElMessage.error(res.message || '抢单失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('抢单失败: ' + (error.message || ''))
    }
  }
}

const handleAssignSeat = async ({ seatId, seat }) => {
  if (!props.conversation?.id || !seatId) return

  assigningSeat.value = true
  try {
    const res = await claimConversation(props.conversation.id, { seat_id: seatId })
    if (res.success !== false) {
      ElMessage.success(`已分配给 ${seat?.username || '目标坐席'}`)
      assignDialogVisible.value = false
      if (res.data?.conversation) {
        conversationStore.selectConversation(res.data.conversation)
        conversationStore.updateConversation(res.data.conversation)
      }
      conversationStore.fetchPoolStats({ force: true })
      conversationStore.fetchSeatLoad({ force: true })
    } else {
      ElMessage.error(res.message || '分配失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('分配失败: ' + (error.message || ''))
    }
  } finally {
    assigningSeat.value = false
  }
}

// 释放
const handleRelease = async () => {
  if (!props.conversation?.id) return
  try {
    await ElMessageBox.confirm(
      '释放后该会话将直接进入归档（本系统当前不使用公共池）。',
      '确认归档',
      { type: 'warning', confirmButtonText: '确认归档', cancelButtonText: '取消' }
    )
    // 释放改为归档：公共池已从界面移除，会话没有可去的地方
    const res = await archiveConversation(props.conversation.id)
    if (res.success !== false) {
      ElMessage.success('已归档')
      conversationStore.removeConversation(props.conversation.id)
      conversationStore.fetchPoolStats()
      conversationStore.fetchSeatLoad()
    } else {
      ElMessage.error(res.message || '释放失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('释放失败: ' + (error.message || ''))
    }
  }
}

// 标记长期跟进
const handleMarkLongTerm = async () => {
  if (!props.conversation?.id) return
  try {
    await ElMessageBox.confirm(
      '确认将该会话标记为长期跟进？标记后将进入长期跟进池。',
      '确认标记',
      { type: 'info', confirmButtonText: '确认', cancelButtonText: '取消' }
    )
    const res = await markLongTerm(props.conversation.id)
    if (res.success !== false) {
      ElMessage.success('已标记为长期跟进')
      conversationStore.removeConversation(props.conversation.id)
      conversationStore.fetchPoolStats()
    } else {
      ElMessage.error(res.message || '标记失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('标记失败: ' + (error.message || ''))
    }
  }
}

// 归档
const handleArchive = async () => {
  if (!props.conversation?.id) return
  try {
    await ElMessageBox.confirm(
      '确认归档该会话？归档后将不再显示在会话列表中。',
      '确认归档',
      { type: 'warning', confirmButtonText: '确认归档', cancelButtonText: '取消' }
    )
    const res = await archiveConversation(props.conversation.id)
    if (res.success !== false) {
      ElMessage.success('会话已归档')
      conversationStore.removeConversation(props.conversation.id)
      conversationStore.fetchPoolStats()
      conversationStore.fetchSeatLoad()
    } else {
      ElMessage.error(res.message || '归档失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('归档失败: ' + (error.message || ''))
    }
  }
}

// 拉取 WhatsApp 历史消息
const handleSyncHistory = async () => {
  if (!props.conversation?.id || syncingHistory.value) return

  syncingHistory.value = true
  try {
    const res = await syncHistory(props.conversation.id, { limit: 100 })
    if (res.success !== false) {
      ElMessage.success(res.message || '历史消息拉取成功')
      await loadMessages(props.conversation)
      // 如果同步时获取到了头像，更新 store
      if (res.data?.avatar) {
        conversationStore.updateConversationAvatar(props.conversation.id, res.data.avatar)
      }
    } else {
      ElMessage.error(res.message || '拉取历史消息失败')
    }
  } catch (error) {
    console.error('[ChatWindow] 拉取历史消息失败:', error)
    ElMessage.error('拉取历史消息失败: ' + (error.message || '未知错误'))
  } finally {
    syncingHistory.value = false
  }
}

const handleCreateOrder = async () => {
  if (!props.conversation?.id || creatingOrder.value) return
  creatingOrder.value = true
  try {
    const res = await createOrderFromConversation(props.conversation.id)
    const order = res.data || {}
    ElMessage.success(order.order_no ? `成交单 ${order.order_no} 已准备好` : '成交单草稿已准备好')
    router.push({ path: '/orders', query: order.id ? { orderId: order.id } : {} })
  } catch (err) {
    ElMessage.error(err.message || '创建成交单失败')
  } finally {
    creatingOrder.value = false
  }
}

const handleSend = async (payload) => {
  if (transportReadOnly.value) return
  if (!props.conversation?.id || sending.value) return

  const isTranslateSend = typeof payload === 'object' && payload?.translateToCustomerLanguage === true
  const isMediaPayload = !isTranslateSend && typeof payload === 'object' && payload?.file
  const messageType = isMediaPayload ? (payload.type || 'file') : 'text'
  const content = isMediaPayload
    ? {
        text: payload.caption || '',
        caption: payload.caption || '',
        fileUrl: payload.file.fullUrl || payload.file.url,
        fileName: payload.file.displayName || payload.file.originalName || payload.file.filename,
        mimeType: payload.file.mimeType,
        mediaFileId: payload.file.id
      }
    : (isTranslateSend ? payload.text : payload)

  sending.value = true
  sendingMode.value = isTranslateSend ? 'translate' : 'send'
  const tempId = 'temp_' + Date.now()
  const retryPayload = { content, messageType, isTranslateSend }
  // 整轮发送（乐观占位 → 服务端确认 → 失败）都用同一个时间戳，
  // 否则状态一变就重新排序、气泡会从底部跳到列表中间。
  const optimisticTs = nextOutboundTimestamp()
  try {
    // 先在本地追加，保证即时体验；后续 API 返回和 WebSocket 回传都通过 upsert 合并到这条临时消息
    // 翻译并发送要等待服务端返回真实译文，避免先把未发送的中文显示成已发送消息。
    if (!isTranslateSend) {
      upsertMessage({
        id: tempId,
        clientId: tempId,
        conversationId: props.conversation.id,
        direction: 'outbound',
        senderType: 'agent',
        content,
        messageType,
        serverTimestamp: optimisticTs,
        sendStatus: 'sending',
        retryPayload
      })
    }

    // 调用 API 发送
    const res = await sendMessage(props.conversation.id, {
      content,
      messageType,
      clientId: tempId,
      translateToCustomerLanguage: isTranslateSend
    })
    const sentContent = res.data?.content || content

    if (isTranslateSend) {
      chatInputRef.value?.clearTextIfMatches(content)
    }

    // 用服务端真实 messageId 合并替换临时消息，等待 message_update 再更新 delivered/failed
    upsertMessage({
      id: res.data?.messageId || tempId,
      clientId: tempId,
      conversationId: props.conversation.id,
      direction: 'outbound',
      senderType: 'agent',
      content: sentContent,
      messageType,
      channelMsgId: res.data?.channelMsgId || null,
      serverTimestamp: optimisticTs,
      // 桌面桥接的发送是**同步等待节点确认**的（bridgeCommandService 会一直等到
      // 节点回报状态或 60 秒超时），所以这里的 sendStatus 就是最终结果：
      // 成功即 sent（绿勾）、失败会走下面的 catch（标红可重试）。
      sendStatus: res.data?.sendStatus || 'sent'
    })
    if (isTranslateSend) {
      const targetLanguage = res.data?.translation?.targetLanguageLabel || '客户语言'
      ElMessage.success(
        res.data?.translation?.applied
          ? `已翻译为${targetLanguage}并发送`
          : `客户语言为${targetLanguage}，已直接发送`
      )
    }
  } catch (error) {
    console.error('[ChatWindow] 发送消息失败:', error)
    if (!isTranslateSend) {
      upsertMessage({
        id: tempId,
        clientId: tempId,
        conversationId: props.conversation.id,
        direction: 'outbound',
        senderType: 'agent',
        content,
        messageType,
        serverTimestamp: optimisticTs,
        sendStatus: 'failed',
        retryPayload
      })
    }
    ElMessage.error(formatSendError(error))
  } finally {
    sending.value = false
    sendingMode.value = ''
  }
}

// 发送失败时把后端给的原因显示出来。桌面桥接的失败原因（会话校验不过、
// 节点未确认等）都在 message 里，只写"发送失败"会让操作员无从下手。
const formatSendError = (error) => {
  const detail = error?.response?.data?.message || error?.message || ''
  return detail ? `发送失败：${detail}` : '发送失败'
}

/**
 * 重试一条发送失败的消息。
 *
 * ⚠️ 重试会**新起一个气泡**，原失败气泡保持红色不动。
 * 原因在后端：`sendOutboundMessage` 每次发送都 INSERT 一条新的 `plat_messages`
 * 行（`errors` 行不会被改写），拿不到"重发同一行"的语义。所以：
 *   - 若把结果合并回原气泡 → 界面显示成功，但库里那行还是 failed，
 *     刷新后红色气泡又回来，用户可能再点一次重试 → 重复发送；
 *   - 新起气泡 → 界面与库一致（一次失败 + 一次成功），不会谎报成功。
 *
 * 不重新走 handleSend：重试沿用原消息的请求负载，否则媒体消息会退化成纯文本。
 */
const handleRetry = async (msg) => {
  if (transportReadOnly.value || !props.conversation?.id || sending.value) return
  if (!msg || msg.sendStatus !== 'failed') return

  const convId = props.conversation.id
  const payload = msg.retryPayload || { content: msg.content, messageType: msg.type || 'text' }
  const { content, messageType, isTranslateSend = false } = payload

  const tempId = 'temp_retry_' + Date.now()
  const optimisticTs = nextOutboundTimestamp()
  upsertMessage({
    id: tempId,
    clientId: tempId,
    conversationId: convId,
    direction: 'outbound',
    senderType: 'agent',
    content,
    messageType,
    serverTimestamp: optimisticTs,
    sendStatus: 'sending',
    retryPayload: payload
  })

  sending.value = true
  sendingMode.value = isTranslateSend ? 'translate' : 'send'
  try {
    const res = await sendMessage(convId, {
      content,
      messageType,
      clientId: tempId,
      translateToCustomerLanguage: isTranslateSend
    })
    upsertMessage({
      id: res.data?.messageId || tempId,
      clientId: tempId,
      conversationId: convId,
      direction: 'outbound',
      senderType: 'agent',
      content: res.data?.content || content,
      messageType,
      channelMsgId: res.data?.channelMsgId || null,
      serverTimestamp: optimisticTs,
      sendStatus: res.data?.sendStatus || 'sent',
      retryPayload: payload
    })
  } catch (error) {
    console.error('[ChatWindow] 重试发送失败:', error)
    upsertMessage({
      id: tempId,
      clientId: tempId,
      conversationId: convId,
      direction: 'outbound',
      senderType: 'agent',
      content,
      messageType,
      serverTimestamp: optimisticTs,
      sendStatus: 'failed',
      retryPayload: payload
    })
    ElMessage.error(formatSendError(error))
  } finally {
    sending.value = false
    sendingMode.value = ''
  }
}
</script>

<style lang="scss" scoped>
.chat-window {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fafafa;

  &__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: #fff;
    border-bottom: 1px solid #e2e8f0;
  }
  &__name { font-size: 15px; font-weight: 600; color: #1e293b; }
  &__ai-notice {
    font-size: 11px;
    color: #e6a23c;
    background: #fdf6ec;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid #f5dab1;
  }
  &__actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  &__messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
  }
  &__transport-notice {
    padding: 8px 16px;
    border-top: 1px solid #f1d0aa;
    background: #fff8ef;
    color: #8a5729;
    font-size: 12px;
    line-height: 18px;
  }
  &__history-loader {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 28px;
    margin-bottom: 8px;
    color: #94a3b8;
    font-size: 12px;
  }
  &__history-end {
    color: #94a3b8;
    font-size: 12px;
  }
  &__ai-replying {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 72%;
    margin: 4px 0 8px;
    padding: 8px 12px;
    color: #475569;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    font-size: 13px;
  }
  &__ai-replying-text {
    white-space: nowrap;
  }
  &__ai-replying-dots {
    display: inline-flex;
    align-items: center;
    gap: 3px;

    i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #94a3b8;
      animation: ai-replying-pulse 1.2s infinite ease-in-out;

      &:nth-child(2) { animation-delay: 0.16s; }
      &:nth-child(3) { animation-delay: 0.32s; }
    }
  }
}

@keyframes ai-replying-pulse {
  0%, 80%, 100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
</style>
