<template>
  <div class="profile-view">
    <div class="profile-header">
      <div class="profile-header__identity">
        <el-button :icon="ArrowLeft" plain size="small" @click="router.back()">返回</el-button>
        <div>
          <h1 class="profile-header__title">客户画像</h1>
          <p v-if="data?.customer">{{ customerName }} · {{ data.customer.phone }}</p>
        </div>
      </div>
      <div v-if="data" class="profile-header__actions">
        <el-button :icon="Refresh" :loading="loading" plain @click="loadProfile">刷新</el-button>
        <el-button
          v-if="canOperate && data.customer.won_status !== 'won'"
          type="success"
          :icon="Trophy"
          :loading="markingWon"
          @click="handleMarkWon"
        >标记成交</el-button>
      </div>
    </div>

    <div v-if="loading && !data" class="profile-loading" v-loading="true"></div>
    <el-result v-else-if="loadError" icon="error" title="客户画像加载失败" :sub-title="loadError">
      <template #extra>
        <el-button type="primary" :icon="Refresh" @click="loadProfile">重新加载</el-button>
      </template>
    </el-result>
    <el-empty v-else-if="!data" description="客户不存在" />

    <template v-else>
      <el-row :gutter="16">
        <el-col :xs="24" :sm="8">
          <section class="info-card">
            <div class="info-card__avatar">{{ avatarChar }}</div>
            <div class="info-card__name">{{ customerName }}</div>
            <div class="info-card__phone">{{ data.customer.phone }}</div>
            <div class="info-card__badges">
              <el-tag size="small" :type="data.customer.won_status === 'won' ? 'success' : 'info'">
                {{ data.customer.won_status === 'won' ? '已成交' : '未成交' }}
              </el-tag>
              <el-tag size="small" :type="stageTagType(stageSummary.code)">{{ stageSummary.label }}</el-tag>
            </div>
            <div v-if="data.customer.contactTime" class="info-card__meta">
              最近联系：{{ data.customer.contactTime }}
            </div>
            <div v-if="data.customer.notes" class="info-card__notes">{{ data.customer.notes }}</div>
            <div class="info-card__since">创建于 {{ data.customer.createdAt }}</div>
          </section>
        </el-col>

        <el-col :xs="24" :sm="16">
          <el-row :gutter="12">
            <el-col :xs="12" :sm="12">
              <div class="kpi-card kpi-card--primary">
                <div class="kpi-card__label">历史订单数</div>
                <div class="kpi-card__value">{{ data.summary.totalOrders }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="12">
              <div class="kpi-card kpi-card--success">
                <div class="kpi-card__label">累计消费金额</div>
                <div class="kpi-card__value">{{ formatMoney(data.summary.totalSpend) }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="12">
              <div class="kpi-card kpi-card--warning">
                <div class="kpi-card__label">沟通自然日</div>
                <div class="kpi-card__value">{{ stageSummary.count }}</div>
              </div>
            </el-col>
            <el-col :xs="12" :sm="12">
              <div class="kpi-card kpi-card--danger">
                <div class="kpi-card__label">待处理复联</div>
                <div class="kpi-card__value">{{ activeFollowupCount }}</div>
              </div>
            </el-col>
          </el-row>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="section-row">
        <el-col :xs="24" :lg="9">
          <section class="surface profile-analysis">
            <div class="surface__header">
              <div>
                <h2>沟通画像</h2>
                <p>依据账号信息、历史沟通、订单与行为信号动态更新</p>
              </div>
              <el-tag size="small" effect="plain">
                {{ data.aiProfile?.source === 'ai' ? 'AI 已分析' : '规则分析' }}
              </el-tag>
            </div>

            <div class="stage-summary">
              <span>当前阶段</span>
              <strong>{{ stageSummary.label }}</strong>
              <small>累计 {{ stageSummary.count }} 个沟通日</small>
            </div>

            <div class="analysis-block">
              <span class="analysis-block__label">客户摘要</span>
              <p>{{ data.aiProfile?.summary || 'AI 分析处理中，沟通次数与阶段统计不受影响。' }}</p>
            </div>

            <div class="analysis-block">
              <span class="analysis-block__label">行为信号</span>
              <div v-if="profileSignals.length" class="signal-list">
                <el-tooltip
                  v-for="signal in profileSignals"
                  :key="signal.code"
                  :content="signal.evidence || signal.label"
                  placement="top"
                >
                  <el-tag size="small" effect="dark" type="warning">{{ signal.label }}</el-tag>
                </el-tooltip>
              </div>
              <p v-else class="muted">暂无可解释的行为信号</p>
            </div>

            <div v-if="data.aiProfile?.recommendedTone" class="analysis-block">
              <span class="analysis-block__label">建议沟通方式</span>
              <p>{{ data.aiProfile.recommendedTone }}</p>
            </div>

            <div v-if="data.conversations?.length" class="analysis-block">
              <span class="analysis-block__label">关联会话</span>
              <button
                v-for="conversation in data.conversations.slice(0, 4)"
                :key="conversation.id"
                type="button"
                class="conversation-link"
                @click="openConversation(conversation)"
              >
                <span>{{ CHANNEL_LABELS[conversation.channel] || conversation.channel }} · {{ conversation.user_name || conversation.user_id }}</span>
                <small>{{ conversation.lastMessageTime || '暂无消息时间' }}</small>
              </button>
            </div>
          </section>
        </el-col>

        <el-col :xs="24" :lg="15">
          <section class="surface communication-history">
            <div class="surface__header">
              <div>
                <h2>沟通日记录</h2>
                <p>同一客户同一自然日多轮聊天只计一次沟通</p>
              </div>
              <el-tag size="small" type="info" effect="plain">最近 90 天</el-tag>
            </div>

            <el-timeline v-if="communicationDays.length" class="communication-timeline">
              <el-timeline-item
                v-for="day in communicationDays"
                :key="`${day.communication_date}-${day.communication_index}`"
                :timestamp="`${day.communication_date} · ${day.message_count || 0} 条消息`"
                placement="top"
                :type="timelineType(day.stage_label)"
              >
                <div class="communication-entry">
                  <div class="communication-entry__title">
                    <el-tag size="small" :type="stageTagType(day.stage_label)">
                      {{ stageLabel(day.stage_label, day.communication_index) }}
                    </el-tag>
                    <span>{{ day.firstMessageAt }} - {{ day.lastMessageAt }}</span>
                  </div>
                  <p>{{ day.summary || 'AI 摘要生成中' }}</p>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无沟通日记录" :image-size="72" />
          </section>
        </el-col>
      </el-row>

      <section class="surface section-row followup-section">
        <div class="surface__header">
          <div>
            <h2>成交复联任务</h2>
            <p>AI 会按历史沟通和订单信号修正提醒时间，人工调整后保持锁定</p>
          </div>
          <div class="followup-counts">
            <span><strong>{{ activeFollowupCount }}</strong> 待处理</span>
            <span><strong>{{ overdueFollowupCount }}</strong> 已逾期</span>
          </div>
        </div>

        <div v-if="data.followups?.length" class="followup-list">
          <article v-for="followup in data.followups" :key="followup.id" class="followup-item">
            <div class="followup-item__state" :class="`is-${followupStatus(followup).code}`">
              <Bell />
            </div>
            <div class="followup-item__body">
              <div class="followup-item__heading">
                <div>
                  <strong>{{ FOLLOWUP_TYPE_LABELS[followup.type] || '客户复联' }}</strong>
                  <el-tag size="small" :type="followupStatus(followup).tagType">
                    {{ followupStatus(followup).label }}
                  </el-tag>
                  <el-tag v-if="followup.overriddenBy" size="small" effect="plain">人工锁定</el-tag>
                </div>
                <time>{{ followup.dueAt || '等待 AI 判定时间' }}</time>
              </div>
              <p>{{ followup.aiReason || 'AI 正在结合客户画像分析复联策略。' }}</p>
              <div v-if="normalizeProfileSignals(followup.aiSignals).length" class="signal-list signal-list--compact">
                <el-tag
                  v-for="signal in normalizeProfileSignals(followup.aiSignals)"
                  :key="signal.code"
                  size="small"
                  effect="plain"
                >{{ signal.label }}</el-tag>
              </div>
              <div class="followup-item__meta">
                <span>{{ followup.source === 'ai' ? 'AI 判定' : followup.source === 'manual' ? '人工设置' : '默认规则' }}</span>
                <span v-if="followup.aiConfidence !== null && followup.aiConfidence !== undefined">
                  置信度 {{ Math.round(Number(followup.aiConfidence) * 100) }}%
                </span>
                <span v-if="followup.completedAt">完成于 {{ followup.completedAt }}</span>
                <span v-if="followup.overrideReason">{{ followup.overrideReason }}</span>
              </div>
            </div>
            <div v-if="canOperate && isActiveFollowup(followup)" class="followup-item__actions">
              <el-button
                size="small"
                type="success"
                plain
                :icon="Check"
                :loading="actionFollowupId === followup.id"
                @click="completeFollowup(followup)"
              >完成</el-button>
              <el-button size="small" plain :icon="Clock" @click="openScheduleDialog(followup)">调整时间</el-button>
              <el-button
                size="small"
                type="danger"
                link
                :icon="Close"
                :loading="actionFollowupId === followup.id"
                @click="skipFollowup(followup)"
              >跳过</el-button>
            </div>
          </article>
        </div>
        <el-empty v-else description="成交后将自动生成复联任务" :image-size="72" />
      </section>

      <el-row :gutter="16" class="section-row">
        <el-col :xs="24" :sm="10">
          <section class="chart-card">
            <div class="chart-card__title">渠道分布</div>
            <div ref="channelChartRef" class="chart-card__canvas"></div>
          </section>
        </el-col>
        <el-col :xs="24" :sm="14">
          <section class="chart-card">
            <div class="chart-card__title">订单状态分布</div>
            <div ref="statusChartRef" class="chart-card__canvas"></div>
          </section>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="section-row">
        <el-col :xs="24" :sm="10">
          <section class="chart-card">
            <div class="chart-card__title">常购产品 Top 10</div>
            <el-table :data="data.topProducts" size="small">
              <el-table-column label="产品" prop="product_name" show-overflow-tooltip />
              <el-table-column label="次数" prop="purchase_count" width="60" align="right" />
              <el-table-column label="金额" width="90" align="right">
                <template #default="{ row }">{{ formatMoney(row.total_amount) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </el-col>
        <el-col :xs="24" :sm="14">
          <section class="chart-card">
            <div class="chart-card__title">近期订单</div>
            <el-table :data="data.recentOrders" size="small">
              <el-table-column label="单号" prop="order_no" show-overflow-tooltip width="130" />
              <el-table-column label="渠道" width="80">
                <template #default="{ row }">{{ CHANNEL_LABELS[row.channel] || row.channel }}</template>
              </el-table-column>
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag :type="statusTagType(row.status)" size="small">{{ STATUS_LABELS[row.status] || row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="金额" width="80" align="right">
                <template #default="{ row }">{{ formatMoney(row.deal_amount) }}</template>
              </el-table-column>
              <el-table-column label="时间" prop="createdAt" show-overflow-tooltip />
            </el-table>
          </section>
        </el-col>
      </el-row>
    </template>

    <el-dialog v-model="scheduleDialogVisible" title="调整复联时间" width="460px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="提醒时间" required>
          <el-date-picker
            v-model="scheduleForm.dueAt"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="选择复联提醒时间"
            class="schedule-input"
          />
        </el-form-item>
        <el-form-item label="调整原因">
          <el-input
            v-model="scheduleForm.reason"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="例如：客户希望发薪日后再联系"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scheduleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSchedule" @click="saveSchedule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft,
  Bell,
  Check,
  Clock,
  Close,
  Refresh,
  Trophy
} from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import { useUserStore } from '@/stores/user'
import {
  completeCustomerFollowup,
  getCustomerProfile,
  markCustomerWon,
  skipCustomerFollowup,
  updateCustomerFollowup
} from '@/api/customers'
import { stageLabel } from '@/modules/customers/customerReport'
import {
  followupStatusMeta,
  normalizeProfileSignals,
  profileStageSummary
} from '@/modules/customers/customerProfile'

const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  wecom_kf: '微信客服',
  douyin: '抖店',
  pinduoduo: '拼多多',
  taobao: '淘宝',
  alibaba1688: '1688'
}
const STATUS_LABELS = {
  draft: '草稿',
  confirmed: '确认',
  paid: '已付款',
  purchasing: '采购中',
  domestic_shipping: '国内发货',
  international_shipping: '国际发货',
  delivered: '已交付',
  after_sales: '售后',
  closed: '已关闭',
  cancelled: '已取消'
}
const FOLLOWUP_TYPE_LABELS = {
  won_first: '成交首次复联',
  won_second: '成交二次复联',
  manual: '人工复联'
}

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const loading = ref(true)
const loadError = ref('')
const data = ref(null)
const markingWon = ref(false)
const actionFollowupId = ref('')
const scheduleDialogVisible = ref(false)
const savingSchedule = ref(false)
const selectedFollowup = ref(null)
const scheduleForm = reactive({ dueAt: '', reason: '' })
const channelChartRef = ref(null)
const statusChartRef = ref(null)
let channelChart = null
let statusChart = null

const customerName = computed(() => data.value?.customer?.display_name || data.value?.customer?.phone || '未命名客户')
const avatarChar = computed(() => {
  const value = customerName.value
  return /[\u4e00-\u9fff]/.test(value) ? value.slice(0, 1) : value.slice(-2) || '?'
})
const stageSummary = computed(() => profileStageSummary(data.value?.communicationDays))
const profileSignals = computed(() => normalizeProfileSignals(data.value?.aiProfile?.signals))
const communicationDays = computed(() => [...(data.value?.communicationDays || [])].sort((a, b) =>
  String(b.communication_date).localeCompare(String(a.communication_date))))
const currentUserId = computed(() => Number(userStore.userInfo?.id || userStore.userInfo?.userId || 0))
const isPrivileged = computed(() => ['admin', 'supervisor'].includes(userStore.userInfo?.role))
const canOperate = computed(() => {
  if (!data.value) return false
  if (isPrivileged.value) return true
  if (Number(data.value.customer?.owner_id) === currentUserId.value) return true
  return (data.value.conversations || []).some(item =>
    Number(item.claimed_by) === currentUserId.value || Number(item.agent_id) === currentUserId.value)
})
const activeFollowupCount = computed(() => (data.value?.followups || []).filter(isActiveFollowup).length)
const overdueFollowupCount = computed(() => (data.value?.followups || [])
  .filter(item => followupStatus(item).code === 'overdue').length)

function formatMoney(value) {
  const amount = Number(value || 0)
  return amount >= 10000 ? `$${(amount / 10000).toFixed(1)}万` : `$${amount.toFixed(0)}`
}

function statusTagType(status) {
  return ({ after_sales: 'danger', cancelled: 'info', closed: 'success', delivered: 'success', paid: 'warning' })[status] || ''
}

function stageTagType(code) {
  return ({ first: 'info', second: 'warning', third: 'success', nth: '' })[code] || 'info'
}

function timelineType(code) {
  return ({ first: 'primary', second: 'warning', third: 'success', nth: 'info' })[code] || 'info'
}

function followupStatus(followup) {
  return followupStatusMeta(followup)
}

function isActiveFollowup(followup) {
  return !['completed', 'skipped', 'cancelled'].includes(followup.status)
}

function renderChannelChart(distribution) {
  if (!channelChartRef.value) return
  if (!channelChart) channelChart = echarts.init(channelChartRef.value)
  const items = (distribution || []).map(item => ({
    name: CHANNEL_LABELS[item.channel] || item.channel,
    value: Number(item.order_count)
  }))
  channelChart.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c}单 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#94a3b8' } },
    series: [{
      type: 'pie',
      radius: ['40%', '65%'],
      data: items,
      label: { color: '#94a3b8' },
      itemStyle: { borderRadius: 4 }
    }]
  }, { notMerge: true })
}

