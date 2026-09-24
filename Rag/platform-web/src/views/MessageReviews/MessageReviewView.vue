<template>
  <div class="review-workbench">
    <ReviewQueuePanel
      :items="items"
      :selected-id="selectedId"
      :scope="scope"
      :risk-level="filters.riskLevel"
      :channel="filters.channel"
      :stats="stats"
      :loading="listLoading"
      :can-view-all="canViewAll"
      @select="selectItem"
      @scope-change="changeScope"
      @filter-change="changeFilter"
      @refresh="refreshAll"
    />
    <ReviewConversationPanel :item="detail" :loading="detailLoading" />
    <ReviewDecisionPanel
      :item="detail"
      :can-resolve="canResolve"
      :can-takeover="canTakeover"
      :loading="detailLoading"
      :submitting="submitting"
      @claim="mutate(() => claimReview(selectedId))"
      @takeover="mutate(() => takeoverReview(selectedId), '已接管审核任务')"
      @release="mutate(() => releaseReview(selectedId))"
      @reply="text => mutate(() => replyReview(selectedId, text), '回复已发送')"
      @dismiss="input => mutate(() => dismissReview(selectedId, input), '已确认不回复')"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  claimReview, dismissReview, getReview, getReviewStats,
  listReviews, releaseReview, replyReview, takeoverReview
} from '@/api/messageReviews'
import { canTakeOverReview, isReviewConflict, normalizeReview, sortReviewItems } from '@/modules/messageReviews/reviewQueue'
import { useUserStore } from '@/stores/user'
import ReviewQueuePanel from './components/ReviewQueuePanel.vue'
import ReviewConversationPanel from './components/ReviewConversationPanel.vue'
import ReviewDecisionPanel from './components/ReviewDecisionPanel.vue'

const userStore = useUserStore()
const scope = ref('mine')
const filters = reactive({ riskLevel: '', channel: '' })
const items = ref([])
const detail = ref(null)
const selectedId = ref('')
const stats = reactive({ mine: 0, public: 0, all: 0, high: 0 })
const listLoading = ref(false)
const detailLoading = ref(false)
const submitting = ref(false)
let listVersion = 0
let detailVersion = 0
let pollTimer

const role = computed(() => userStore.userInfo?.role || 'agent')
const userId = computed(() => userStore.userInfo?.id || userStore.userInfo?.userId)
const canViewAll = computed(() => ['supervisor', 'admin'].includes(role.value))
const canResolve = computed(() => detail.value?.status === 'claimed' && Number(detail.value.claimedBy) === Number(userId.value))
const canTakeover = computed(() => canTakeOverReview(detail.value, {
  id: userId.value,
  role: role.value
}))

async function loadStats() {
  try {
    const response = await getReviewStats()
    Object.assign(stats, response.data || {})
  } catch (error) {
    console.error('[MessageReviews] stats failed', error)
  }
}

async function loadList({ keepSelection = true } = {}) {
  const version = ++listVersion
  listLoading.value = true
  try {
    const response = await listReviews({
      scope: scope.value,
      risk_level: filters.riskLevel || undefined,
      channel: filters.channel || undefined,
      limit: 100
    })
    if (version !== listVersion) return
    items.value = sortReviewItems(response.data?.items || [])
    const nextId = keepSelection && items.value.some(item => item.id === selectedId.value)
      ? selectedId.value
      : items.value[0]?.id || ''
    selectedId.value = nextId
    if (nextId) await loadDetail(nextId)
    else detail.value = null
  } finally {
    if (version === listVersion) listLoading.value = false
  }
}

async function loadDetail(id) {
  const version = ++detailVersion
  detailLoading.value = true
  try {
    const response = await getReview(id)
    if (version === detailVersion) detail.value = normalizeReview(response.data)
  } finally {
    if (version === detailVersion) detailLoading.value = false
  }
}

function selectItem(item) {
  selectedId.value = item.id
  loadDetail(item.id)
}

function changeScope(value) {
  scope.value = value
  loadList({ keepSelection: false })
}

function changeFilter(patch) {
  Object.assign(filters, patch)
  loadList({ keepSelection: false })
}

async function refreshAll() {
  await Promise.all([loadStats(), loadList()])
}

async function mutate(operation, successMessage = '') {
  if (!selectedId.value || submitting.value) return
  submitting.value = true
  try {
    await operation()
    if (successMessage) ElMessage.success(successMessage)
  } catch (error) {
    if (isReviewConflict(error)) ElMessage.warning('该任务已被其他坐席处理')
    else console.error('[MessageReviews] mutation failed', error)
  } finally {
    submitting.value = false
    await refreshAll()
  }
}

onMounted(() => {
  refreshAll()
  pollTimer = window.setInterval(refreshAll, 30000)
})
onBeforeUnmount(() => window.clearInterval(pollTimer))
</script>

<style scoped lang="scss">
.review-workbench {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(360px, 1fr) minmax(300px, 380px);
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #f3f5f6;
}
@media (max-width: 900px) {
  .review-workbench { display: flex; height: auto; min-height: 100%; flex-direction: column; overflow: visible; }
}
</style>
