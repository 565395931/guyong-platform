<template>
  <div class="after-sales-view">
    <section class="as-toolbar">
      <h1 class="as-toolbar__title">售后分析</h1>
      <div class="as-toolbar__controls">
        <div class="quick-ranges">
          <el-button v-for="r in quickRanges" :key="r.key" size="small" plain
            :type="activeRange === r.key ? 'primary' : 'default'" @click="applyRange(r.key)">{{ r.label }}</el-button>
        </div>
        <el-date-picker v-model="dateRange" type="daterange" range-separator="至"
          start-placeholder="开始日期" end-placeholder="结束日期"
          format="YYYY-MM-DD" value-format="YYYY-MM-DD" :clearable="false"
          @change="handleDateChange" />
        <el-select v-model="channelFilter" placeholder="全部渠道" clearable>
          <el-option label="WhatsApp" value="whatsapp" />
          <el-option label="微信客服" value="wecom_kf" />
          <el-option label="抖店" value="douyin" />
          <el-option label="拼多多" value="pinduoduo" />
          <el-option label="淘宝" value="taobao" />
          <el-option label="1688" value="alibaba1688" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="load">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </section>

    <div v-loading="loading">
      <el-row :gutter="16" class="kpi-row">
        <el-col :xs="24" :sm="8">
          <div class="kpi-card kpi-card--primary">
            <div class="kpi-card__label">售后订单数</div>
            <div class="kpi-card__value">{{ summary.totalOrders }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="8">
          <div class="kpi-card kpi-card--danger">
            <div class="kpi-card__label">售后总金额</div>
            <div class="kpi-card__value">{{ formatMoney(summary.totalAmount) }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="8">
          <div class="kpi-card kpi-card--warning">
            <div class="kpi-card__label">平均单笔金额</div>
            <div class="kpi-card__value">{{ formatMoney(summary.avgAmount) }}</div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="chart-row">
        <el-col :xs="24" :sm="12">
          <div class="chart-card">
            <div class="chart-card__title">渠道分布</div>
            <div ref="channelChartRef" class="chart-card__canvas"></div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12">
          <div class="chart-card">
            <div class="chart-card__title">每日趋势</div>
            <div ref="trendChartRef" class="chart-card__canvas"></div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="chart-row">
        <el-col :xs="24" :sm="14">
          <div class="chart-card">
            <div class="chart-card__title">产品分布（按售后订单数）</div>
            <div ref="productChartRef" class="chart-card__canvas chart-card__canvas--tall"></div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="10">
          <div class="chart-card">
            <div class="chart-card__title">售后原因分布</div>
            <el-table :data="reasonList" size="small" class="reason-table">
              <el-table-column label="原因" prop="reason" />
              <el-table-column label="订单数" prop="cnt" width="80" align="right" />
            </el-table>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { getAfterSalesStats } from '@/api/statistics'

const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp', wecom_kf: '微信客服', douyin: '抖店',
  pinduoduo: '拼多多', taobao: '淘宝', alibaba1688: '1688'
}
const STATUS_LABELS = {
  draft: '草稿', confirmed: '确认', paid: '已付款', purchasing: '采购中',
  domestic_shipping: '国内发货', international_shipping: '国际发货',
  delivered: '已交付', after_sales: '售后', closed: '已关闭', cancelled: '已取消'
}

const quickRanges = [
  { key: '7d', label: '近7天' }, { key: '30d', label: '近30天' },
  { key: 'thisMonth', label: '本月' }, { key: '90d', label: '近90天' }
]
const activeRange = ref('30d')
const dateRange = ref([])
const channelFilter = ref('')
const loading = ref(false)

const summary = reactive({ totalOrders: 0, totalAmount: 0, avgAmount: 0 })
const reasonList = ref([])

const channelChartRef = ref(null)
const trendChartRef = ref(null)
const productChartRef = ref(null)
let channelChart = null, trendChart = null, productChart = null

function formatMoney(v) {
  const n = Number(v || 0)
  return n >= 10000 ? `$${(n / 10000).toFixed(1)}万` : `$${n.toFixed(0)}`
}

function getDateRange(key) {
  const now = new Date()
  const fmt = d => d.toISOString().slice(0, 10)
  const today = fmt(now)
  if (key === '7d') {
    const s = new Date(now); s.setDate(s.getDate() - 6); return [fmt(s), today]
  }
  if (key === '30d') {
    const s = new Date(now); s.setDate(s.getDate() - 29); return [fmt(s), today]
  }
  if (key === '90d') {
    const s = new Date(now); s.setDate(s.getDate() - 89); return [fmt(s), today]
  }
  if (key === 'thisMonth') {
    return [`${today.slice(0, 7)}-01`, today]
  }
  return [today, today]
}

function applyRange(key) {
  activeRange.value = key
  dateRange.value = getDateRange(key)
  load()
}

function handleDateChange() {
  activeRange.value = ''
  load()
}

function reset() {
  channelFilter.value = ''
  applyRange('30d')
}

function ensureCharts() {
  if (channelChartRef.value && !channelChart) channelChart = echarts.init(channelChartRef.value)
  if (trendChartRef.value && !trendChart) trendChart = echarts.init(trendChartRef.value)
  if (productChartRef.value && !productChart) productChart = echarts.init(productChartRef.value)
}

function renderChannelChart(data) {
  if (!channelChart) return
  const items = data.map(r => ({ name: CHANNEL_LABELS[r.channel] || r.channel, value: Number(r.order_count) }))
  channelChart.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c}单 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#94a3b8' } },
    series: [{ type: 'pie', radius: ['40%', '65%'], data: items,
      label: { color: '#94a3b8' },
      itemStyle: { borderRadius: 4 } }]
  })
}

