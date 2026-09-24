<template>
  <div class="statistics-view">
    <section class="stats-toolbar">
      <div class="stats-toolbar__title">
        <h1>数据统计</h1>
        <span>{{ buildParams().start_date }} 至 {{ buildParams().end_date }}</span>
      </div>
      <div class="stats-toolbar__controls">
        <div class="quick-ranges" aria-label="date shortcuts">
          <el-button
            v-for="item in quickRanges"
            :key="item.key"
            size="small"
            :type="activeQuickRange === item.key ? 'primary' : 'default'"
            plain
            @click="applyQuickRange(item.key)"
          >
            {{ item.label }}
          </el-button>
        </div>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          :clearable="false"
          class="filter-panel__date"
          @change="handleDateChange"
        />
        <el-select v-model="channelFilter" placeholder="全部渠道" clearable class="filter-panel__select">
          <el-option label="WhatsApp" value="whatsapp" />
          <el-option label="抖音" value="douyin" />
          <el-option label="微信" value="wechat" />
        </el-select>
        <el-select v-model="agentFilter" placeholder="全部客服" clearable filterable class="filter-panel__select">
          <el-option
            v-for="agent in agentOptions"
            :key="agent.agentId"
            :label="agent.name"
            :value="agent.agentId"
          />
        </el-select>
        <el-button type="primary" :icon="Search" :loading="loading" @click="loadDashboard">查询</el-button>
        <el-button :icon="Refresh" @click="handleReset">重置</el-button>
      </div>
    </section>

    <section class="realtime-strip" v-loading="loading">
      <div class="realtime-strip__main">
        <span class="realtime-strip__label">AI服务中客户数</span>
        <strong class="realtime-strip__value">{{ numberText(poolStats.ai_self) }}</strong>
      </div>
      <div class="realtime-strip__agents">
        <span class="realtime-strip__label">坐席当前接待</span>
        <div class="realtime-agent-list">
          <span v-for="agent in realtimeAgents" :key="agent.agentId" class="realtime-agent">
            <span>{{ agent.name }}</span>
            <strong>{{ numberText(agent.currentPrivateCount) }}</strong>
          </span>
        </div>
      </div>
    </section>

    <div class="metric-sections" v-loading="loading">
      <section v-for="section in metricSections" :key="section.key" class="metric-section">
        <div class="metric-section__header">
          <span class="metric-section__title">{{ section.title }}</span>
          <span class="metric-section__hint">{{ section.hint }}</span>
        </div>
        <el-row :gutter="12" class="metric-grid">
          <el-col v-for="card in section.cards" :key="card.key" :xs="12" :sm="12" :md="12" :xl="12">
            <div class="metric-card" :class="`metric-card--${card.tone}`">
              <div class="metric-card__glow"></div>
              <div class="metric-card__label">
                <span>{{ card.label }}</span>
                <el-tooltip
                  v-if="card.tip"
                  :content="card.tip"
                  placement="top"
                  effect="dark"
                  popper-class="metric-card-tip"
                >
                  <el-icon class="metric-card__tip"><InfoFilled /></el-icon>
                </el-tooltip>
              </div>
              <div class="metric-card__value">
                {{ card.value }}
                <span v-if="card.unit" class="metric-card__unit">{{ card.unit }}</span>
              </div>
            </div>
          </el-col>
        </el-row>
      </section>
    </div>

    <el-row :gutter="12" class="chart-grid">
      <el-col :xs="24" :lg="15">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span>AI处理趋势</span>
          </template>
          <div ref="trendChartRef" class="chart-card__canvas"></div>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="9">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span>AI转人工原因分布</span>
          </template>
          <div ref="channelChartRef" class="chart-card__canvas"></div>
        </el-card>
      </el-col>
      <el-col :xs="24">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span>客服跟进质量对比</span>
          </template>
          <div ref="agentChartRef" class="chart-card__canvas chart-card__canvas--wide"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="performance-panel" shadow="never">
      <template #header>
        <div class="performance-panel__header">
          <span>客服跟进质量明细</span>
          <el-button type="primary" plain :icon="Download" :loading="exporting" @click="handleExport">
            导出报表
          </el-button>
        </div>
      </template>
      <el-table :data="agentPerformance" border stripe v-loading="loading">
        <el-table-column prop="name" label="客服" min-width="120" />
        <el-table-column prop="role" label="角色" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="replyMessages" label="跟进消息" width="120" align="center" sortable />
        <el-table-column prop="repliedCustomers" label="跟进客户" width="130" align="center" sortable />
        <el-table-column prop="effectiveFollowupCustomers" label="有效跟进客户" width="140" align="center" sortable />
        <el-table-column prop="effectiveFollowupRate" label="有效率" width="110" align="center" sortable>
          <template #default="{ row }">{{ percentText(row.effectiveFollowupRate) }}</template>
        </el-table-column>
        <el-table-column prop="firstResponseSeconds" label="首次响应" width="130" align="center" sortable>
          <template #default="{ row }">{{ formatDuration(row.firstResponseSeconds) }}</template>
        </el-table-column>
        <el-table-column prop="avgClaimSeconds" label="待人工领取" width="130" align="center" sortable>
          <template #default="{ row }">{{ formatDuration(row.avgClaimSeconds) }}</template>
        </el-table-column>
        <el-table-column prop="silenceRate" label="转人工后沉默率" width="140" align="center" sortable>
          <template #default="{ row }">{{ percentText(row.silenceRate) }}</template>
        </el-table-column>
        <el-table-column prop="currentPrivateCount" label="当前接待" width="120" align="center" sortable />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { Download, InfoFilled, Refresh, Search } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import { exportReport, getAgentPerformance, getOverview } from '@/api/statistics'
