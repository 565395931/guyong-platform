<template>
  <div class="customers-view">
    <div class="customers-view__header">
      <div>
        <h1>客户管理</h1>
        <p>客户沟通、成交状态和智能复联集中查看</p>
      </div>
      <div class="customers-view__actions">
        <el-button :icon="Refresh" @click="refreshCurrentView">刷新</el-button>
        <el-button v-if="activeView === 'customers'" type="primary" :icon="Plus" @click="openCreate">新增客户</el-button>
      </div>
    </div>

    <div class="customers-panel">
      <div class="view-switcher" role="tablist" aria-label="客户视图">
        <button
          type="button"
          :class="['view-switcher__item', { 'is-active': activeView === 'customers' }]"
          @click="switchView('customers')"
        >客户列表</button>
        <button
          type="button"
          :class="['view-switcher__item', { 'is-active': activeView === 'daily-report' }]"
          @click="switchView('daily-report')"
        >今日报表</button>
      </div>

      <template v-if="activeView === 'customers'">
        <div class="toolbar">
          <el-input
            v-model="query.keyword"
            clearable
            placeholder="搜索手机号、名称或备注"
            :prefix-icon="Search"
            @keyup.enter="searchCustomers"
            @clear="searchCustomers"
          />
          <el-date-picker
            v-model="query.dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            range-separator="-"
            @change="searchCustomers"
          />
          <el-button type="primary" plain :icon="Search" @click="searchCustomers">查询</el-button>
          <el-button plain @click="resetFilters">重置</el-button>
        </div>

        <el-table
          v-loading="loading"
          class="customers-table"
          :data="customers"
          height="100%"
          border
        >
          <el-table-column prop="phone" label="手机号" width="180" show-overflow-tooltip />
          <el-table-column prop="displayName" label="客户名称" width="150" show-overflow-tooltip />
          <el-table-column label="沟通阶段" width="120">
            <template #default="{ row }">
              <el-tag v-if="row.currentStage" size="small" :type="stageType(row.currentStage)">
                {{ stageLabel(row.currentStage, row.communicationDays) }}
              </el-tag>
              <span v-else class="muted">暂无</span>
            </template>
          </el-table-column>
          <el-table-column label="沟通天数" width="100" align="center">
            <template #default="{ row }">{{ row.communicationDays || 0 }}</template>
          </el-table-column>
          <el-table-column label="成交状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.wonStatus === 'won' ? 'success' : 'info'">
                {{ row.wonStatus === 'won' ? '已成交' : '未成交' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="notes" label="备注" min-width="260" show-overflow-tooltip />
          <el-table-column label="操作" width="220" align="center" header-align="center" fixed="right">
            <template #default="{ row }">
              <div class="operation-actions">
                <el-button link type="success" :icon="User" @click="router.push(`/customers/${row.id}/profile`)">画像</el-button>
                <el-button link type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button link type="danger" :icon="Delete" @click="handleDelete(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination-bar">
          <el-pagination
            v-model:current-page="pagination.page"
            v-model:page-size="pagination.pageSize"
            :page-sizes="[20, 50, 100, 200]"
            :total="pagination.total"
            layout="total, sizes, prev, pager, next, jumper"
            background
            @size-change="handlePageSizeChange"
            @current-change="fetchCustomers"
          />
        </div>
      </template>

      <template v-else>
        <div class="report-toolbar">
          <el-date-picker
            v-model="reportDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            @change="fetchDailyReport"
          />
          <el-input
            v-if="isPrivileged"
            v-model="reportOwnerId"
            clearable
            placeholder="负责人 ID（可选）"
            class="report-owner-input"
            @keyup.enter="fetchDailyReport"
          />
          <el-button type="primary" plain :icon="Search" @click="fetchDailyReport">查询</el-button>
          <el-button v-if="isPrivileged" plain :icon="RefreshRight" @click="regenerateReport">重新生成</el-button>
        </div>

        <div v-loading="reportLoading" class="report-body">
          <template v-if="dailyReport">
            <div class="report-summary">
              <div class="report-summary__heading">
                <div>
                  <h2>{{ dailyReport.reportDate || reportDate }} 客户沟通报表</h2>
                  <p>{{ dailyReport.summary || '暂无 AI 总结，以下为实时统计。' }}</p>
                </div>
                <el-tag size="small" effect="plain">{{ dailyReport.source === 'ai' ? 'AI 已总结' : '实时统计' }}</el-tag>
              </div>
              <div class="report-kpis">
                <div v-for="item in reportKpis" :key="item.label" class="report-kpi">
                  <span class="report-kpi__label">{{ item.label }}</span>
                  <strong :class="`report-kpi__value report-kpi__value--${item.tone}`">{{ item.value }}</strong>
                </div>
              </div>
            </div>

            <div class="report-distribution">
              <div class="report-distribution__header">
                <span>沟通阶段分布</span>
                <span class="muted">当天按自然日计数</span>
              </div>
              <div v-for="item in stageDistribution" :key="item.label" class="stage-row">
                <span class="stage-row__label">{{ item.label }}</span>
                <el-progress :percentage="item.percentage" :color="item.color" :show-text="false" />
                <strong>{{ item.value }}</strong>
              </div>
            </div>

            <div class="report-details">
              <div class="report-details__header">
                <span>客户明细（{{ dailyReport.details.length }}）</span>
                <span class="muted">点击客户进入画像</span>
              </div>
              <el-table :data="dailyReport.details" size="small" border>
                <el-table-column prop="phone" label="客户" min-width="180" show-overflow-tooltip>
                  <template #default="{ row }">
                    <button class="customer-link" type="button" @click="router.push(`/customers/${row.id}/profile`)">
                      {{ row.displayName || row.phone }}
                    </button>
                  </template>
                </el-table-column>
                <el-table-column label="沟通标签" width="120">
                  <template #default="{ row }">
                    <el-tag size="small" :type="stageType(row.stageCode)">{{ row.stageLabel }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column v-if="isPrivileged" prop="ownerId" label="负责人 ID" width="110" />
                <el-table-column label="消息数" prop="messageCount" width="90" align="center" />
                <el-table-column label="AI 摘要" min-width="300" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.summary }}</template>
                </el-table-column>
                <el-table-column label="下次复联" width="170">
                  <template #default="{ row }">{{ formatDateTime(row.nextFollowupAt) || '待 AI 判断' }}</template>
                </el-table-column>
              </el-table>
            </div>
          </template>
          <el-empty v-else description="暂无日报数据" />
        </div>
      </template>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑客户' : '新增客户'"
      width="520px"
      class="customer-dialog"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="76px">
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" placeholder="请输入手机号" clearable />
        </el-form-item>
        <el-form-item label="客户名称">
          <el-input v-model="form.displayName" placeholder="可选" clearable />
        </el-form-item>
        <el-form-item label="联系时间" prop="contactTime">
          <el-date-picker
            v-model="form.contactTime"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="选择时间"
            class="form-date"
          />
        </el-form-item>
        <el-form-item label="备注" prop="notes">
          <el-input v-model="form.notes" type="textarea" :rows="5" resize="none" maxlength="5000" show-word-limit placeholder="填写客户备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCustomer">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, RefreshRight, Search, User } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import {
  createCustomer,
  deleteCustomer,
  getCustomers,
  getDailyCustomerReport,
  regenerateDailyCustomerReport,
  updateCustomer
} from '@/api/customers'
import { normalizeDailyReport, stageLabel } from '@/modules/customers/customerReport'