function renderTrendChart(data) {
  if (!trendChart) return
  trendChart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map(r => r.date), axisLabel: { color: '#64748b', rotate: 30 } },
    yAxis: { type: 'value', axisLabel: { color: '#64748b' } },
    series: [{ type: 'line', data: data.map(r => Number(r.order_count)), smooth: true,
      areaStyle: { opacity: 0.2 }, itemStyle: { color: '#f87171' } }],
    grid: { left: 40, right: 20, top: 20, bottom: 50 }
  })
}

function renderProductChart(data) {
  if (!productChart) return
  const names = data.map(r => r.product_name?.slice(0, 20) || '未知').reverse()
  const counts = data.map(r => Number(r.order_count)).reverse()
  productChart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value', axisLabel: { color: '#64748b' } },
    yAxis: { type: 'category', data: names, axisLabel: { color: '#94a3b8', width: 100, overflow: 'truncate' } },
    series: [{ type: 'bar', data: counts, itemStyle: { color: '#fb923c', borderRadius: [0, 4, 4, 0] } }],
    grid: { left: 110, right: 30, top: 10, bottom: 20 }
  })
}

async function load() {
  if (!dateRange.value?.length) return
  loading.value = true
  try {
    const params = { start_date: dateRange.value[0], end_date: dateRange.value[1] }
    if (channelFilter.value) params.channel = channelFilter.value
    const res = await getAfterSalesStats(params)
    if (!res.success) return
    const d = res.data
    summary.totalOrders = d.summary.totalOrders
    summary.totalAmount = d.summary.totalAmount
    summary.avgAmount = d.summary.avgAmount
    reasonList.value = d.reasonDistribution || []
    await nextTick()
    ensureCharts()
    renderChannelChart(d.channelDistribution || [])
    renderTrendChart(d.trend || [])
    renderProductChart(d.productDistribution || [])
  } finally {
    loading.value = false
  }
}

const resizeHandler = () => {
  channelChart?.resize(); trendChart?.resize(); productChart?.resize()
}

onMounted(() => {
  dateRange.value = getDateRange('30d')
  load()
  window.addEventListener('resize', resizeHandler)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeHandler)
  channelChart?.dispose(); trendChart?.dispose(); productChart?.dispose()
})
</script>

<style lang="scss" scoped>
.after-sales-view { padding: 20px; min-height: 100%; }
.as-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;
  &__title { font-size: 18px; font-weight: 700; color: #e2e8f0; margin: 0; }
  &__controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; }
}
.quick-ranges { display: flex; gap: 4px; }
.kpi-row { margin-bottom: 16px; }
.kpi-card {
  border-radius: 10px; padding: 20px; margin-bottom: 12px; background: #1e293b;
  &__label { font-size: 12px; color: #64748b; margin-bottom: 8px; }
  &__value { font-size: 28px; font-weight: 700; }
  &--primary .kpi-card__value { color: #60a5fa; }
  &--danger .kpi-card__value { color: #f87171; }
  &--warning .kpi-card__value { color: #fbbf24; }
}
.chart-row { margin-bottom: 16px; }
.chart-card {
  background: #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 12px;
  &__title { font-size: 13px; color: #94a3b8; margin-bottom: 12px; font-weight: 600; }
  &__canvas { height: 240px; }
  &__canvas--tall { height: 320px; }
}
.reason-table { background: transparent; :deep(.el-table__header-wrapper th) { background: #0f172a; } }
</style>
