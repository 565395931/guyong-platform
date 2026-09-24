<template>
  <div class="conversation-item" :class="{ 'is-active': isActive, 'is-highlighted': isHighlighted }" @click="$emit('click', conversation)">
    <el-avatar :size="40" :src="conversation.user_avatar">{{ avatarText }}</el-avatar>
    <div class="conversation-item__content">
      <!-- 第一行：用户名 + 时间 -->
      <div class="conversation-item__header">
        <div class="conversation-item__name-wrap">
          <span class="conversation-item__name">{{ displayName }}</span>
          <el-tag v-if="isGroupConversation" size="small" type="success" effect="plain" class="conversation-item__group-tag">群聊</el-tag>
          <el-tag v-if="conversation.priority >= 2" size="small" type="danger" effect="dark" class="conversation-item__priority">加急</el-tag>
          <el-tag v-else-if="conversation.priority === 1" size="small" type="warning" effect="dark" class="conversation-item__priority">紧急</el-tag>
        </div>
        <span class="conversation-item__time">{{ formatTime(conversation.last_message_time) }}</span>
      </div>

      <!-- 第二行：最后消息 + 未读 -->
      <div class="conversation-item__body">
        <span class="conversation-item__message">{{ conversation.last_message }}</span>
        <el-badge v-if="conversation.unread_count > 0" :value="conversation.unread_count" class="conversation-item__badge" />
      </div>

      <!-- 搜索匹配的消息预览 -->
      <div v-if="conversation.matched_text" class="conversation-item__search-match">
        <el-icon size="11" color="#909399"><ChatLineRound /></el-icon>
        <span class="conversation-item__match-text">{{ conversation.matched_text }}</span>
      </div>

      <!-- 第三行：标签栏 -->
      <div class="conversation-item__footer">
        <!-- 渠道标签 -->
        <el-tag size="small" :type="channelTagType(conversation.channel)" effect="plain">{{ channelLabel(conversation.channel) }}</el-tag>
        <!-- 池类型标签 -->
        <el-tag size="small" :type="poolTagType(conversation.pool_type)" effect="dark" class="conversation-item__pool-tag">
          {{ poolLabel(conversation.pool_type) }}
        </el-tag>
        <!-- 会话状态 -->
        <el-tag size="small" :type="statusTagType(conversation.conv_status)" effect="plain" class="conversation-item__status-tag">
          {{ statusLabel(conversation.conv_status) }}
        </el-tag>
        <el-tag
          v-if="showSeatOwner"
          size="small"
          type="warning"
          effect="plain"
          class="conversation-item__owner-tag"
        >
          坐席：{{ seatOwnerName }}
        </el-tag>
      </div>

      <!-- 第四行：回复方 + 等待时长 + AI回复轮数 -->
      <div v-if="conversation.last_reply_by || waitDuration || showAiRoundInfo" class="conversation-item__meta">
        <span v-if="conversation.last_reply_by" class="conversation-item__reply-by" :class="`reply-by--${conversation.last_reply_by}`">
          <el-icon v-if="conversation.last_reply_by === 'ai'" size="10"><Monitor /></el-icon>
          <el-icon v-if="conversation.last_reply_by === 'customer'" size="10"><User /></el-icon>
          <el-icon v-if="conversation.last_reply_by === 'agent'" size="10"><Service /></el-icon>
          {{ replyByLabel(conversation.last_reply_by) }}
        </span>
        <span v-if="showAiRoundInfo" class="conversation-item__ai-rounds" :class="{ 'is-over-limit': aiRoundsOverLimit }">
          AI已回复{{ conversation.ai_reply_count }}轮
        </span>
        <span v-if="waitDuration" class="conversation-item__wait">
          等待 {{ waitDuration }}
        </span>
      </div>

      <!-- AI自助池：客户不知情提示 -->
      <div v-if="conversation.pool_type === 'ai_self'" class="conversation-item__ai-notice">
        客户不知情是AI，接管后请自然承接
      </div>

      <!-- 操作按钮区域 -->
      <div v-if="showActions" class="conversation-item__actions">
        <!-- AI自助池 / 待人工池 / 公共池 → 抢单按钮 -->
        <el-button
          v-if="canClaim"
          type="primary"
          size="small"
          :icon="Pointer"
          @click.stop="$emit('claim', conversation)"
        >
          {{ claimButtonLabel }}
        </el-button>

        <!-- 私有池 → 释放 / 标记长期 / 归档 -->
        <template v-if="conversation.pool_type === 'private'">
          <el-button type="warning" size="small" plain :icon="Top" @click.stop="$emit('release', conversation)">释放</el-button>
          <el-button type="primary" size="small" plain :icon="Monitor" @click.stop="$emit('transfer-to-ai', conversation)">转AI</el-button>
          <el-button type="success" size="small" plain :icon="Star" @click.stop="$emit('mark-long-term', conversation)">长期</el-button>
          <el-button type="info" size="small" plain :icon="Check" @click.stop="$emit('archive', conversation)">归档</el-button>
        </template>

        <!-- 非 AI、非归档会话 → 可手动转回 AI 自助池 -->
        <el-button
          v-if="canTransferToAi && conversation.pool_type !== 'private'"
          type="primary"
          size="small"
          plain
          :icon="Monitor"
          @click.stop="$emit('transfer-to-ai', conversation)"
        >
          转AI
        </el-button>

        <!-- 归档会话 → 复活按钮 -->
        <el-button
          v-if="conversation.conv_status === 'archived'"
          type="primary"
          size="small"
          plain
          :icon="RefreshRight"
          @click.stop="$emit('revive', conversation)"
        >
          复活
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import dayjs from 'dayjs'
import { computed } from 'vue'
import { Monitor, User, Service, Pointer, Top, Star, Check, RefreshRight, ChatLineRound } from '@element-plus/icons-vue'
import { useConversationStore } from '@/stores/conversation'
import { useUserStore } from '@/stores/user'
import { getConversationAvatarText, getConversationDisplayName, isWhatsAppGroupConversation } from '@/utils/conversationDisplay'

