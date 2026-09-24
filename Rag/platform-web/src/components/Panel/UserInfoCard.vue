<template>
  <div class="user-info-card">
    <template v-if="conversation">
      <!-- 用户头部 -->
      <div class="user-info-card__header">
        <div class="user-info-card__avatar-wrap">
          <el-avatar :size="48" :src="conversation.user_avatar">{{ avatarText }}</el-avatar>
          <el-icon
            class="user-info-card__avatar-refresh"
            :class="{ 'is-loading': avatarLoading }"
            @click="refreshAvatar"
            title="刷新头像"
          >
            <Refresh />
          </el-icon>
        </div>
        <div class="user-info-card__info">
          <div class="user-info-card__name">{{ displayName }}</div>
          <div class="user-info-card__channel">
            <el-tag :type="channelTagType(conversation.channel)" size="small" effect="plain">
              {{ channelLabel(conversation.channel) }}
            </el-tag>
            <el-tag v-if="accountTagText" type="success" size="small" effect="plain" style="margin-left: 4px;">
              {{ accountTagText }}
            </el-tag>
            <el-tag v-if="isGroupConversation" type="success" size="small" effect="plain" style="margin-left: 4px;">
              群聊
            </el-tag>
            <el-tag v-if="conversation.pool_type" :type="poolTagType(conversation.pool_type)" size="small" effect="dark" style="margin-left: 4px;">
              {{ poolLabel(conversation.pool_type) }}
            </el-tag>
            <el-tag v-if="conversation.conv_status" :type="statusTagType(conversation.conv_status)" size="small" effect="plain" style="margin-left: 4px;">
              {{ statusLabel(conversation.conv_status) }}
            </el-tag>
          </div>
        </div>
      </div>

      <!-- ID 信息区 -->
      <div class="user-info-card__section">
        <div class="user-info-card__section-title">标识信息</div>
        <div class="info-row" v-for="item in idFields" :key="item.label">
          <span class="info-label">{{ item.label }}</span>
          <div class="info-value-wrapper">
            <span class="info-value" :title="item.value">{{ item.value || '-' }}</span>
            <el-icon v-if="item.value" class="copy-icon" @click="copyText(item.value, item.label)"><CopyDocument /></el-icon>
          </div>
        </div>
      </div>

      <!-- 客户属性 -->
      <div class="user-info-card__section">
        <div class="user-info-card__section-title">客户属性</div>
        <div class="info-row nationality-row">
          <span class="info-label">国籍</span>
          <div v-if="nationalityEditing" class="nationality-editor">
            <el-select
              v-model="nationalityDraft"
              filterable
              clearable
              size="small"
              placeholder="选择国籍"
              :loading="dictionaryLoading"
            >
              <el-option
                v-for="item in nationalityOptions"
                :key="item.code"
                :label="`${item.name} (${item.code})`"
                :value="item.code"
              />
            </el-select>
            <el-tooltip content="保存国籍" placement="top">
              <el-button text :icon="Check" :loading="nationalitySaving" @click="saveNationality" />
            </el-tooltip>
            <el-tooltip content="取消编辑" placement="top">
              <el-button text :icon="Close" :disabled="nationalitySaving" @click="cancelNationalityEdit" />
            </el-tooltip>
          </div>
          <div v-else class="nationality-display">
            <div class="nationality-value">
              <span class="info-value">{{ nationalityText }}</span>
              <el-tag v-if="conversation.nationality_source" size="small" type="info" effect="plain">
                {{ nationalitySourceText }}
              </el-tag>
            </div>
            <div class="nationality-actions">
              <el-tooltip :content="conversation.nationality_code ? '根据手机号或会话语言重新推测' : '根据手机号或会话语言推测'" placement="top">
                <span>
                  <el-button
                    text
                    :icon="MagicStick"
                    :loading="nationalityInferring"
                    @click="inferNationality"
                  />
                </span>
              </el-tooltip>
              <el-tooltip content="编辑国籍" placement="top">
                <el-button text :icon="Edit" @click="startNationalityEdit" />
              </el-tooltip>
            </div>
          </div>
        </div>
      </div>

      <!-- 会话状态区 -->
      <div class="user-info-card__section">
        <div class="user-info-card__section-title">会话状态</div>
        <div class="info-row" v-for="item in statusFields" :key="item.label">
          <span class="info-label">{{ item.label }}</span>
          <div class="info-value-wrapper">
            <span class="info-value" :class="item.tagClass">{{ item.value || '-' }}</span>
          </div>
        </div>
      </div>

      <!-- 标签 -->
      <div class="user-info-card__section">
        <div class="user-info-card__section-title">标签</div>
        <div class="user-info-card__tags">
          <el-tag v-for="tag in tags" :key="tag" closable size="small" @close="removeTag(tag)">{{ tag }}</el-tag>
          <el-input v-if="inputVisible" v-model="inputValue" size="small" style="width: 100px" @keyup.enter="addTag" @blur="addTag" />
          <el-button v-else size="small" @click="inputVisible = true">+ 标签</el-button>
        </div>
      </div>
    </template>
    <EmptyState v-else description="暂无用户信息" />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Close, CopyDocument, Edit, MagicStick, Refresh } from '@element-plus/icons-vue'
