<template>
  <div class="conversation-list">
    <!-- 池 Tab 布局 -->
    <div class="conversation-list__tabs">
      <div
        v-for="tab in visibleTabs"
        :key="tab.key"
        class="pool-tab"
        :class="{
          'pool-tab--active': conversationStore.activePoolTab === tab.key,
          'pool-tab--flashing': conversationStore.flashingPoolTabs.includes(tab.key)
        }"
        :title="tab.label"
        @click="switchTab(tab.key)"
      >
        <el-icon class="pool-tab__icon" :size="14">
          <component :is="tab.icon" />
        </el-icon>
        <span class="pool-tab__label">{{ tab.short }}</span>
        <span
          class="pool-tab__count"
          :class="`pool-tab__count--${tab.badgeType || 'primary'}`"
        >{{ getTabCount(tab.key) }}</span>
      </div>
    </div>

    <!-- AI 自助池提示条 -->
    <div v-if="!globalSearch && conversationStore.activePoolTab === 'ai_self'" class="ai-pool-notice">
      <el-icon size="14" color="#e6a23c"><WarningFilled /></el-icon>
      <span>客户未被告知是 AI，请接管后自然承接话术，勿提及 AI/机器人</span>
    </div>

    <!-- 待人工池提示条 -->
    <div v-if="!globalSearch && conversationStore.activePoolTab === 'pending_human'" class="pending-pool-notice">
      <el-icon size="14" color="#f56c6c"><BellFilled /></el-icon>
      <span>待人工池为高优先级，请尽快抢单处理</span>
    </div>

    <!-- 工具栏 -->
    <div class="conversation-list__header">
      <div class="conversation-list__toolbar">
        <el-select
          v-model="selectedChannels"
          multiple
          collapse-tags
          placeholder="渠道筛选"
          size="small"
          style="flex: 1"
          :disabled="globalSearch || channelScope.filterLocked"
        >
          <el-option label="WhatsApp" value="whatsapp" />
          <el-option label="微信客服" value="wecom_kf" />
          <el-option label="微信小程序" value="wechat" />
          <el-option label="抖音" value="douyin" disabled />
        </el-select>
      </div>
      <div class="conversation-list__search-wrap">
        <el-input
          v-model="searchKeyword"
          :placeholder="globalSearch ? '全局搜索会话和聊天记录' : '搜索当前池会话'"
          size="small"
          :prefix-icon="Search"
          clearable
          style="margin-top: 8px"
        />
        <el-tooltip content="开启后跨所有池搜索，包括聊天记录内容" placement="top">
          <el-switch
            v-model="globalSearch"
            size="small"
            active-text="全局"
            class="conversation-list__global-toggle"
            :disabled="channelScope.filterLocked"
            @change="handleGlobalToggle"
          />
        </el-tooltip>
      </div>
      <!-- 全局搜索：时间范围筛选（开启全局即显示） -->
      <div v-if="globalSearch" class="conversation-list__search-meta">
        <span v-if="searchKeyword" class="conversation-list__search-count">
          <el-icon size="12"><Search /></el-icon>
          <span v-if="searching">搜索中...</span>
          <span v-else>找到 {{ searchTotal }} 条结果</span>
        </span>
        <span v-else class="conversation-list__search-count">选择时间范围后输入关键词搜索</span>
        <div class="conversation-list__time-range">
          <span
            v-for="opt in timeRangeOptions"
            :key="opt.value"
            class="time-range-btn"
            :class="{ 'time-range-btn--active': searchTimeRange === opt.value }"
            @click="searchTimeRange = opt.value"
          >{{ opt.label }}</span>
        </div>
      </div>
    </div>

    <!-- 会话列表 -->
    <div class="conversation-list__body">
      <LoadingSkeleton v-if="loading || searching" :rows="5" />
      <template v-else-if="filteredList.length > 0">
        <ConversationItem
          v-for="conv in filteredList"
          :key="conv.id"
          :conversation="conv"
          :is-active="conv.id === conversationStore.current?.id"
          :is-highlighted="conversationStore.highlightedConversationIds.includes(conv.id)"
          :show-actions="true"
          @click="handleSelect"
          @claim="handleClaim"
          @release="handleRelease"
          @mark-long-term="handleMarkLongTerm"
          @archive="handleArchive"
          @revive="handleRevive"
          @transfer-to-ai="handleTransferToAi"
        />
      </template>
      <EmptyState v-else :description="emptyDescription" />
    </div>

    <AssignSeatDialog
      v-model="assignDialogVisible"
      :conversation="assignTargetConversation"
      :submitting="assigningSeat"
      @confirm="handleAssignSeat"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, markRaw } from 'vue'
