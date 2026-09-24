<template>
  <div class="platform-messages-view">
    <section class="message-toolbar" aria-label="平台消息筛选">
      <div class="message-toolbar__controls">
        <el-select
          v-model="selectedAccountId"
          class="account-select"
          size="small"
          clearable
          filterable
          :loading="accountsLoading"
          placeholder="全部账号"
          @change="syncQuery"
        >
          <el-option label="全部账号" value="" />
          <el-option
            v-for="account in accounts"
            :key="account.id"
            :label="account.name"
            :value="String(account.id)"
          >
            <span>{{ account.name }}</span>
            <span class="account-option__platform">{{ platformLabel(account.channel) }}</span>
          </el-option>
        </el-select>

        <el-radio-group v-model="selectedView" size="small" @change="handleViewChange">
          <el-radio-button value="conversations">会话</el-radio-button>
          <el-radio-button value="events">业务事件</el-radio-button>
        </el-radio-group>

        <el-tooltip content="刷新当前视图" placement="bottom">
          <el-button
            circle
            size="small"
            :icon="Refresh"
            :loading="accountsLoading"
            aria-label="刷新当前视图"
            @click="refreshCurrentView"
          />
        </el-tooltip>
      </div>
    </section>

    <div v-if="showDesktopBridgeStatus" class="desktop-bridge-status" role="status">
      <el-icon><Monitor /></el-icon>
      <div>
        <strong>需要在线桌面节点</strong>
        <span>官方接口不提供客服聊天收发，节点接入前会话保持只读。</span>
      </div>
    </div>

    <main class="platform-messages-view__content">
      <WorkbenchView
        v-if="selectedView === 'conversations'"
        :key="viewKey"
        :channel-code="selectedChannel"
        :account-id="selectedAccountId"
        :read-only-channels="DESKTOP_BRIDGE_CHANNELS"
        read-only-reason="需要在线桌面节点，当前会话暂不可发送"
        embedded
      />
      <ChannelEventsView
        v-else
        :key="viewKey"
        :channel-code="selectedChannel"
        :account-id="selectedAccountId"
        embedded
      />
    </main>
    <CustomerWorkspaceDrawer
      v-model="customerDrawerVisible"
      :context="customerContext"
      :loading="customerContextLoading || deepLinkLoading"
      :error="customerContextError"
      @open-profile="openCustomerProfile"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Monitor, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import WorkbenchView from '@/views/Workbench/WorkbenchView.vue'
import ChannelEventsView from '@/views/Channels/ChannelEventsView.vue'
import { getChannelAccountOptions } from '@/api/channels'
import { getConversation } from '@/api/conversations'
import { getConversationCustomerContext } from '@/api/customers'
import { useConversationStore } from '@/stores/conversation'
import CustomerWorkspaceDrawer from '@/components/CustomerWorkspace/CustomerWorkspaceDrawer.vue'
import {
  DESKTOP_BRIDGE_CHANNELS,
  PLATFORM_OPTIONS,
  normalizeMessageFilters,
  requiresDesktopBridge
} from '@/modules/platformMessages/platformFilters'

const route = useRoute()
const router = useRouter()
const conversationStore = useConversationStore()
const initialFilters = normalizeMessageFilters({
  channel: route.query.channel,
  view: route.query.view
})
const selectedChannel = ref(initialFilters.channel)
const selectedView = ref(initialFilters.view)
const selectedAccountId = ref(String(route.query.account || ''))
const accounts = ref([])
const accountsLoading = ref(false)
const refreshEpoch = ref(0)
const deepLinkLoading = ref(false)
const customerContextLoading = ref(false)
const customerContextError = ref('')
const customerContext = ref(null)
let deepLinkRequestSeq = 0
let applyingRoute = false

const customerDrawerVisible = computed({
  get: () => ['1', 'true'].includes(String(route.query.customerDrawer || '').toLowerCase()),
  set: async visible => {
    const query = { ...route.query }
    if (visible) query.customerDrawer = '1'
    else delete query.customerDrawer
    await router.replace({ path: '/platform-messages', query })
  }
})

const showDesktopBridgeStatus = computed(() =>
  selectedView.value === 'conversations' && requiresDesktopBridge(selectedChannel.value)
)
const viewKey = computed(() => [
  selectedView.value,
  selectedChannel.value || 'all',
  selectedAccountId.value || 'all',
  refreshEpoch.value
].join(':'))

function platformLabel(channel) {
  return PLATFORM_OPTIONS.find(option => option.value === channel)?.label || channel || '未知平台'
}

async function loadAccounts() {
  accountsLoading.value = true
  try {
    const params = selectedChannel.value ? { channel: selectedChannel.value } : {}
    const response = await getChannelAccountOptions(params)
    accounts.value = response.data || []
    if (selectedAccountId.value && !accounts.value.some(account => String(account.id) === selectedAccountId.value)) {
      selectedAccountId.value = ''
    }
  } catch (error) {
    accounts.value = []
    ElMessage.error(error?.message || '账号列表加载失败')
  } finally {
    accountsLoading.value = false
  }
}