function renderStatusChart(distribution) {
  if (!statusChartRef.value) return
  if (!statusChart) statusChart = echarts.init(statusChartRef.value)
  const items = distribution || []
  statusChart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: items.map(item => STATUS_LABELS[item.status] || item.status),
      axisLabel: { color: '#64748b', rotate: 30 }
    },
    yAxis: { type: 'value', axisLabel: { color: '#64748b' } },
    series: [{
      type: 'bar',
      data: items.map(item => Number(item.cnt)),
      itemStyle: { color: '#38bdf8', borderRadius: [4, 4, 0, 0] }
    }],
    grid: { left: 40, right: 20, top: 10, bottom: 60 }
  }, { notMerge: true })
}

async function loadProfile() {
  loading.value = true
  loadError.value = ''
  try {
    const response = await getCustomerProfile(route.params.id)
    data.value = response.data
    await nextTick()
    renderChannelChart(response.data.channelDistribution)
    renderStatusChart(response.data.statusDistribution)
  } catch (error) {
    loadError.value = error?.response?.data?.message || error.message || '无法加载客户画像'
  } finally {
    loading.value = false
  }
}

async function handleMarkWon() {
  await ElMessageBox.confirm('标记成交后将自动创建首次复联任务，是否继续？', '确认成交', {
    type: 'success',
    confirmButtonText: '标记成交',
    cancelButtonText: '取消'
  })
  markingWon.value = true
  try {
    await markCustomerWon(route.params.id)
    ElMessage.success('客户已标记为成交')
    await loadProfile()
  } finally {
    markingWon.value = false
  }
}