import {
  Search, WarningFilled, BellFilled,
  Bell, Monitor, Share, Clock, UserFilled, Box
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useConversationStore } from '@/stores/conversation'
import { useUserStore } from '@/stores/user'
import {
  getConversations,
  searchConversations,
  claimConversation,
  releaseConversation,
  markLongTerm,
  archiveConversation,
  reviveConversation,
  transferToAi
} from '@/api/conversations'
import ConversationItem from './ConversationItem.vue'
import AssignSeatDialog from './AssignSeatDialog.vue'
import EmptyState from '@/components/Common/EmptyState.vue'
import LoadingSkeleton from '@/components/Common/LoadingSkeleton.vue'
import { resolveChannelScope } from '@/modules/conversations/channelScope'

const props = defineProps({
  fixedChannel: { type: String, default: '' },
  channelLabel: { type: String, default: '全部渠道' },
  accountId: { type: [String, Number], default: '' }
})
const conversationStore = useConversationStore()
const userStore = useUserStore()

const channelScope = computed(() => resolveChannelScope(props.fixedChannel))
const selectedChannels = ref([...channelScope.value.selectedChannels])
const searchKeyword = ref('')
const loading = ref(false)
const globalSearch = ref(false)
const searching = ref(false)
const searchTotal = ref(0)
const searchTimeRange = ref('7d') // 默认7天
const REQUEST_TIMEOUT_MS = 15000
const assignDialogVisible = ref(false)
const assignTargetConversation = ref(null)
const assigningSeat = ref(false)
const isAdminUser = computed(() => userStore.userInfo?.role === 'admin')
let searchDebounceTimer = null
let loadAbortController = null
let searchAbortController = null
let loadRequestSeq = 0
let searchRequestSeq = 0
let hiddenAt = 0

const createTimedAbortController = () => {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  return {
    controller,
    signal: controller.signal,
    hasTimedOut: () => timedOut,
    cleanup: () => clearTimeout(timer)
  }
}

const cancelLoadRequest = () => {
  if (loadAbortController) {
    loadAbortController.abort()
    loadAbortController = null
  }
}

const cancelSearchRequest = () => {
  if (searchAbortController) {
    searchAbortController.abort()
    searchAbortController = null
  }
}

// 时间范围选项（从小到大）
const timeRangeOptions = [
  { label: '今日', value: 'today' },
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '90天', value: '90d' },
  { label: '全部', value: 'all' }
]