const router = useRouter()
const userStore = useUserStore()
const role = computed(() => userStore.userInfo?.role || 'user')
const isPrivileged = computed(() => ['admin', 'supervisor'].includes(role.value))

const activeView = ref('customers')
const loading = ref(false)
const reportLoading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const customers = ref([])
const dailyReport = ref(null)
const reportDate = ref(formatDateKey(new Date()))
const reportOwnerId = ref('')

const query = reactive({ keyword: '', dateRange: [] })
const pagination = reactive({ page: 1, pageSize: 50, total: 0 })
const form = reactive({ phone: '', displayName: '', contactTime: '', notes: '' })
const rules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { max: 60, message: '手机号不能超过 60 个字符', trigger: 'blur' }
  ],
  notes: [{ max: 5000, message: '备注不能超过 5000 个字符', trigger: 'blur' }]
}

const reportKpis = computed(() => {
  const report = dailyReport.value || {}
  return [
    { label: '沟通客户', value: report.customerCount || 0, tone: 'primary' },
    { label: '首次沟通', value: report.firstCount || 0, tone: 'info' },
    { label: '二次沟通', value: report.secondCount || 0, tone: 'warning' },
    { label: '三次沟通', value: report.thirdCount || 0, tone: 'success' },
    { label: '已成交', value: report.wonCount || 0, tone: 'danger' },
    { label: '待复联', value: report.dueCount || 0, tone: 'warning' }
  ]
})