import { getPoolStats } from '@/api/conversations'

const today = dayjs().format('YYYY-MM-DD')
const dateRange = ref([today, today])
const channelFilter = ref('')
const agentFilter = ref('')
const activeQuickRange = ref('today')
const loading = ref(false)
const exporting = ref(false)
const overview = ref(null)
const agentPerformance = ref([])
const agentOptionsMap = ref(new Map())
const poolStats = ref({ ai_self: 0, pending_human: 0, public: 0, long_term: 0, private: 0, all: 0 })

const trendChartRef = ref(null)
const channelChartRef = ref(null)
const agentChartRef = ref(null)
let trendChart = null
let channelChart = null
let agentChart = null

const quickRanges = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨天' },
  { key: 'thisWeek', label: '本周' },
  { key: 'lastWeek', label: '上周' },
  { key: 'thisMonth', label: '本月' },
  { key: 'thisYear', label: '本年' }
]

const weekStart = (date) => {
  const day = date.day()
  const offset = day === 0 ? 6 : day - 1
  return date.subtract(offset, 'day')
}

const quickRangeMap = {
  today: () => {
    const now = dayjs()
    return [now, now]
  },
  yesterday: () => {
    const yesterday = dayjs().subtract(1, 'day')
    return [yesterday, yesterday]
  },
  thisWeek: () => {
    const start = weekStart(dayjs())
    return [start, start.add(6, 'day')]
  },
  lastWeek: () => {
    const start = weekStart(dayjs()).subtract(7, 'day')
    return [start, start.add(6, 'day')]
  },
  thisMonth: () => {
    const now = dayjs()
    return [now.startOf('month'), now.endOf('month')]
  },
  thisYear: () => {
    const now = dayjs()
    return [now.startOf('year'), now.endOf('year')]
  }
}