import EmptyState from '@/components/Common/EmptyState.vue'
import {
  fetchAvatar,
  getNationalityDictionary,
  inferConversationNationality,
  updateConversation
} from '@/api/conversations'
import { getConversationAvatarText, getConversationDisplayName, getConversationIdLabel, isWhatsAppGroupConversation } from '@/utils/conversationDisplay'

const props = defineProps({
  conversation: { type: Object, default: null }
})
const emit = defineEmits(['avatar-updated', 'nationality-updated'])

const tags = ref([])
const inputVisible = ref(false)
const inputValue = ref('')
const avatarLoading = ref(false)
const nationalityOptions = ref([])
const nationalityDraft = ref(null)
const nationalityEditing = ref(false)
const dictionaryLoading = ref(false)
const nationalitySaving = ref(false)
const nationalityInferring = ref(false)

const displayName = computed(() => getConversationDisplayName(props.conversation))
const avatarText = computed(() => getConversationAvatarText(props.conversation))
const isGroupConversation = computed(() => isWhatsAppGroupConversation(props.conversation))

watch(() => props.conversation, (val) => {
  if (val) {
    tags.value = val.tags || []
    nationalityDraft.value = val.nationality_code || null
    nationalityEditing.value = false
  }
}, { immediate: true })

const nationalityText = computed(() => {
  const c = props.conversation || {}
  return c.nationality_name
    ? `${c.nationality_name}${c.nationality_code ? ` (${c.nationality_code})` : ''}`
    : '-'
})

const nationalitySourceText = computed(() => {
  const map = { phone: '手机号推测', language: '语言推测', manual: '手动设置' }
  return map[props.conversation?.nationality_source] || ''
})

// ========== 渠道/池/状态标签映射 ==========
const channelLabel = (channel) => {
  const map = {
    whatsapp: 'WhatsApp', douyin: '抖店', wechat: '微信小程序', toutiao: '头条',
    pinduoduo: '拼多多', taobao: '淘宝 / 千牛', alibaba1688: '1688',
    xiaohongshu: '小红书', wechat_shop: '微信小店', kuaishou: '快手小店'
  }
  return map[channel] || channel || '未知'
}

const channelTagType = (channel) => {
  const map = {
    whatsapp: 'success', douyin: 'info', wechat: 'success', toutiao: 'danger',
    pinduoduo: 'warning', taobao: 'danger', alibaba1688: 'success',
    xiaohongshu: 'danger', wechat_shop: 'success', kuaishou: 'warning'
  }
  return map[channel] || 'info'
}

