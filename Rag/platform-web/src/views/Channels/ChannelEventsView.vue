<template>
  <div class="channel-events-view" :class="{ 'channel-events-view--embedded': props.embedded }">
    <header v-if="!props.embedded" class="page-heading">
      <div>
        <span class="page-heading__eyebrow">{{ presentation.eyebrow }}</span>
        <h1>{{ presentation.title }}</h1>
      </div>
      <p class="page-heading__limitation">
        {{ presentation.limitation }}
      </p>
    </header>

    <section class="event-toolbar" aria-label="业务消息筛选">
      <div class="event-toolbar__filters">
        <label class="filter-field">
          <span>账号</span>
          <el-select
            v-model="filters.accountId"
            class="filter-field__control"
            placeholder="全部账号"
            clearable
            @change="applyFilters"
          >
            <el-option label="全部账号" value="" />
            <el-option
              v-for="account in accounts"
              :key="account.id"
              :label="account.name"
              :value="account.id"
            />
          </el-select>
        </label>

        <label class="filter-field">
          <span>事件类型</span>
          <el-select
            v-model="filters.category"
            class="filter-field__control"
            placeholder="全部类型"
            clearable
            @change="applyFilters"
          >
            <el-option label="全部类型" value="" />
            <el-option label="订单" value="order" />
            <el-option label="售后" value="after_sales" />
            <el-option v-if="presentation.productEvents" label="商品" value="product" />
            <el-option label="其他" value="other" />
          </el-select>
        </label>

        <label class="filter-field">
          <span>处理状态</span>
          <el-select
            v-model="filters.status"
            class="filter-field__control"
            placeholder="全部状态"
            clearable
            @change="applyFilters"
          >
            <el-option label="全部状态" value="" />
            <el-option label="已接收" value="received" />
            <el-option label="已处理" value="processed" />
            <el-option label="处理失败" value="failed" />
          </el-select>
        </label>
      </div>

      <el-tooltip content="刷新业务消息" placement="top">
        <el-button
          :icon="Refresh"
          :loading="eventsLoading || accountsLoading"
          aria-label="刷新业务消息"
          @click="refreshAll"
        >
          刷新
        </el-button>
      </el-tooltip>
    </section>

    <div v-if="accountsError || eventError" class="request-errors" role="status">
      <div v-if="accountsError" class="error-banner">
        <span>{{ accountsError }}</span>
        <el-button link type="primary" :loading="accountsLoading" @click="loadAccounts">重试账号</el-button>
      </div>
      <div v-if="eventError" class="error-banner">
        <span>{{ eventError }}</span>
        <el-button link type="primary" :loading="eventsLoading" @click="loadEvents">重试消息</el-button>
      </div>
    </div>

    <section class="projection-summary" aria-label="订单投影状态">
      <div class="projection-summary__heading">
        <span>订单投影</span>
        <small v-if="projectionSummaryError">{{ projectionSummaryError }}</small>
        <small v-else>用于识别可进入企业订单核心的数据</small>
      </div>
      <div class="projection-summary__metrics" v-loading="projectionSummaryLoading">
        <div><strong>{{ projectionSummary.ready }}</strong><span>可投影</span></div>
        <div><strong>{{ projectionSummary.rawOnly }}</strong><span>仅原始</span></div>
        <div><strong>{{ projectionSummary.total }}</strong><span>订单总数</span></div>
      </div>
    </section>

    <section class="event-table" v-loading="eventsLoading" :aria-label="`${presentation.channelLabel}业务事件`">
      <el-table v-if="items.length" :data="items" row-key="id" height="100%" stripe>
        <el-table-column label="接收时间" prop="receivedAt" min-width="166">
          <template #default="{ row }">{{ formatTime(row.receivedAt) }}</template>
        </el-table-column>
        <el-table-column label="账号" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="account-cell__name">{{ row.accountName || '账号已移除' }}</div>
            <div class="account-cell__id">ID {{ row.accountId }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="104">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="categoryTagType(row.category)">
              {{ categoryLabel(row.category) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="业务单号" min-width="166" show-overflow-tooltip>
          <template #default="{ row }">{{ row.businessKey || '-' }}</template>
        </el-table-column>
        <el-table-column label="事件名" prop="eventType" min-width="190" show-overflow-tooltip />
        <el-table-column label="状态" width="104">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="72" fixed="right" align="center">
          <template #default="{ row }">
            <el-tooltip content="查看事件详情" placement="top">
              <el-button text circle :icon="View" aria-label="查看事件详情" @click="openDetails(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-else-if="!eventsLoading && !accountsLoading && !eventError && !accountsError"
        :description="emptyState.description"
      >
        <template #image>
          <div class="empty-mark">{{ accounts.length ? '0' : '!' }}</div>
        </template>
        <template #description>
          <strong>{{ emptyState.title }}</strong>
          <span>{{ emptyState.description }}</span>
        </template>
      </el-empty>
    </section>

    <footer class="event-pagination">
      <span>共 {{ total }} 条</span>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        background
        layout="prev, pager, next, sizes"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="loadEvents"
        @size-change="handlePageSizeChange"
      />
    </footer>

    <el-drawer v-model="drawerVisible" title="事件详情" size="560px" destroy-on-close>
      <div v-loading="detailLoading" class="detail-content">
        <div v-if="detailError" class="error-banner error-banner--detail">
          <span>{{ detailError }}</span>
          <el-button link type="primary" @click="openDetails(selectedEvent)">重试详情</el-button>
        </div>
        <template v-else-if="selectedEvent && !detailLoading">
        <el-descriptions :column="1" border size="small" class="event-details">
          <el-descriptions-item label="事件 ID">{{ selectedEvent.externalEventId }}</el-descriptions-item>
          <el-descriptions-item label="账号">{{ selectedEvent.accountName || '账号已移除' }}</el-descriptions-item>
          <el-descriptions-item label="事件名">{{ selectedEvent.eventType }}</el-descriptions-item>
          <el-descriptions-item label="业务单号">{{ selectedEvent.businessKey || '-' }}</el-descriptions-item>
          <el-descriptions-item label="发生时间">{{ formatTime(selectedEvent.occurredAt) }}</el-descriptions-item>
          <el-descriptions-item label="接收时间">{{ formatTime(selectedEvent.receivedAt) }}</el-descriptions-item>
        </el-descriptions>
        <div class="payload-heading">结构化 payload</div>
        <pre class="payload-view">{{ formattedPayload }}</pre>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import dayjs from 'dayjs'
import { Refresh, View } from '@element-plus/icons-vue'
import {
  getChannelEvent,
  getChannelEventAccounts,
  getChannelEvents,
  getChannelProjectionSummary
} from '@/api/channels'
import {
  buildChannelEventQuery,
  channelEventEmptyState,
  createLatestRequestRunner,
  normalizeProjectionSummary
} from '@/modules/channels/channelEvents'
import { resolveChannelScope } from '@/modules/conversations/channelScope'

const route = useRoute()
const props = defineProps({
  channelCode: { type: String, default: '' },
  accountId: { type: [String, Number], default: '' },
  embedded: { type: Boolean, default: false }
})
const filters = reactive({ accountId: props.accountId, category: '', status: '' })
const accounts = ref([])
const items = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const eventsLoading = ref(false)
const accountsLoading = ref(false)
const detailLoading = ref(false)
const eventError = ref('')
const accountsError = ref('')
const detailError = ref('')
const projectionSummaryLoading = ref(false)
const projectionSummaryError = ref('')
const projectionSummary = ref({ total: 0, ready: 0, rawOnly: 0 })
const drawerVisible = ref(false)
const selectedEvent = ref(null)

const CHANNEL_PRESENTATION = Object.freeze({
  douyin: {
    eyebrow: 'DOUYIN COMMERCE',
    title: '抖店业务消息',
    channelLabel: '抖店',
    productEvents: true,
    limitation: '平台暂未开放飞鸽客服收发 API，只显示订单/售后/商品事件'
  },
  pinduoduo: {
    eyebrow: 'PINDUODUO COMMERCE',
    title: '拼多多业务消息',
    channelLabel: '拼多多',
    productEvents: false,
    limitation: '官方商家 API 暂未提供买家客服聊天收发能力，只显示订单和售后事件'
  },
  taobao: {
    eyebrow: 'TAOBAO OPEN PLATFORM',
    title: '淘宝 / 千牛业务消息',
    channelLabel: '淘宝 / 千牛',
    productEvents: false,
    limitation: '公开服务端 API 不提供买家聊天发送能力；这里只显示订单、退款，并以 buyer_open_uid / ouid 识别客户'
  },
  alibaba1688: {
    eyebrow: '1688 OPEN PLATFORM',
    title: '1688 业务消息',
    channelLabel: '1688',
    productEvents: false,
    limitation: '公开服务端 API 不提供独立网页买家聊天发送能力；这里只显示加密场景订单、退款，并以 buyerOpenUid 识别店铺内客户'
  },
  xiaohongshu: {
    eyebrow: 'XIAOHONGSHU OPEN PLATFORM',
    title: '小红书业务消息',
    channelLabel: '小红书',
    productEvents: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入'
  },
  wechat_shop: {
    eyebrow: 'WECHAT SHOP API',
    title: '微信小店业务消息',
    channelLabel: '微信小店',
    productEvents: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入'
  },
  kuaishou: {
    eyebrow: 'KUAISHOU COMMERCE',
    title: '快手小店业务消息',
    channelLabel: '快手小店',
    productEvents: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入'
  }
})
const channelScope = computed(() => resolveChannelScope({
  prop: props.channelCode,
  query: route.query.channel,
  meta: route.meta.channelCode
}))
const channelCode = computed(() => channelScope.value.fixedChannel || 'douyin')
const presentation = computed(() => CHANNEL_PRESENTATION[channelCode.value] || CHANNEL_PRESENTATION.douyin)
const emptyState = computed(() => channelEventEmptyState(accounts.value.length, channelCode.value))
const formattedPayload = computed(() => JSON.stringify(selectedEvent.value?.payload || {}, null, 2))

const categoryLabel = category => ({
  order: '订单', after_sales: '售后', product: '商品', other: '其他'
}[category] || category || '其他')
const categoryTagType = category => ({ order: 'success', after_sales: 'warning', product: 'info' }[category] || '')
const statusLabel = status => ({ received: '已接收', processed: '已处理', failed: '处理失败' }[status] || status)
const statusTagType = status => ({ received: 'info', processed: 'success', failed: 'danger' }[status] || 'info')
const formatTime = value => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'
const errorMessage = (error, fallback) => error?.message || fallback

const runLatestEventsRequest = createLatestRequestRunner({
  onStart: () => { eventsLoading.value = true; eventError.value = '' },
  onSuccess: response => {
    const data = response.data || {}
    items.value = Array.isArray(data.items) ? data.items : []
    total.value = Number(data.total || 0)
  },
  onError: error => { eventError.value = errorMessage(error, '业务消息加载失败，请重试') },
  onFinish: () => { eventsLoading.value = false }
})

const runLatestDetailRequest = createLatestRequestRunner({
  onStart: () => { detailLoading.value = true; detailError.value = '' },
  onSuccess: response => { selectedEvent.value = response.data },
  onError: error => { detailError.value = errorMessage(error, '事件详情加载失败，请重试') },
  onFinish: () => { detailLoading.value = false }
})

const runLatestProjectionSummaryRequest = createLatestRequestRunner({
  onStart: () => { projectionSummaryLoading.value = true; projectionSummaryError.value = '' },
  onSuccess: response => { projectionSummary.value = normalizeProjectionSummary(response.data) },
  onError: error => { projectionSummaryError.value = errorMessage(error, '订单投影统计加载失败') },
  onFinish: () => { projectionSummaryLoading.value = false }
})

async function loadAccounts() {
  accountsLoading.value = true
  accountsError.value = ''
  try {
    const response = await getChannelEventAccounts({ channel: channelCode.value })
    accounts.value = Array.isArray(response.data) ? response.data : []
  } catch (error) {
    accountsError.value = errorMessage(error, '账号列表加载失败，请重试')
  } finally {
    accountsLoading.value = false
  }
}

function loadEvents() {
  return runLatestEventsRequest(() => getChannelEvents(buildChannelEventQuery({
    ...filters,
      channel: channelCode.value,
      page: page.value,
      pageSize: pageSize.value
    })))
}

function loadProjectionSummary() {
  return runLatestProjectionSummaryRequest(() => getChannelProjectionSummary({ channel: channelCode.value }))
}

async function applyFilters() {
  page.value = 1
  await loadEvents()
}

async function handlePageSizeChange() {
  page.value = 1
  await loadEvents()
}

async function refreshAll() {
  await Promise.allSettled([loadAccounts(), loadEvents(), loadProjectionSummary()])
}

function openDetails(event) {
  if (!event?.id) return
  selectedEvent.value = event
  drawerVisible.value = true
  return runLatestDetailRequest(() => getChannelEvent(event.id))
}

watch([channelCode, () => props.accountId], async ([nextChannel, accountId], [previousChannel]) => {
  filters.accountId = accountId
  if (nextChannel !== previousChannel) {
    filters.category = ''
    filters.status = ''
  }
  page.value = 1
  accounts.value = []
  items.value = []
  total.value = 0
  projectionSummary.value = { total: 0, ready: 0, rawOnly: 0 }
  drawerVisible.value = false
  selectedEvent.value = null
  await refreshAll()
})

onMounted(refreshAll)
</script>

<style scoped lang="scss">
.channel-events-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 100%;
  padding: 20px;
  background: #f4f6f5;

  &--embedded {
    min-height: 0;
    height: 100%;
    padding: 0;
    background: transparent;
  }
}

.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;

  h1 { margin: 2px 0 0; font-size: 23px; color: #17231d; }
  &__eyebrow { color: #21845e; font-size: 10px; font-weight: 700; letter-spacing: 0; }
  &__limitation {
    max-width: 520px;
    margin: 0;
    padding: 8px 12px;
    border-left: 3px solid #d97745;
    background: #fff7f0;
    color: #73503c;
    font-size: 13px;
    line-height: 20px;
  }
}

.event-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid #dfe5e1;
  border-radius: 6px;
  background: #fff;

  &__filters { display: flex; align-items: flex-end; gap: 12px; min-width: 0; }
}

.filter-field {
  display: grid;
  gap: 5px;
  color: #66736c;
  font-size: 12px;
  &__control { width: 180px; }
}

.event-table {
  flex: 1;
  min-width: 0;
  min-height: 320px;
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid #dfe5e1;
  border-radius: 6px;
  background: #fff;

  :deep(.el-table) { min-width: 920px; }
  :deep(.el-empty) { height: 100%; min-height: 320px; }
  :deep(.el-empty__description) {
    display: grid;
    gap: 5px;
    strong { color: #2d3933; font-size: 15px; }
    span { color: #849088; font-size: 13px; }
  }
}

.request-errors { display: grid; gap: 6px; }
.projection-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 14px;
  border-top: 1px solid #dfe5e1;
  border-bottom: 1px solid #dfe5e1;
  background: #fff;

  &__heading {
    display: grid;
    gap: 2px;
    color: #26342d;
    font-size: 13px;
    font-weight: 700;
    small { color: #7a8780; font-size: 11px; font-weight: 400; }
  }
  &__metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(72px, 1fr));
    min-height: 38px;
    div { display: grid; gap: 1px; padding: 0 16px; border-left: 1px solid #e5e9e6; }
    strong { color: #1d6e50; font-size: 18px; line-height: 20px; }
    span { color: #77847d; font-size: 11px; }
  }
}
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid #efc9c4;
  border-radius: 6px;
  background: #fff5f4;
  color: #9b4037;
  font-size: 13px;

  &--detail { margin-bottom: 14px; }
}

.account-cell__name { overflow: hidden; color: #26342d; text-overflow: ellipsis; white-space: nowrap; }
.account-cell__id { margin-top: 2px; color: #929b96; font-size: 11px; }
.empty-mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin: 0 auto;
  border: 1px solid #cfd8d3;
  border-radius: 50%;
  color: #7b8b82;
  font-size: 20px;
}

.event-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: #6f7c75;
  font-size: 12px;
}

.event-details {
  margin-bottom: 18px;

  :deep(.el-descriptions__table) {
    width: 100%;
    table-layout: fixed;
  }

  :deep(.el-descriptions__label) {
    width: 108px;
    min-width: 108px;
    white-space: nowrap;
  }

  :deep(.el-descriptions__content) {
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
}
.detail-content {
  min-width: 0;
  min-height: 160px;
  overflow-x: hidden;
}
.payload-heading { margin-bottom: 8px; color: #34423b; font-size: 13px; font-weight: 700; }
.payload-view {
  max-height: calc(100vh - 390px);
  margin: 0;
  overflow: auto;
  padding: 14px;
  border: 1px solid #dfe5e1;
  border-radius: 6px;
  background: #f6f8f7;
  color: #233129;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .channel-events-view { padding: 14px; }
  .page-heading { align-items: flex-start; flex-direction: column; gap: 10px; }
  .page-heading__limitation { max-width: none; }
  .event-toolbar { align-items: stretch; flex-direction: column; }
  .event-toolbar__filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-field__control { width: 100%; }
  .event-pagination { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  :deep(.el-drawer) { width: min(560px, 92vw) !important; }
}

@media (max-width: 560px) {
  .projection-summary { align-items: stretch; flex-direction: column; gap: 8px; }
  .projection-summary__metrics div:first-child { border-left: 0; padding-left: 0; }
  .event-toolbar__filters { grid-template-columns: 1fr; }
  .event-pagination :deep(.el-pagination__sizes) { display: none; }
}
</style>