const applyQuickRange = (key) => {
  const rangeFactory = quickRangeMap[key]
  if (!rangeFactory) return
  const [start, end] = rangeFactory()
  activeQuickRange.value = key
  dateRange.value = [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')]
  loadDashboard()
}

const handleDateChange = () => {
  activeQuickRange.value = ''
}

const numberText = (value) => Number(value || 0).toLocaleString()

const percentText = (value) => `${Number(value || 0).toLocaleString()}%`

const formatDuration = (seconds) => {
  const value = Number(seconds || 0)
  if (!value) return '-'
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  const remain = value % 60
  if (minutes < 60) return remain ? `${minutes}m ${remain}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftMinutes = minutes % 60
  return leftMinutes ? `${hours}h ${leftMinutes}m` : `${hours}h`
}

const roleLabel = (role) => ({
  agent: '客服',
  supervisor: '主管',
  admin: '管理员',
  unassigned: '历史未归属'
}[role] || role || '-')

const avgSecondsFromRows = (rows, key) => {
  const values = rows.map(row => Number(row[key] || 0)).filter(value => value > 0)
  if (!values.length) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

const agentSummary = computed(() => {
  const rows = agentPerformance.value.filter(row => row.agentId != null)
  const repliedCustomers = rows.reduce((sum, row) => sum + Number(row.repliedCustomers || 0), 0)
  const effectiveFollowupCustomers = rows.reduce((sum, row) => sum + Number(row.effectiveFollowupCustomers || 0), 0)
  const handoffFollowedConversations = rows.reduce((sum, row) => sum + Number(row.handoffFollowedConversations || 0), 0)
  const silentConversations = rows.reduce((sum, row) => sum + Number(row.silentConversations || 0), 0)
  return {
    repliedCustomers,
    effectiveFollowupCustomers,
    firstResponseSeconds: avgSecondsFromRows(rows, 'firstResponseSeconds'),
    avgClaimSeconds: avgSecondsFromRows(rows, 'avgClaimSeconds'),
    silenceRate: handoffFollowedConversations > 0 ? Number(((silentConversations / handoffFollowedConversations) * 100).toFixed(1)) : 0
  }
})

const metricSections = computed(() => {
  const metrics = overview.value?.metrics || {}
  const agents = agentSummary.value
  return [
    {
      key: 'inquiry',
      title: '询盘概览',
      hint: '按去重客户统计客户来源和新增复询',
      cards: [
        {
          key: 'inquiryCustomers',
          label: '询盘客户数',
          value: numberText(metrics.inquiryCustomers),
          tone: 'primary',
          tip: '统计所选时间内发来客户消息的去重客户数，同一渠道、账号和客户ID视为同一个客户。'
        },
        {
          key: 'newInquiryCustomers',
          label: '新增客户数',
          value: numberText(metrics.newInquiryCustomers),
          tone: 'success',
          tip: '统计所选时间内首次出现的询盘客户；如果该客户在开始日期之前没有客户消息记录，就计为新增客户。'
        },
        {
          key: 'returningInquiryCustomers',
          label: '老客户复询',
          value: numberText(metrics.returningInquiryCustomers),
          tone: 'warning',
          tip: '统计所选时间内再次发起咨询的老客户；如果该客户在开始日期之前已有客户消息记录，就计为复询。'
        },
        {
          key: 'inboundMessages',
          label: '客户消息数',
          value: numberText(metrics.inboundMessages),
          tone: 'info',
          tip: '统计所选时间内客户发来的入站消息总条数，不去重客户，用来观察咨询量压力。'
        }
      ]
    },
    {
      key: 'agent',
      title: '客服跟进质量',
      hint: '看首次响应、领取速度、有效互动和客户沉默情况',
      cards: [
        {
          key: 'agentCustomers',
          label: '人工跟进客户',
          value: numberText(agents.repliedCustomers || metrics.agentRepliedCustomers),
          tone: 'primary',
          tip: '统计所选时间内收到人工客服回复的去重客户数，用来衡量人工实际接触了多少客户。'
        },
        {
          key: 'firstResponse',
          label: '平均首次响应时长',
          value: formatDuration(agents.firstResponseSeconds),
          tone: 'warning',
          tip: '统计客服在一个会话里第一次人工回复，距离该会话首条客户消息的平均时间；越短代表首次接待越快。'
        },
        {
          key: 'claimSeconds',
          label: '待人工领取时长',
          value: formatDuration(agents.avgClaimSeconds),
          tone: 'warning',
          tip: '统计客户进入待人工或公共池后，到客服领取为私有池的平均时间；主要反映抢单和排班响应速度。'
        },
        {
          key: 'effectiveCustomers',
          label: '有效跟进客户',
          value: numberText(agents.effectiveFollowupCustomers),
          tone: 'success',
          tip: '统计客服回复后客户又继续回话的去重客户数；它比单纯消息数更接近真实互动和跟进有效性。'
        },
        {
          key: 'silenceRate',
          label: '转人工后沉默率',
          value: percentText(agents.silenceRate),
          tone: 'danger',
          tip: '统计 AI 转人工后，人工客服已经发送过消息，但客户在客服最后一条回复后没有再回复的会话占比；更适合观察高意向承接后的跟进效果。'
        }
      ]
    },
    {
      key: 'ai',
      title: 'AI 提效',
      hint: '看 AI 承接、独立解决、高意向转接和节省人工量',
      cards: [
        {
          key: 'aiAcceptanceRate',
          label: 'AI承接率',
          value: percentText(metrics.aiAcceptanceRate),
          tone: 'primary',
          tip: 'AI服务客户数 ÷ 询盘客户数。AI服务客户包含 AI 已回复客户，以及 AI 判断需要转人工的客户。'
        },
        {
          key: 'aiIndependentRate',
          label: 'AI独立解决率',
          value: percentText(metrics.aiIndependentRate),
          tone: 'success',
          tip: 'AI独立解决客户数 ÷ AI服务客户数。当前口径为 AI 有回复且所选时间内没有 AI 转人工记录的客户。'
        },
        {
          key: 'aiTransferCustomers',
          label: '高意向转接客户',
          value: numberText(metrics.aiTransferCustomers),
          tone: 'danger',
          tip: '统计所选时间内由 AI 转入待人工池的去重客户数；实际代表 AI 判断需要人工承接的客户。'
        },
        {
          key: 'aiTransferRate',
          label: '高意向转接率',
          value: percentText(metrics.aiTransferRate),
          tone: 'danger',
          tip: '高意向转接客户数 ÷ AI服务客户数。比例高说明 AI 把更多客户交给人工，需结合原因分布判断是客户质量高还是知识命中不足。'
        },
        {
          key: 'aiSavedWorkload',
          label: 'AI节省人工量',
          value: numberText(metrics.aiSavedAgentWorkload),
          tone: 'success',
          tip: '用 AI独立解决客户数估算节省的人工接待客户量；当前是运营估算口径，不等同于真实工时。'
        },
        {
          key: 'aiMessages',
          label: 'AI自动处理消息',
          value: numberText(metrics.aiReplyMessages),
          tone: 'info',
          tip: '统计所选时间内 AI 成功发出的自动回复消息条数，用来衡量 AI 实际处理的消息规模。'
        }
      ]
    }
  ]
})

const agentOptions = computed(() => Array.from(agentOptionsMap.value.values()))
const realtimeAgents = computed(() =>
  agentPerformance.value
    .filter(agent => agent.agentId != null)
    .map(agent => ({
      agentId: agent.agentId,
      name: agent.name,
      currentPrivateCount: Number(agent.currentPrivateCount || 0)
    }))
    .sort((a, b) => b.currentPrivateCount - a.currentPrivateCount || a.name.localeCompare(b.name))
)

const buildParams = () => ({
  start_date: dateRange.value?.[0] || today,
  end_date: dateRange.value?.[1] || dateRange.value?.[0] || today,
  channel: channelFilter.value || undefined,
  agent_id: agentFilter.value || undefined
})

const ensureCharts = () => {
  if (trendChartRef.value && !trendChart) trendChart = echarts.init(trendChartRef.value)
  if (channelChartRef.value && !channelChart) channelChart = echarts.init(channelChartRef.value)
  if (agentChartRef.value && !agentChart) agentChart = echarts.init(agentChartRef.value)
}

const updateTrendChart = () => {
  const trend = overview.value?.trend?.list || []
  trendChart?.setOption({
    color: ['#22d3ee', '#34d399', '#f59e0b'],
    tooltip: { trigger: 'axis', appendToBody: true, confine: false, backgroundColor: 'rgba(255, 255, 255, 0.96)', borderColor: '#67e8f9', textStyle: { color: '#0f172a' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: '#64748b', fontSize: 11 } },
    grid: { left: 8, right: 10, top: 18, bottom: 34, containLabel: true },
    xAxis: { type: 'category', data: trend.map(item => item.bucket), axisLabel: { color: '#64748b' }, axisLine: { lineStyle: { color: '#cbd5e1' } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.22)' } } },
    series: [
      { name: '客户消息', type: 'line', smooth: true, data: trend.map(item => Number(item.inbound_messages || 0)) },
      { name: 'AI自动处理', type: 'line', smooth: true, data: trend.map(item => Number(item.ai_replies || 0)) },
      { name: '人工高意向跟进', type: 'line', smooth: true, data: trend.map(item => Number(item.agent_replies || 0)) }
    ]
  })
}

const updateChannelChart = () => {
  const reasons = overview.value?.aiTransferReasons || []
  channelChart?.setOption({
    color: ['#22d3ee', '#34d399', '#f59e0b', '#f43f5e', '#a3e635'],
    tooltip: { trigger: 'item', appendToBody: true, confine: false, backgroundColor: 'rgba(255, 255, 255, 0.96)', borderColor: '#67e8f9', textStyle: { color: '#0f172a' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: '#64748b', fontSize: 11 } },
    series: [{
      name: '转人工原因',
      type: 'pie',
      radius: ['42%', '68%'],
      center: ['50%', '45%'],
      data: reasons.map(item => ({ name: item.label || '其他原因', value: Number(item.conversations || 0) }))
    }]
  })
}

const updateAgentChart = () => {
  const rows = agentPerformance.value.slice(0, 12)
  agentChart?.setOption({
    color: ['#22d3ee', '#34d399', '#f59e0b'],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true, confine: false, backgroundColor: 'rgba(255, 255, 255, 0.96)', borderColor: '#67e8f9', textStyle: { color: '#0f172a' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: '#64748b', fontSize: 11 } },
    grid: { left: 8, right: 10, top: 18, bottom: 34, containLabel: true },
    xAxis: { type: 'category', data: rows.map(row => row.name), axisLabel: { color: '#64748b' }, axisLine: { lineStyle: { color: '#cbd5e1' } } },
    yAxis: [
      { type: 'value', minInterval: 1, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.22)' } } },
      { type: 'value', axisLabel: { color: '#64748b', formatter: '{value}m' }, splitLine: { show: false } }
    ],
    series: [
      { name: '跟进客户', type: 'bar', data: rows.map(row => row.repliedCustomers) },
      { name: '有效跟进客户', type: 'bar', data: rows.map(row => row.effectiveFollowupCustomers) },
      {
        name: '首次响应(分钟)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        data: rows.map(row => Number((Number(row.firstResponseSeconds || 0) / 60).toFixed(1)))
      }
    ]
  })
}

const refreshCharts = async () => {
  await nextTick()
  ensureCharts()
  updateTrendChart()
  updateChannelChart()
  updateAgentChart()
}

const loadDashboard = async () => {
  loading.value = true
  try {
    const params = buildParams()
    const [overviewRes, performanceRes, poolStatsRes] = await Promise.all([
      getOverview(params),
      getAgentPerformance(params),
      getPoolStats()
    ])
    overview.value = overviewRes.data
    agentPerformance.value = performanceRes.data?.list || []
    poolStats.value = poolStatsRes.data || poolStats.value
    const nextMap = new Map(agentOptionsMap.value)
    for (const agent of agentPerformance.value) {
      if (agent.agentId != null) {
        nextMap.set(agent.agentId, { agentId: agent.agentId, name: agent.name })
      }
    }
    agentOptionsMap.value = nextMap
    await refreshCharts()
  } catch (err) {
    console.error('[Statistics] load failed:', err)
  } finally {
    loading.value = false
  }
}

const handleReset = () => {
  dateRange.value = [today, today]
  activeQuickRange.value = 'today'
  channelFilter.value = ''
  agentFilter.value = ''
  loadDashboard()
}

const handleExport = async () => {
  exporting.value = true
  try {
    const blob = await exportReport(buildParams())
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `AI提效统计-${buildParams().start_date}-${buildParams().end_date}.csv`
    link.click()
    window.URL.revokeObjectURL(url)
    ElMessage.success('报表已导出')
  } catch (err) {
    console.error('[Statistics] export failed:', err)
  } finally {
    exporting.value = false
  }
}

const handleResize = () => {
  trendChart?.resize()
  channelChart?.resize()
  agentChart?.resize()
}

onMounted(async () => {
  await loadDashboard()
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  trendChart?.dispose()
  channelChart?.dispose()
  agentChart?.dispose()
})
</script>

<style scoped lang="scss">
.statistics-view {
  min-height: 100%;
  padding: 12px;
  background: #f5f7fa;
  color: $text-primary;
}

.stats-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: linear-gradient(90deg, #ffffff 0%, #f8fafc 100%);
  box-shadow: $shadow-light;

  &__title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 180px;

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      color: $text-primary;
    }

    span {
      font-size: 12px;
      color: $text-secondary;
      white-space: nowrap;
    }
  }

  &__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  :deep(.el-input__wrapper),
  :deep(.el-select__wrapper) {
    background: #fff;
    box-shadow: none;
    border: 1px solid $color-border;
  }

  .filter-panel__date { width: 220px; }
  .filter-panel__select { width: 136px; }
}

.realtime-strip {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 8px;
  min-height: 50px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: #fff;
  box-shadow: $shadow-light;

  &__main,
  &__agents {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  &__main {
    padding-right: 10px;
    border-right: 1px solid #e2e8f0;
  }

  &__label {
    flex-shrink: 0;
    font-size: 12px;
    color: $text-secondary;
  }

  &__value {
    font-size: 24px;
    line-height: 1;
    color: #2563eb;
  }
}

.realtime-agent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.realtime-agent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid #dbeafe;
  border-radius: 6px;
  background: #eff6ff;
  color: #334155;
  font-size: 12px;
  white-space: nowrap;

  strong {
    color: #2563eb;
    font-size: 14px;
  }
}

.quick-ranges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;

  :deep(.el-button) {
    min-width: 42px;
    height: 28px;
    padding: 0 8px;
    border-radius: $radius-md;
  }

  :deep(.el-button--primary.is-plain) {
    color: $color-primary-dark;
    border-color: #bfdbfe;
    background: #eff6ff;
  }
}

.metric-sections {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.metric-section {
  min-width: 0;
  padding: 8px 10px 0;
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: #fff;
  box-shadow: $shadow-light;

  &__header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }

  &__title {
    font-size: 14px;
    font-weight: 700;
    color: $text-primary;
  }

  &__hint {
    font-size: 12px;
    color: $text-secondary;
  }
}

.metric-grid {
  margin-bottom: 0;
}

.metric-card {
  position: relative;
  overflow: hidden;
  min-height: 54px;
  margin-bottom: 8px;
  padding: 7px 10px 7px 12px;
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: #fff;
  box-shadow: $shadow-light;

  &--primary { --accent: #3b82f6; }
  &--success { --accent: #22c55e; }
  &--warning { --accent: #f59e0b; }
  &--danger { --accent: #ef4444; }
  &--info { --accent: #64748b; }

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
  }

  &__glow {
    display: none;
  }

  &__label {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 2px;
    font-size: 12px;
    color: $text-secondary;
  }

  &__tip {
    flex-shrink: 0;
    font-size: 13px;
    color: #94a3b8;
    cursor: help;

    &:hover {
      color: #2563eb;
    }
  }

  &__value {
    position: relative;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.15;
    color: $text-primary;
    word-break: break-word;
  }

  &__unit {
    margin-left: 2px;
    font-size: 12px;
    font-weight: 400;
    color: #64748b;
  }
}

.chart-grid {
  margin-bottom: 10px;
}

.chart-card {
  margin-bottom: 10px;
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: #fff;
  box-shadow: $shadow-light;

  :deep(.el-card__header) {
    height: 40px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    font-weight: 600;
    color: $text-primary;
    border-bottom: 1px solid $color-border;
  }

  :deep(.el-card__body) {
    padding: 8px 10px 10px;
  }

  &__canvas {
    width: 100%;
    height: 172px;

    &--wide {
      height: 184px;
    }
  }
}

.performance-panel {
  border: 1px solid $color-border;
  border-radius: $radius-lg;
  background: #fff;
  box-shadow: $shadow-light;

  :deep(.el-card__header) {
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid $color-border;
  }

  :deep(.el-card__body) { padding: 10px; }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    color: $text-primary;
  }

  :deep(.el-table) {
    --el-table-bg-color: transparent;
    --el-table-tr-bg-color: transparent;
    --el-table-header-bg-color: #f8fafc;
    --el-table-header-text-color: #475569;
    --el-table-text-color: #475569;
    --el-table-row-hover-bg-color: #f8fafc;
    --el-table-border-color: #e2e8f0;
    background: transparent;
  }

  :deep(.el-table__body tr.el-table__row--striped td.el-table__cell) {
    background: #fbfdff;
  }
}

:global(.metric-card-tip) {
  max-width: 280px;
  line-height: 1.6;
}

@media (max-width: 768px) {
  .statistics-view {
    padding: 12px;
  }

  .stats-toolbar {
    align-items: flex-start;
    flex-direction: column;

    &__controls { justify-content: flex-start; }
  }

  .filter-panel__select {
    width: 100%;
  }

  .filter-panel__date {
    width: 100%;
  }

  .realtime-strip {
    grid-template-columns: 1fr;

    &__main {
      border-right: none;
      border-bottom: 1px solid #e2e8f0;
      padding-right: 0;
      padding-bottom: 8px;
    }

    &__agents {
      align-items: flex-start;
      flex-direction: column;
      gap: 6px;
    }
  }

  .metric-sections {
    grid-template-columns: 1fr;
  }

  .metric-section__header {
    flex-direction: column;
    gap: 2px;
  }

  .metric-card__value {
    font-size: 22px;
  }
}
</style>