const props = defineProps({
  conversation: { type: Object, required: true },
  isActive: { type: Boolean, default: false },
  isHighlighted: { type: Boolean, default: false },
  showActions: { type: Boolean, default: false }
})

defineEmits(['click', 'claim', 'release', 'mark-long-term', 'archive', 'revive', 'transfer-to-ai'])

const conversationStore = useConversationStore()
const userStore = useUserStore()

const displayName = computed(() => getConversationDisplayName(props.conversation))
const avatarText = computed(() => getConversationAvatarText(props.conversation))
const isGroupConversation = computed(() => isWhatsAppGroupConversation(props.conversation))
const isAdminUser = computed(() => userStore.userInfo?.role === 'admin')

const formatTime = (time) => {
  if (!time) return ''
  const d = dayjs(time)
  const now = dayjs()
  if (d.isSame(now, 'day')) return d.format('HH:mm')
  return d.format('MM-DD')
}

// 等待时长（客户最后消息距今的时间差）
const waitDuration = computed(() => {
  const lastTime = props.conversation.last_message_time
  if (!lastTime) return ''
  const diff = Date.now() - new Date(lastTime).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  return `${days}天`
})

// AI 自助池回复轮数显示
const showAiRoundInfo = computed(() => {
  return props.conversation.pool_type === 'ai_self' && (props.conversation.ai_reply_count || 0) > 0
})

// AI 回复轮数是否超限（超过1轮就高亮提示"建议人工介入"）
const aiRoundsOverLimit = computed(() => {
  return (props.conversation.ai_reply_count || 0) >= 2
})

// 是否可抢单（非私有池且非归档）
const canClaim = computed(() => {
  const pool = props.conversation.pool_type
  return ['ai_self', 'pending_human', 'public'].includes(pool) &&
    props.conversation.conv_status !== 'archived'
})

const claimButtonLabel = computed(() => {
  if (isAdminUser.value) return '分配坐席'
  return props.conversation.pool_type === 'ai_self' ? '接管' : '抢单'
})

const canTransferToAi = computed(() => {
  return props.conversation.pool_type !== 'ai_self' &&
    props.conversation.conv_status !== 'archived'
})

const showSeatOwner = computed(() => {
  return ['private', 'long_term'].includes(props.conversation.pool_type) && seatOwnerName.value
})

const seatOwnerName = computed(() => {
  return props.conversation.claimed_by_name || props.conversation.agent_name || ''
})

const channelTagType = (channel) => {
  const map = {
    whatsapp: 'success', douyin: 'info', wechat: 'success', pinduoduo: 'warning',
    taobao: 'danger', alibaba1688: 'success', xiaohongshu: 'danger',
    wechat_shop: 'success', kuaishou: 'warning'
  }
  return map[channel] || 'info'
}