// 根据时间范围计算 start_date
const getTimeRangeParams = () => {
  if (searchTimeRange.value === 'all') return {}
  const now = new Date()
  let startDate
  if (searchTimeRange.value === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else {
    const days = parseInt(searchTimeRange.value)
    startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  }
  return { start_date: startDate.toISOString().slice(0, 10) }
}

// ========== 池 Tab 定义 ==========
// 待人工池置顶（最高优先级），AI自助池第二，公共池第三
const poolTabs = [
  { key: 'pending_human', label: '待人工', short: '待人工', badgeType: 'danger',   icon: markRaw(Bell) },
  { key: 'ai_self',       label: 'AI自助', short: 'AI',     badgeType: 'primary',  icon: markRaw(Monitor) },
  { key: 'public',        label: '公共池', short: '公共',   badgeType: 'info',     icon: markRaw(Share) },
  { key: 'long_term',     label: '长期跟进', short: '长期', badgeType: 'success',  icon: markRaw(Clock) },
  { key: 'private',       label: '我的会话', short: '我的', badgeType: 'warning',  icon: markRaw(UserFilled) },
  { key: 'archived',      label: '已归档', short: '归档',   badgeType: 'info',     icon: markRaw(Box) }
]

// 会话池 Tab 列表
const visibleTabs = computed(() => {
  return poolTabs
})

// 获取 Tab 角标数量
const getTabCount = (tabKey) => {
  if (tabKey === 'archived') return conversationStore.poolStats.archived || 0
  return conversationStore.poolStats[tabKey] || 0
}

// 空状态描述
const emptyDescription = computed(() => {
  if (globalSearch.value) {
    return searchKeyword.value ? '未找到匹配的会话' : '请输入关键词搜索'
  }
  const tab = conversationStore.activePoolTab
  const map = {
    pending_human: '待人工池暂无会话',
    ai_self: 'AI 自助池暂无会话',
    public: '公共池暂无会话',
    long_term: '长期跟进池暂无会话',
    private: '您当前没有正在处理的会话',
    archived: '暂无归档会话'
  }
  const description = map[tab] || '暂无会话'
  return channelScope.value.filterLocked
    ? `${props.channelLabel} · ${description}`
    : description
})

// ========== Tab 切换 ==========
const switchTab = (tabKey) => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  cancelSearchRequest()
  searchRequestSeq++
  globalSearch.value = false
  searching.value = false
  searchTotal.value = 0
  conversationStore.setPoolTab(tabKey)
  loadConversations()
}

// ========== 前端筛选（仅在非全局搜索时做本地过滤） ==========
const filteredList = computed(() => {
  if (globalSearch.value) {
    // 全局搜索：后端已过滤，前端不再二次过滤
    return conversationStore.list
  }
  const activeTab = conversationStore.activePoolTab
  return conversationStore.list.filter(conv => {
    const poolMatch = activeTab === 'archived'
      ? conv.conv_status === 'archived'
      : conv.pool_type === activeTab
    const channelMatch = selectedChannels.value.length === 0 || selectedChannels.value.includes(conv.channel)
    const searchMatch = !searchKeyword.value ||
      (conv.user_name && conv.user_name.includes(searchKeyword.value)) ||
      (conv.customer_phone && conv.customer_phone.includes(searchKeyword.value)) ||
      (conv.user_id && conv.user_id.includes(searchKeyword.value)) ||
      (conv.last_message && conv.last_message.includes(searchKeyword.value))
    return poolMatch && channelMatch && searchMatch
  })
})

// ========== 全局搜索 ==========
const handleGlobalSearch = async (keyword) => {
  cancelSearchRequest()
  const requestSeq = ++searchRequestSeq
  if (!keyword.trim()) {
    searching.value = false
    searchTotal.value = 0
    conversationStore.setList([])
    return
  }
  const { controller, signal, hasTimedOut, cleanup } = createTimedAbortController()
  searchAbortController = controller
  searching.value = true
  try {
    const res = await searchConversations(keyword, { limit: 50, ...getTimeRangeParams() }, { signal })
    if (requestSeq !== searchRequestSeq || !globalSearch.value) {
      return
    }
    const data = res.data
    if (data && data.list) {
      const normalizedList = data.list.map(conv => ({
        id: conv.id,
        channel: conv.channel,
        account_id: conv.account_id,
        account_name: conv.account_name || '',
        phone_number: conv.phone_number || '',
        whatsapp_name: conv.whatsapp_name || '',
        user_id: conv.user_id,
        customer_phone: conv.customer_phone || '',
        user_name: conv.user_name || conv.user_id || '未知用户',
        user_avatar: conv.user_avatar || '',
        nationality_code: conv.nationality_code || null,
        nationality_name: conv.nationality_name || null,
        nationality_name_en: conv.nationality_name_en || null,
        nationality_source: conv.nationality_source || null,
        nationality_inferred_at: conv.nationality_inferred_at || null,
        agent_id: conv.agent_id,
        agent_name: conv.agent_name,
        pool_type: conv.pool_type || 'ai_self',
        conv_status: conv.conv_status || 'ai_serving',
        claimed_by: conv.claimed_by,
        claimed_by_name: conv.claimed_by_name,
        claimed_at: conv.claimed_at,
        priority: conv.priority || 0,
        last_reply_by: conv.last_reply_by,
        last_reply_time: conv.last_reply_time ? new Date(conv.last_reply_time).getTime() : null,
        last_message: conv.last_message || '',
        last_message_time: conv.last_message_time ? new Date(conv.last_message_time).getTime() : new Date(conv.created_at).getTime(),
        unread_count: conv.unread_count || 0,
        status: conv.status,
        ai_reply_count: conv.ai_reply_count || 0,
        inbound_count: conv.inbound_count || 0,
        tags: [],
        created_at: conv.created_at,
        match_type: conv.match_type || null,
        matched_text: conv.matched_text || null
      }))
      conversationStore.setList(normalizedList)
      searchTotal.value = data.total || 0
    }
  } catch (error) {
    if (requestSeq !== searchRequestSeq || !globalSearch.value) {
      return
    }
    if (error.code === 'ERR_CANCELED') {
      if (hasTimedOut()) {
        ElMessage.warning('全局搜索请求超时，已恢复可操作，可重试')
      }
      return
    }
    console.error('[ConversationList] 全局搜索失败:', error)
    ElMessage.error('搜索失败: ' + (error.message || '未知错误'))
  } finally {
    cleanup()
    if (searchAbortController === controller) {
      searchAbortController = null
    }
    if (requestSeq === searchRequestSeq) {
      searching.value = false
    }
  }
}