async function completeFollowup(followup) {
  actionFollowupId.value = followup.id
  try {
    await completeCustomerFollowup(route.params.id, followup.id)
    ElMessage.success('复联任务已完成')
    await loadProfile()
  } finally {
    actionFollowupId.value = ''
  }
}

async function skipFollowup(followup) {
  await ElMessageBox.confirm('确认跳过这次复联任务？', '跳过复联', {
    type: 'warning',
    confirmButtonText: '跳过',
    cancelButtonText: '取消'
  })
  actionFollowupId.value = followup.id
  try {
    await skipCustomerFollowup(route.params.id, followup.id)
    ElMessage.success('复联任务已跳过')
    await loadProfile()
  } finally {
    actionFollowupId.value = ''
  }
}

function openScheduleDialog(followup) {
  selectedFollowup.value = followup
  scheduleForm.dueAt = followup.dueAt || ''
  scheduleForm.reason = followup.overrideReason || ''
  scheduleDialogVisible.value = true
}

async function saveSchedule() {
  if (!scheduleForm.dueAt) {
    ElMessage.warning('请选择复联提醒时间')
    return
  }
  savingSchedule.value = true
  try {
    await updateCustomerFollowup(route.params.id, selectedFollowup.value.id, {
      dueAt: scheduleForm.dueAt,
      reason: scheduleForm.reason.trim() || '人工调整复联时间'
    })
    scheduleDialogVisible.value = false
    ElMessage.success('复联时间已更新')
    await loadProfile()
  } finally {
    savingSchedule.value = false
  }
}