const stageDistribution = computed(() => {
  const report = dailyReport.value || {}
  const total = Math.max(1, report.customerCount || 0)
  return [
    { label: '首次沟通', value: report.firstCount || 0, percentage: Math.round((report.firstCount || 0) / total * 100), color: '#3b82f6' },
    { label: '二次沟通', value: report.secondCount || 0, percentage: Math.round((report.secondCount || 0) / total * 100), color: '#f59e0b' },
    { label: '三次沟通', value: report.thirdCount || 0, percentage: Math.round((report.thirdCount || 0) / total * 100), color: '#10b981' }
  ]
})

onMounted(fetchCustomers)

function pad(value) { return String(value).padStart(2, '0') }
function formatDateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
function formatInputDate(date = new Date()) { return `${formatDateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` }
function formatDateTime(value) {
  if (!value) return ''
  return String(value).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19)
}
function stageType(code) { return ({ first: 'info', second: 'warning', third: 'success', nth: '' })[code] || '' }

function switchView(view) {
  activeView.value = view
  if (view === 'daily-report' && !dailyReport.value) fetchDailyReport()
}

function refreshCurrentView() { return activeView.value === 'daily-report' ? fetchDailyReport() : fetchCustomers() }

async function fetchCustomers() {
  loading.value = true
  try {
    const res = await getCustomers({
      keyword: query.keyword,
      start_date: query.dateRange?.[0] || '',
      end_date: query.dateRange?.[1] || '',
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize
    })
    customers.value = res.data?.list || []
    pagination.total = Number(res.data?.total || 0)
  } finally {
    loading.value = false
  }
}

async function fetchDailyReport() {
  reportLoading.value = true
  try {
    const res = await getDailyCustomerReport({ date: reportDate.value, owner_id: isPrivileged.value ? reportOwnerId.value || undefined : undefined })
    dailyReport.value = normalizeDailyReport(res.data || {})
  } finally {
    reportLoading.value = false
  }
}

async function regenerateReport() {
  reportLoading.value = true
  try {
    const res = await regenerateDailyCustomerReport({ date: reportDate.value, owner_id: reportOwnerId.value || undefined })
    dailyReport.value = normalizeDailyReport(res.data || {})
    ElMessage.success('日报已重新生成')
  } finally {
    reportLoading.value = false
  }
}

function searchCustomers() { pagination.page = 1; fetchCustomers() }
function handlePageSizeChange() { pagination.page = 1; fetchCustomers() }
function resetFilters() { query.keyword = ''; query.dateRange = []; searchCustomers() }

function resetForm(data = {}) {
  Object.assign(form, { phone: '', displayName: '', contactTime: formatInputDate(), notes: '', ...data })
  formRef.value?.clearValidate()
}
function openCreate() { editingId.value = ''; resetForm(); dialogVisible.value = true }
function openEdit(row) {
  editingId.value = row.id
  resetForm({ phone: row.phone || '', displayName: row.displayName || '', contactTime: row.contactTime || '', notes: row.notes || '' })
  dialogVisible.value = true
}