const channelLabel = (channel) => {
  const map = {
    whatsapp: 'WhatsApp', douyin: '抖店', 'wechat': '微信小程序', pinduoduo: '拼多多',
    taobao: '淘宝 / 千牛', alibaba1688: '1688', xiaohongshu: '小红书',
    wechat_shop: '微信小店', kuaishou: '快手小店'
  }
  return map[channel] || channel
}

const poolTagType = (poolType) => {
  const map = {
    'ai_self': 'primary',
    'pending_human': 'warning',
    'public': 'info',
    'private': 'danger',
    'long_term': 'success'
  }
  return map[poolType] || 'info'
}

const poolLabel = (poolType) => {
  const map = {
    'ai_self': 'AI自助',
    'pending_human': '待人工',
    'public': '公共池',
    'private': '私有',
    'long_term': '长期跟进'
  }
  return map[poolType] || poolType || ''
}

const statusTagType = (status) => {
  const map = {
    'ai_serving': 'primary',
    'pending_claim': 'warning',
    'handling': 'success',
    'following': 'success',
    'archived': 'info'
  }
  return map[status] || 'info'
}

const statusLabel = (status) => {
  const map = {
    'ai_serving': 'AI服务中',
    'pending_claim': '待认领',
    'handling': '处理中',
    'following': '跟进中',
    'archived': '已归档'
  }
  return map[status] || status || ''
}

const replyByLabel = (replyBy) => {
  const map = { 'ai': 'AI', 'customer': '客户', 'agent': '坐席' }
  return map[replyBy] || replyBy || ''
}
</script>

<style lang="scss" scoped>
.conversation-item {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.2s;

  &:hover {
    background: #f1f5f9;

    .conversation-item__actions {
      opacity: 1;
      max-height: 40px;
    }
  }

  &.is-active {
    background: #eff6ff;
    border-left-color: #3b82f6;
  }

  &.is-highlighted:not(.is-active) {
    animation: new-message-pulse 1.4s ease-in-out infinite;
    border-left-color: #f59e0b;
  }

  &__content {
    flex: 1;
    min-width: 0;
  }

  &__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  &__name-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  &__name {
    font-size: 14px;
    font-weight: 500;
    color: #1e293b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__priority {
    flex-shrink: 0;
    font-size: 10px;
  }

  &__group-tag {
    flex-shrink: 0;
    font-size: 10px;
  }

  &__time {
    font-size: 12px;
    color: #94a3b8;
    flex-shrink: 0;
    margin-left: 8px;
  }

  &__body {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  &__message {
    font-size: 13px;
    color: #64748b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  &__badge {
    flex-shrink: 0;
  }

  &__search-match {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    margin-bottom: 4px;
    padding: 4px 8px;
    background: #f0f7ff;
    border-left: 3px solid #409eff;
    border-radius: 2px;
  }

  &__match-text {
    font-size: 12px;
    color: #5a6c7d;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  &__footer {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 2px;
  }

  &__pool-tag,
  &__status-tag,
  &__owner-tag {
    font-size: 10px;
  }

  &__owner-tag {
    max-width: 120px;

    :deep(.el-tag__content) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &__meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: #94a3b8;
    margin-bottom: 4px;
  }

  &__reply-by {
    display: flex;
    align-items: center;
    gap: 2px;

    &--ai { color: #6366f1; }
    &--customer { color: #f59e0b; }
    &--agent { color: #10b981; }
  }

  &__wait {
    color: #ef4444;
    font-weight: 500;
  }

  &__ai-rounds {
    font-size: 11px;
    color: #6366f1;
    display: flex;
    align-items: center;
    gap: 2px;

    &.is-over-limit {
      color: #ef4444;
      font-weight: 500;
    }
  }

  &__ai-notice {
    font-size: 10px;
    color: #e6a23c;
    background: #fdf6ec;
    padding: 2px 6px;
    border-radius: 4px;
    margin-bottom: 2px;
    line-height: 1.4;
  }

  &__actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 8px;
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    transition: all 0.2s ease;

    .el-button {
      margin: 0;
    }
  }
}

// 在私有池 Tab 下，操作按钮始终可见
.conversation-item:has(.conversation-item__actions .el-button) {
  .conversation-item__actions {
    opacity: 1;
    max-height: 40px;
  }
}

@keyframes new-message-pulse {
  0%, 100% {
    background: #fff7ed;
    box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.12);
  }

  50% {
    background: #fffbeb;
    box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.32);
  }
}
</style>