const poolLabel = (poolType) => {
  const map = { 'ai_self': 'AI自助', 'pending_human': '待人工', 'public': '公共池', 'private': '私有', 'long_term': '长期跟进' }
  return map[poolType] || poolType || ''
}

const poolTagType = (poolType) => {
  const map = { 'ai_self': 'primary', 'pending_human': 'warning', 'public': 'info', 'private': 'danger', 'long_term': 'success' }
  return map[poolType] || 'info'
}

const statusLabel = (status) => {
  const map = { 'ai_serving': 'AI服务中', 'pending_claim': '待认领', 'handling': '处理中', 'following': '跟进中', 'archived': '已归档' }
  return map[status] || status || ''
}

const statusTagType = (status) => {
  const map = { 'ai_serving': 'primary', 'pending_claim': 'warning', 'handling': '', 'following': 'success', 'archived': 'info' }
  return map[status] || 'info'
}

const accountTagText = computed(() => {
  const c = props.conversation || {}
  return c.whatsapp_name || c.account_name || ''
})

// ========== ID 信息字段 ==========
const idFields = computed(() => {
  const c = props.conversation || {}
  return [
    { label: '统一会话ID', value: c.id },
    { label: isGroupConversation.value ? '群聊标识' : '客户手机号', value: isGroupConversation.value ? displayName.value : c.customer_phone },
    { label: getConversationIdLabel(c), value: c.user_id },
    { label: '渠道账号ID', value: c.account_id != null ? String(c.account_id) : '' },
    { label: '来源平台', value: channelLabel(c.channel) },
  ]
})

// ========== 会话状态字段 ==========
const formatTime = (time) => {
  if (!time) return ''
  const d = new Date(time)
  if (isNaN(d.getTime())) return time
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const lastReplyByText = (by) => {
  const map = { 'ai': 'AI', 'customer': '客户', 'agent': '坐席' }
  return map[by] || by || ''
}

const statusFields = computed(() => {
  const c = props.conversation || {}
  return [
    { label: '归属坐席', value: c.claimed_by_name || (c.agent_name || '') },
    { label: '最后回复方', value: lastReplyByText(c.last_reply_by), tagClass: c.last_reply_by === 'ai' ? 'text-primary' : '' },
    { label: '最后回复时间', value: formatTime(c.last_reply_time) },
    { label: '最后消息', value: c.last_message ? (c.last_message.length > 30 ? c.last_message.substring(0, 30) + '...' : c.last_message) : '' },
    { label: 'AI 回复轮数', value: c.ai_reply_count != null ? String(c.ai_reply_count) : '', tagClass: 'text-warning' },
    { label: '客户消息数', value: c.inbound_count != null ? String(c.inbound_count) : '' },
    { label: '未读消息', value: c.unread_count > 0 ? String(c.unread_count) : '', tagClass: c.unread_count > 0 ? 'text-danger' : '' },
    { label: '创建时间', value: formatTime(c.created_at) },
  ]
})

// ========== 操作 ==========
const removeTag = (tag) => { tags.value = tags.value.filter(t => t !== tag) }
const addTag = () => {
  if (inputValue.value.trim()) tags.value.push(inputValue.value.trim())
  inputVisible.value = false
  inputValue.value = ''
}

const copyText = (text, label) => {
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success(`${label}已复制`)
  }).catch(() => {
    ElMessage.warning('复制失败')
  })
}

const ensureNationalityOptions = async () => {
  if (nationalityOptions.value.length > 0 || dictionaryLoading.value) return
  dictionaryLoading.value = true
  try {
    const res = await getNationalityDictionary()
    nationalityOptions.value = res.data || []
  } finally {
    dictionaryLoading.value = false
  }
}

const startNationalityEdit = async () => {
  nationalityDraft.value = props.conversation?.nationality_code || null
  nationalityEditing.value = true
  try {
    await ensureNationalityOptions()
  } catch {
    nationalityEditing.value = false
  }
}

const cancelNationalityEdit = () => {
  nationalityDraft.value = props.conversation?.nationality_code || null
  nationalityEditing.value = false
}