async function saveCustomer() {
  await formRef.value?.validate()
  saving.value = true
  try {
    const payload = {
      phone: form.phone.trim(),
      displayName: form.displayName?.trim() || null,
      contactTime: form.contactTime || null,
      notes: form.notes?.trim() || null
    }
    if (editingId.value) {
      await updateCustomer(editingId.value, payload)
      ElMessage.success('客户已更新')
    } else {
      await createCustomer(payload)
      ElMessage.success('客户已创建')
    }
    dialogVisible.value = false
    await fetchCustomers()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  await ElMessageBox.confirm(`确认删除客户 ${row.phone}？`, '删除确认', {
    type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger'
  })
  await deleteCustomer(row.id)
  ElMessage.success('客户已删除')
  fetchCustomers()
}
</script>

<style scoped lang="scss">
.customers-view { display: flex; flex-direction: column; height: 100%; padding: 16px 18px; background: #f5f7fa; overflow: hidden; }
.customers-view__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; flex-shrink: 0; }
.customers-view__header h1 { margin: 0; font-size: 20px; color: #1e293b; font-weight: 700; }
.customers-view__header p { margin: 4px 0 0; color: #64748b; font-size: 13px; }
.customers-view__actions { display: flex; gap: 8px; }
.customers-panel { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 12px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
.view-switcher { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; }
.view-switcher__item { border: 0; border-bottom: 2px solid transparent; background: transparent; color: #64748b; padding: 8px 14px; cursor: pointer; font-size: 13px; }
.view-switcher__item.is-active { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
.toolbar, .report-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; flex-shrink: 0; }
.toolbar .el-input { width: 260px; }
.toolbar .el-date-editor { width: 280px; }
.report-toolbar .el-date-editor { width: 180px; }
.report-owner-input { width: 180px; }
.customers-table { flex: 1; min-height: 0; }
.customers-table :deep(.el-table__header-wrapper th.el-table__cell), .report-details :deep(.el-table__header-wrapper th.el-table__cell) { background: #eef3f8 !important; color: #334155; font-weight: 700; border-color: #d7dee8; }
.operation-actions { display: inline-flex; align-items: center; justify-content: center; gap: 10px; white-space: nowrap; }
.operation-actions :deep(.el-button) { margin-left: 0; padding: 0; }
.pagination-bar { display: flex; justify-content: flex-end; flex-shrink: 0; padding-top: 10px; }
.form-date { width: 100%; }
.muted { color: #94a3b8; }
.report-body { flex: 1; min-height: 0; overflow: auto; padding-right: 2px; }
.report-summary, .report-distribution, .report-details { border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; padding: 16px; margin-bottom: 12px; }
.report-summary__heading, .report-details__header, .report-distribution__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.report-summary__heading h2 { margin: 0; font-size: 17px; color: #1e293b; }
.report-summary__heading p { margin: 6px 0 0; color: #64748b; font-size: 13px; }
.report-kpis { display: grid; grid-template-columns: repeat(6, minmax(100px, 1fr)); gap: 8px; margin-top: 16px; }
.report-kpi { padding: 12px; background: #f8fafc; border-radius: 6px; }
.report-kpi__label { display: block; color: #64748b; font-size: 12px; margin-bottom: 6px; }
.report-kpi__value { font-size: 22px; line-height: 1; }
.report-kpi__value--primary { color: #2563eb; }.report-kpi__value--info { color: #0ea5e9; }.report-kpi__value--warning { color: #d97706; }.report-kpi__value--success { color: #059669; }.report-kpi__value--danger { color: #dc2626; }
.report-distribution__header, .report-details__header { color: #334155; font-size: 13px; font-weight: 600; }
.stage-row { display: grid; grid-template-columns: 90px minmax(120px, 1fr) 48px; align-items: center; gap: 10px; margin-top: 14px; font-size: 12px; color: #475569; }
.stage-row strong { text-align: right; color: #334155; }
.report-details__header { margin-bottom: 12px; }
.customer-link { border: 0; padding: 0; background: none; color: #2563eb; cursor: pointer; font: inherit; text-align: left; }
@media (max-width: 900px) { .report-kpis { grid-template-columns: repeat(3, minmax(100px, 1fr)); } }
@media (max-width: 760px) { .customers-view { padding: 12px; overflow: auto; }.customers-view__header { align-items: flex-start; flex-direction: column; }.customers-panel { min-height: 600px; }.toolbar, .report-toolbar { align-items: stretch; }.toolbar .el-input, .toolbar .el-date-editor, .toolbar .el-button, .report-toolbar .el-date-editor, .report-owner-input { width: 100%; }.report-kpis { grid-template-columns: repeat(2, minmax(100px, 1fr)); } }
:global(.customer-dialog) { max-width: calc(100vw - 32px); }
</style>