// 搜索关键词防抖
watch(searchKeyword, (val) => {
  if (!globalSearch.value) return
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    handleGlobalSearch(val)
  }, 300)
})

// 时间范围切换时重新搜索
watch(searchTimeRange, () => {
  if (!globalSearch.value || !searchKeyword.value) return
  handleGlobalSearch(searchKeyword.value)
})

// 全局搜索开关切换
const handleGlobalToggle = (enabled) => {
  if (enabled) {
    // 开启全局搜索：立即触发搜索（如果有关键词）
    if (searchKeyword.value) {
      handleGlobalSearch(searchKeyword.value)
    }
  } else {
    // 关闭全局搜索：恢复当前 Tab 列表
    loadConversations()
  }
}

// ========== 加载会话列表 ==========
const loadConversations = async () => {
  cancelLoadRequest()
  const requestSeq = ++loadRequestSeq
  const requestedTab = conversationStore.activePoolTab
  const { controller, signal, hasTimedOut, cleanup } = createTimedAbortController()
  loadAbortController = controller
  loading.value = true
  try {
    const params = {}
    // 按池 Tab 过滤
    if (requestedTab === 'archived') {
      // 归档 Tab 按 conv_status 过滤（归档不是 pool_type）
      params.conv_status = 'archived'
    } else {
      params.pool_type = requestedTab
    }
    if (channelScope.value.fixedChannel) {
      params.channel = channelScope.value.fixedChannel
    } else if (selectedChannels.value.length > 0) {
      params.channel = selectedChannels.value[0]
    }
    if (props.accountId !== '' && props.accountId != null) {
      params.account_id = props.accountId
    }
    if (searchKeyword.value) {
      params.search = searchKeyword.value
    }

    const res = await getConversations(params, { signal })
    if (requestSeq !== loadRequestSeq || requestedTab !== conversationStore.activePoolTab) {
      return
    }
    const data = res.data
    if (data && data.list) {
      const normalizedList = data.list.map(conv => ({
        id: conv.id,
        channel: conv.channel,
        account_id: conv.account_id,
        account_name: conv.account_name || '',
        phone_number: conv.phone_number || '',
        whatsapp_name: conv.whatsapp_name || '',
        user_id: conv.user_id,
        customer_phone: conv.customer_phone || '',
        user_name: conv.user_name || conv.user_id || '未知用户',
        user_avatar: conv.user_avatar || '',
        nationality_code: conv.nationality_code || null,
        nationality_name: conv.nationality_name || null,
        nationality_name_en: conv.nationality_name_en || null,
        nationality_source: conv.nationality_source || null,
        nationality_inferred_at: conv.nationality_inferred_at || null,
        agent_id: conv.agent_id,
        agent_name: conv.agent_name,
        pool_type: conv.pool_type || 'ai_self',
        conv_status: conv.conv_status || 'ai_serving',
        claimed_by: conv.claimed_by,
        claimed_by_name: conv.claimed_by_name,
        claimed_at: conv.claimed_at,
        priority: conv.priority || 0,
        last_reply_by: conv.last_reply_by,
        last_reply_time: conv.last_reply_time ? new Date(conv.last_reply_time).getTime() : null,
        last_message: conv.last_message || '',
        last_message_time: conv.last_message_time ? new Date(conv.last_message_time).getTime() : new Date(conv.created_at).getTime(),
        unread_count: conv.unread_count || 0,
        status: conv.status,
        ai_reply_count: conv.ai_reply_count || 0,
        inbound_count: conv.inbound_count || 0,
        tags: [],
        created_at: conv.created_at
      }))
      conversationStore.setList(normalizedList)
    }
    // 同时刷新池统计和坐席负载
    conversationStore.fetchPoolStats()
    conversationStore.fetchSeatLoad()
  } catch (error) {
    if (requestSeq !== loadRequestSeq) {
      return
    }
    if (error.code === 'ERR_CANCELED') {
      if (hasTimedOut()) {
        ElMessage.warning('会话列表请求超时，已恢复可操作，可重试')
      }
      return
    }
    console.error('[ConversationList] 加载会话列表失败:', error)
  } finally {
    cleanup()
    if (loadAbortController === controller) {
      loadAbortController = null
    }
    if (requestSeq === loadRequestSeq) {
      loading.value = false
    }
  }
}