function openConversation(conversation) {
  router.push({
    path: '/platform-messages',
    query: {
      channel: conversation.channel,
      account: conversation.account_id || undefined,
      conversation: conversation.id,
      customerDrawer: '1',
      view: 'conversations'
    }
  })
}

const resizeHandler = () => {
  channelChart?.resize()
  statusChart?.resize()
}

onMounted(() => {
  loadProfile()
  window.addEventListener('resize', resizeHandler)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeHandler)
  channelChart?.dispose()
  statusChart?.dispose()
})
</script>

<style lang="scss" scoped>
.profile-view {
  min-height: 100%;
  padding: 18px;
  background: #0f172a;
  color: #e2e8f0;
}

.profile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;

  &__identity,
  &__actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__title {
    margin: 0;
    color: #f8fafc;
    font-size: 18px;
    font-weight: 700;
  }

  p {
    margin: 3px 0 0;
    color: #64748b;
    font-size: 12px;
  }
}

.profile-loading {
  height: 240px;
}

.info-card,
.kpi-card,
.surface,
.chart-card {
  border: 1px solid #334155;
  border-radius: 8px;
  background: #1e293b;
}

.info-card {
  min-height: 216px;
  padding: 20px;
  text-align: center;

  &__avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 58px;
    height: 58px;
    margin: 0 auto 10px;
    border-radius: 50%;
    background: #0ea5e9;
    color: #f8fafc;
    font-size: 20px;
    font-weight: 700;
  }

  &__name {
    color: #f8fafc;
    font-size: 17px;
    font-weight: 700;
  }

  &__phone,
  &__meta,
  &__since {
    margin-top: 4px;
    color: #64748b;
    font-size: 12px;
  }

  &__badges {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin: 12px 0;
  }

  &__notes {
    margin: 10px 0;
    padding: 8px;
    border-radius: 6px;
    background: #0f172a;
    color: #94a3b8;
    font-size: 12px;
    text-align: left;
  }
}