async function syncQuery() {
  if (applyingRoute) return
  const query = {}
  if (selectedChannel.value) query.channel = selectedChannel.value
  if (selectedView.value !== 'conversations') query.view = selectedView.value
  if (selectedAccountId.value) query.account = selectedAccountId.value
  if (route.query.conversation) query.conversation = String(route.query.conversation)
  if (route.query.customerDrawer) query.customerDrawer = String(route.query.customerDrawer)
  await router.replace({ path: '/platform-messages', query })
}

function normalizeConversationResponse(response) {
  return response?.data?.conversation || response?.data || null
}

async function loadCustomerContext(conversationId, requestSeq = deepLinkRequestSeq) {
  customerContextLoading.value = true
  try {
    const response = await getConversationCustomerContext(conversationId)
    if (requestSeq !== deepLinkRequestSeq) return
    customerContext.value = response?.data || null
  } catch (error) {
    if (requestSeq !== deepLinkRequestSeq) return
    customerContext.value = null
    customerContextError.value = error?.response?.data?.message || error?.message || '无法加载客户上下文'
  } finally {
    if (requestSeq === deepLinkRequestSeq) customerContextLoading.value = false
  }
}

async function loadDeepLinkContext(query) {
  const conversationId = String(query.conversation || '').trim()
  const requestSeq = ++deepLinkRequestSeq
  customerContextError.value = ''
  if (!conversationId) {
    customerContext.value = null
    return
  }

  deepLinkLoading.value = true
  try {
    let conversation = conversationStore.current?.id === conversationId
      ? conversationStore.current
      : conversationStore.list.find(item => String(item.id) === conversationId)
    if (!conversation) conversation = normalizeConversationResponse(await getConversation(conversationId))
    if (requestSeq !== deepLinkRequestSeq) return
    if (!conversation?.id) throw new Error('无法加载目标会话')
    conversationStore.updateConversation(conversation)
    conversationStore.selectConversation(conversationStore.list.find(item => item.id === conversation.id) || conversation)
    if (['1', 'true'].includes(String(query.customerDrawer || '').toLowerCase())) {
      await loadCustomerContext(conversationId, requestSeq)
    }
  } catch (error) {
    if (requestSeq !== deepLinkRequestSeq) return
    customerContext.value = null
    customerContextError.value = error?.response?.data?.message || error?.message || '无法加载客户上下文'
  } finally {
    if (requestSeq === deepLinkRequestSeq) deepLinkLoading.value = false
  }
}

function openCustomerProfile(customer) {
  if (!customer?.id) return
  router.push({ path: `/customers/${encodeURIComponent(customer.id)}` })
}

async function handleViewChange(view) {
  const normalized = normalizeMessageFilters({ channel: selectedChannel.value, view })
  const channelChanged = normalized.channel !== selectedChannel.value
  selectedChannel.value = normalized.channel
  selectedView.value = normalized.view
  if (channelChanged) {
    selectedAccountId.value = ''
    await loadAccounts()
  }
  await syncQuery()
}

async function refreshCurrentView() {
  await loadAccounts()
  refreshEpoch.value += 1
  await syncQuery()
}

watch(
  () => route.query,
  async query => {
    const normalized = normalizeMessageFilters({ channel: query.channel, view: query.view })
    const channelChanged = normalized.channel !== selectedChannel.value
    applyingRoute = true
    selectedChannel.value = normalized.channel
    selectedView.value = normalized.view
    selectedAccountId.value = String(query.account || '')
    if (channelChanged || accounts.value.length === 0) await loadAccounts()
    applyingRoute = false
    await loadDeepLinkContext(query)
  },
  { immediate: true, deep: true }
)
</script>

<style scoped lang="scss">
.platform-messages-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: #f5f7fa;

  &__content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
}

.message-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 52px;
  padding: 8px 14px;
  border-bottom: 1px solid #dfe4ea;
  background: #fff;

  &__controls {
    width: 100%;
    justify-content: flex-end;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
}

.account-select { width: 210px; }
.account-option__platform { float: right; margin-left: 20px; color: #8a96a3; font-size: 11px; }

.desktop-bridge-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-bottom: 1px solid #efd0ad;
  background: #fff8ef;
  color: #7c4d25;

  .el-icon { flex-shrink: 0; font-size: 18px; }
  div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  strong { font-size: 13px; white-space: nowrap; }
  span { overflow: hidden; color: #916b49; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
}

@media (max-width: 1100px) {
  .message-toolbar { align-items: stretch; flex-direction: column; }
  .message-toolbar__controls { justify-content: space-between; }
  .account-select { flex: 1; width: auto; min-width: 160px; }
}

@media (max-width: 620px) {
  .message-toolbar { padding: 8px; }
  .message-toolbar__controls { align-items: stretch; flex-wrap: wrap; }
  .account-select { flex-basis: 100%; }
  .desktop-bridge-status div { align-items: flex-start; flex-direction: column; gap: 1px; }
  .desktop-bridge-status span { white-space: normal; }
}
</style>