const applyNationalityUpdate = (data) => {
  emit('nationality-updated', {
    id: props.conversation.id,
    nationality_code: data?.nationality_code || null,
    nationality_name: data?.nationality_name || null,
    nationality_name_en: data?.nationality_name_en || null,
    nationality_source: data?.nationality_source || null,
    nationality_inferred_at: data?.nationality_inferred_at || null
  })
}

const saveNationality = async () => {
  if (!props.conversation?.id || nationalitySaving.value) return
  nationalitySaving.value = true
  try {
    const res = await updateConversation(props.conversation.id, {
      nationality_code: nationalityDraft.value || null
    })
    applyNationalityUpdate(res.data)
    nationalityEditing.value = false
    ElMessage.success(nationalityDraft.value ? '国籍已更新' : '国籍已清空')
  } finally {
    nationalitySaving.value = false
  }
}

const inferNationality = async () => {
  if (!props.conversation?.id || nationalityInferring.value) return
  nationalityInferring.value = true
  try {
    const res = await inferConversationNationality(props.conversation.id)
    if (res.data?.nationality_code) {
      applyNationalityUpdate(res.data)
      ElMessage.success(res.message || '国籍推测完成')
    } else {
      ElMessage.warning(res.message || '当前信息不足以推测国籍')
    }
  } finally {
    nationalityInferring.value = false
  }
}

// ========== 刷新头像 ==========
const refreshAvatar = async () => {
  if (!props.conversation?.id || avatarLoading.value) return
  avatarLoading.value = true
  try {
    const res = await fetchAvatar(props.conversation.id, true)
    if (res.success && res.data?.avatar) {
      emit('avatar-updated', { id: props.conversation.id, avatar: res.data.avatar })
      ElMessage.success('头像已更新')
    } else {
      ElMessage.warning(res.message || '未获取到头像')
    }
  } catch (err) {
    ElMessage.error('刷新头像失败')
  } finally {
    avatarLoading.value = false
  }
}
</script>

<style lang="scss" scoped>
.user-info-card {
  &__header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid #f1f5f9;
  }

  &__avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  &__avatar-refresh {
    position: absolute;
    bottom: -2px;
    right: -2px;
    width: 18px;
    height: 18px;
    background: #fff;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: #64748b;
    cursor: pointer;
    border: 1px solid #e2e8f0;
    transition: all 0.2s;

    &:hover {
      color: #3b82f6;
      border-color: #3b82f6;
    }

    &.is-loading {
      animation: rotating 1.5s linear infinite;
      pointer-events: none;
    }
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-size: 16px;
    font-weight: 600;
    color: #1e293b;
    margin-bottom: 6px;
  }

  &__channel {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
  }

  &__section {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f1f5f9;

    &:last-child {
      border-bottom: none;
    }
  }

  &__section-title {
    font-size: 12px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }

  &__tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  gap: 8px;
}

.info-label {
  font-size: 12px;
  color: #94a3b8;
  flex-shrink: 0;
  white-space: nowrap;
}

.info-value-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
  justify-content: flex-end;
}

.nationality-row {
  align-items: flex-start;
}

.nationality-display,
.nationality-editor {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.nationality-editor :deep(.el-select) {
  width: 160px;
}

.nationality-value {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.nationality-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.nationality-actions :deep(.el-button),
.nationality-editor :deep(.el-button) {
  width: 28px;
  height: 28px;
  margin-left: 0;
}

.info-value {
  font-size: 12px;
  color: #475569;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
  font-family: 'Courier New', monospace;

  &.text-primary { color: #3b82f6; font-weight: 500; }
  &.text-warning { color: #e6a23c; font-weight: 500; }
  &.text-danger { color: #f56c6c; font-weight: 600; }
}

.copy-icon {
  font-size: 13px;
  color: #cbd5e1;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.2s;

  &:hover {
    color: #3b82f6;
  }
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