// ========== 会话选中 ==========
const handleSelect = (conv) => {
  conversationStore.selectConversation(conv)
}

const recoverListState = () => {
  cancelLoadRequest()
  cancelSearchRequest()
  loadRequestSeq++
  searchRequestSeq++
  loading.value = false
  searching.value = false
  if (globalSearch.value) {
    if (searchKeyword.value) {
      handleGlobalSearch(searchKeyword.value)
    }
  } else {
    loadConversations()
  }
}

watch(() => [props.fixedChannel, props.accountId], ([value, accountId], [previousValue, previousAccountId]) => {
  if (value === previousValue && accountId === previousAccountId) return
  const nextScope = resolveChannelScope(value)
  cancelLoadRequest()
  cancelSearchRequest()
  searchRequestSeq++
  selectedChannels.value = [...nextScope.selectedChannels]
  globalSearch.value = false
  searching.value = false
  searchTotal.value = 0
  conversationStore.setList([])
  conversationStore.clearCurrent()
  loadConversations()
})

const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
    return
  }
  if (hiddenAt && Date.now() - hiddenAt > 30000) {
    recoverListState()
  }
  hiddenAt = 0
}

// ========== 抢单 ==========
const handleClaim = async (conv) => {
  if (isAdminUser.value) {
    assignTargetConversation.value = conv
    assignDialogVisible.value = true
    return
  }

  try {
    // 检查坐席负载
    if (!conversationStore.seatLoad.canClaim) {
      ElMessage.warning(`已达接待上限（${conversationStore.seatLoad.current}/${conversationStore.seatLoad.max}），请先释放部分会话`)
      return
    }

    const res = await claimConversation(conv.id)
    if (res.success !== false) {
      ElMessage.success('抢单成功')
      // 更新会话数据
      if (res.data?.conversation) {
        conversationStore.updateConversation(res.data.conversation)
      }
      // 刷新统计
      conversationStore.fetchPoolStats({ force: true })
      conversationStore.fetchSeatLoad({ force: true })
      // 重新加载列表（会话已移出当前池）
      loadConversations()
    } else {
      ElMessage.error(res.message || '抢单失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      console.error('[ConversationList] 抢单失败:', error)
      ElMessage.error('抢单失败: ' + (error.message || '未知错误'))
    }
  }
}

const handleAssignSeat = async ({ seatId, seat }) => {
  const conv = assignTargetConversation.value
  if (!conv?.id || !seatId) return

  assigningSeat.value = true
  try {
    const res = await claimConversation(conv.id, { seat_id: seatId })
    if (res.success !== false) {
      ElMessage.success(`已分配给 ${seat?.username || '目标坐席'}`)
      assignDialogVisible.value = false
      if (res.data?.conversation) {
        conversationStore.updateConversation(res.data.conversation)
      }
      conversationStore.fetchPoolStats({ force: true })
      conversationStore.fetchSeatLoad({ force: true })
      loadConversations()
    } else {
      ElMessage.error(res.message || '分配失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      console.error('[ConversationList] 分配坐席失败:', error)
      ElMessage.error('分配失败: ' + (error.message || '未知错误'))
    }
  } finally {
    assigningSeat.value = false
  }
}

// ========== 释放 ==========
const handleRelease = async (conv) => {
  try {
    await ElMessageBox.confirm(
      '释放后该会话将回到公共池，其他坐席可认领。',
      '确认释放',
      { type: 'warning', confirmButtonText: '确认释放', cancelButtonText: '取消' }
    )

    const res = await releaseConversation(conv.id)
    if (res.success !== false) {
      ElMessage.success('已释放到公共池')
      conversationStore.removeConversation(conv.id)
      conversationStore.fetchPoolStats({ force: true })
      conversationStore.fetchSeatLoad({ force: true })
    } else {
      ElMessage.error(res.message || '释放失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('释放失败: ' + (error.message || ''))
    }
  }
}

// ========== 标记长期跟进 ==========
const handleMarkLongTerm = async (conv) => {
  try {
    await ElMessageBox.confirm(
      '确认将该会话标记为长期跟进？标记后将进入长期跟进池。',
      '确认标记',
      { type: 'info', confirmButtonText: '确认', cancelButtonText: '取消' }
    )

    const res = await markLongTerm(conv.id)
    if (res.success !== false) {
      ElMessage.success('已标记为长期跟进')
      conversationStore.removeConversation(conv.id)
      conversationStore.fetchPoolStats({ force: true })
    } else {
      ElMessage.error(res.message || '标记失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('标记失败: ' + (error.message || ''))
    }
  }
}

// ========== 归档 ==========
const handleArchive = async (conv) => {
  try {
    await ElMessageBox.confirm(
      '确认归档该会话？归档后将不再显示在会话列表中。',
      '确认归档',
      { type: 'warning', confirmButtonText: '确认归档', cancelButtonText: '取消' }
    )

    const res = await archiveConversation(conv.id)
    if (res.success !== false) {
      ElMessage.success('会话已归档')
      conversationStore.removeConversation(conv.id)
      conversationStore.fetchPoolStats({ force: true })
      conversationStore.fetchSeatLoad({ force: true })
    } else {
      ElMessage.error(res.message || '归档失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('归档失败: ' + (error.message || ''))
    }
  }
}

// ========== 复活归档会话 ==========
const handleRevive = async (conv) => {
  try {
    await ElMessageBox.confirm(
      '确认复活该归档会话？会话将重新进入待人工池等待处理。',
      '确认复活',
      { type: 'primary', confirmButtonText: '确认复活', cancelButtonText: '取消' }
    )

    const res = await reviveConversation(conv.id)
    if (res.success !== false) {
      ElMessage.success('会话已复活到待人工池')
      conversationStore.removeConversation(conv.id)
      conversationStore.fetchPoolStats({ force: true })
    } else {
      ElMessage.error(res.message || '复活失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('复活失败: ' + (error.message || ''))
    }
  }
}

// ========== 手动转 AI 自助池 ==========
const handleTransferToAi = async (conv) => {
  try {
    await ElMessageBox.confirm(
      '确认将该会话转入 AI 自助池？系统会基于最近一条客户消息触发 AI 自动回复，客户不会被告知是 AI。',
      '确认转 AI 自助池',
      { type: 'warning', confirmButtonText: '确认转AI', cancelButtonText: '取消' }
    )

    const res = await transferToAi(conv.id)
    if (res.success !== false) {
      const isCurrentConversation = conversationStore.current?.id === conv.id
      if (res.data?.conversation) {
        if (isCurrentConversation) {
          conversationStore.updateCurrentConversation(res.data.conversation)
        } else {
          conversationStore.updateConversation(res.data.conversation)
        }
      }
      const queueReason = res.data?.queueReason
      if (res.data?.aiReplyQueued === false && queueReason) {
        ElMessage.warning(queueReason)
      } else {
        ElMessage.success('已转入 AI 自助池')
      }
      if (!isCurrentConversation) {
        conversationStore.removeConversation(conv.id, { preserveCurrent: true })
        conversationStore.fetchPoolStats({ force: true })
        conversationStore.fetchSeatLoad({ force: true })
      }
    } else {
      ElMessage.error(res.message || '转 AI 失败')
    }
  } catch (error) {
    if (error !== 'cancel' && error?.message !== 'cancel') {
      ElMessage.error('转 AI 失败: ' + (error.message || ''))
    }
  }
}

// ========== 监听池统计更新 ==========
watch(() => conversationStore.activePoolTab, () => {
  // Tab 切换时由 switchTab 处理加载
})

// ========== 初始化 ==========
onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange)
  loadConversations()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  searchRequestSeq++
  loadRequestSeq++
  cancelLoadRequest()
  cancelSearchRequest()
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
})
</script>

<style lang="scss" scoped>
.conversation-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: linear-gradient(180deg, #fafbfc 0%, #f5f7fa 100%);

  &__tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 8px;
    background: linear-gradient(135deg, #eef2f8 0%, #e3eaf5 100%);
    border-bottom: 1px solid #dbe4f0;

    &.is-disabled {
      opacity: 0.4;
      pointer-events: none;
    }
  }

  &__header {
    padding: 12px;
    border-bottom: 1px solid #e2e8f0;
  }

  &__toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  &__search-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  &__global-toggle {
    flex-shrink: 0;
    :deep(.el-switch__label) {
      font-size: 12px;
    }
  }

  &__search-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__search-count {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #909399;
    white-space: nowrap;
  }

  &__time-range {
    display: flex;
    gap: 2px;
  }

  &__body {
    flex: 1;
    overflow-y: auto;
  }
}

.ai-pool-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: #fdf6ec;
  border-bottom: 1px solid #f5dab1;
  font-size: 12px;
  color: #b88230;
  line-height: 1.5;
}

.pending-pool-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: #fef0f0;
  border-bottom: 1px solid #fbc4c4;
  font-size: 12px;
  color: #c45656;
  line-height: 1.5;
}

.time-range-btn {
  padding: 2px 8px;
  font-size: 11px;
  color: #64748b;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  white-space: nowrap;

  &:hover {
    background: #f1f5f9;
    color: #334155;
  }

  &--active {
    background: #409eff;
    color: #fff;

    &:hover {
      background: #337ecc;
      color: #fff;
    }
  }
}

.pool-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 6px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  font-size: 12px;
  color: #64748b;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid transparent;
  backdrop-filter: blur(4px);
  user-select: none;

  &:hover {
    background: rgba(255, 255, 255, 0.9);
    color: #334155;
    border-color: rgba(148, 163, 184, 0.4);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }

  &--active {
    color: #fff;
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    border-color: rgba(59, 130, 246, 0.5);
    box-shadow: 0 2px 12px rgba(59, 130, 246, 0.35);
    font-weight: 600;

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(59, 130, 246, 0.4);
    }

    .pool-tab__count {
      background: rgba(255, 255, 255, 0.25) !important;
      color: #fff !important;
    }
  }

  &--flashing:not(.pool-tab--active) {
    animation: pool-tab-new-message 1.2s ease-in-out infinite;
    border-color: rgba(245, 158, 11, 0.55);

    .pool-tab__count {
      background: #f59e0b !important;
      color: #fff !important;
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
    }
  }

  &__icon {
    flex-shrink: 0;
    line-height: 1;
  }

  &__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1;
  }

  &__count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    border-radius: 8px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    line-height: 1;
    transition: all 0.2s;

    &--danger   { background: #fee2e2; color: #dc2626; }
    &--primary  { background: #dbeafe; color: #2563eb; }
    &--info     { background: #e2e8f0; color: #475569; }
    &--success  { background: #dcfce7; color: #16a34a; }
    &--warning  { background: #fef3c7; color: #d97706; }
  }
}

@keyframes pool-tab-new-message {
  0%, 100% {
    background: #fff7ed;
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.28);
    color: #92400e;
  }

  50% {
    background: #fffbeb;
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.14);
    color: #78350f;
  }
}
</style>