.kpi-card {
  min-height: 102px;
  margin-bottom: 12px;
  padding: 16px;

  &__label {
    margin-bottom: 8px;
    color: #94a3b8;
    font-size: 12px;
  }

  &__value {
    font-size: 24px;
    font-weight: 700;
  }

  &--primary .kpi-card__value { color: #38bdf8; }
  &--success .kpi-card__value { color: #34d399; }
  &--warning .kpi-card__value { color: #fbbf24; }
  &--danger .kpi-card__value { color: #fb7185; }
}

.section-row {
  margin-top: 16px;
}

.surface {
  height: 100%;
  padding: 16px;

  &__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;

    h2 {
      margin: 0;
      color: #f1f5f9;
      font-size: 14px;
      font-weight: 700;
    }

    p {
      margin: 4px 0 0;
      color: #64748b;
      font-size: 12px;
    }
  }
}

.stage-summary {
  display: grid;
  grid-template-columns: minmax(80px, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  padding: 12px;
  border-left: 3px solid #38bdf8;
  border-radius: 6px;
  background: #0f172a;

  span,
  small {
    color: #64748b;
    font-size: 11px;
  }

  strong {
    grid-row: span 2;
    color: #38bdf8;
    font-size: 17px;
  }
}

.analysis-block {
  margin-top: 14px;

  &__label {
    display: block;
    margin-bottom: 6px;
    color: #94a3b8;
    font-size: 11px;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: #cbd5e1;
    font-size: 12px;
    line-height: 1.7;
  }
}

.signal-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  &--compact {
    margin-top: 8px;
  }
}

.conversation-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 34px;
  margin-top: 5px;
  padding: 6px 8px;
  border: 1px solid #334155;
  border-radius: 5px;
  background: #172033;
  color: #cbd5e1;
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:hover {
    border-color: #38bdf8;
    color: #7dd3fc;
  }

  span {
    min-width: 0;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    flex-shrink: 0;
    margin-left: 8px;
    color: #64748b;
    font-size: 10px;
  }
}

.communication-history {
  min-height: 420px;
}

.communication-timeline {
  max-height: 500px;
  padding: 4px 8px 0 2px;
  overflow: auto;
}

.communication-entry {
  padding: 10px 12px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #172033;

  &__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    span {
      color: #64748b;
      font-size: 11px;
    }
  }

  p {
    margin: 9px 0 0;
    color: #cbd5e1;
    font-size: 12px;
    line-height: 1.6;
  }
}

.followup-section {
  height: auto;
}

.followup-counts {
  display: flex;
  gap: 16px;
  color: #94a3b8;
  font-size: 11px;

  strong {
    color: #f8fafc;
    font-size: 15px;
  }
}

.followup-list {
  display: grid;
  gap: 8px;
}

.followup-item {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #172033;

  &__state {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #334155;
    color: #94a3b8;

    svg { width: 17px; }
    &.is-overdue { background: #4c1d2d; color: #fb7185; }
    &.is-due,
    &.is-pending { background: #422f15; color: #fbbf24; }
    &.is-completed { background: #153c35; color: #34d399; }
  }

  &__heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    > div {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;
    }

    strong {
      color: #f1f5f9;
      font-size: 13px;
    }

    time {
      flex-shrink: 0;
      color: #94a3b8;
      font-size: 12px;
    }
  }

  &__body > p {
    margin: 7px 0 0;
    color: #94a3b8;
    font-size: 12px;
    line-height: 1.5;
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 7px;
    color: #64748b;
    font-size: 10px;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 6px;

    :deep(.el-button + .el-button) {
      margin-left: 0;
    }
  }
}

.chart-card {
  min-height: 270px;
  margin-bottom: 12px;
  padding: 16px;

  &__title {
    margin-bottom: 12px;
    color: #cbd5e1;
    font-size: 13px;
    font-weight: 600;
  }

  &__canvas {
    height: 220px;
  }
}

.schedule-input {
  width: 100%;
}

.muted {
  color: #64748b !important;
}

:deep(.el-timeline-item__timestamp) {
  color: #64748b;
  font-size: 11px;
}

:deep(.el-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: #172033;
  --el-table-row-hover-bg-color: #263449;
  --el-table-text-color: #cbd5e1;
  --el-table-header-text-color: #94a3b8;
  --el-table-border-color: #334155;
}

@media (max-width: 992px) {
  .profile-analysis {
    height: auto;
    margin-bottom: 16px;
  }

  .followup-item {
    grid-template-columns: 38px minmax(0, 1fr);

    &__actions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
}

@media (max-width: 680px) {
  .profile-view {
    padding: 12px;
  }

  .profile-header,
  .profile-header__identity,
  .profile-header__actions,
  .surface__header,
  .followup-item__heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .profile-header__actions,
  .profile-header__actions .el-button {
    width: 100%;
  }

  .followup-counts {
    width: 100%;
    justify-content: space-between;
  }

  .communication-entry__title {
    align-items: flex-start;
    flex-direction: column;
  }

  .followup-item {
    grid-template-columns: 1fr;
  }

  .followup-item__state,
  .followup-item__actions {
    grid-column: 1;
  }

  .followup-item__actions {
    flex-wrap: wrap;
  }
}
</style>
