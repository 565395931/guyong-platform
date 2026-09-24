<template>
  <div class="video-data-manage-view">
    <header class="page-heading">
      <div>
        <span class="page-kicker">ACCOUNT DATA</span>
        <h1>视频数据管理</h1>
        <p>按账号、平台和日期沉淀视频运营数据，支持统计、导出和复盘。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增记录</el-button>
    </header>

    <section class="account-toolbar" aria-label="视频数据筛选">
      <el-input
        v-model="filters.keyword"
        class="keyword-input"
        clearable
        :prefix-icon="Search"
        placeholder="搜索账号、平台、备注"
        @keyup.enter="loadRecords"
        @clear="loadRecords"
      />

      <el-button :icon="Download" :loading="exporting" @click="handleExport">
        导出数据
      </el-button>

      <el-date-picker
        v-model="dateRange"
        type="daterange"
        unlink-panels
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        format="YYYY/MM/DD"
        class="date-range-picker"
        @change="loadRecords"
      />

      <el-button type="success" :icon="DataAnalysis" :loading="summaryLoading" @click="calculateSummary">
        计算合计
      </el-button>

      <div class="summary-text">{{ summaryText }}</div>
    </section>

    <main class="table-shell">
      <el-table
        v-loading="loading"
        :data="records"
        row-key="id"
        stripe
        border
        empty-text="暂无视频数据"
        class="data-table"
      >
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="dataDate" label="日期" width="120">
          <template #default="{ row }">
            {{ formatDisplayDate(row.dataDate) }}
          </template>
        </el-table-column>
        <el-table-column prop="accountNo" label="账号" min-width="150" />
        <el-table-column prop="platformLabel" label="平台" width="120">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" effect="light" size="small">
              {{ platformLabel(row.platform) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="playCount" label="播放量" width="110" align="right" />
        <el-table-column prop="likeCount" label="点赞量" width="100" align="right" />
        <el-table-column prop="commentCount" label="评论" width="90" align="right" />
        <el-table-column prop="inquiryCount" label="有效询盘" width="110" align="right" />
        <el-table-column prop="intentCustomerCount" label="意向客户数" width="120" align="right" />
        <el-table-column prop="dealCount" label="成交数" width="100" align="right" />
        <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" :icon="Delete" @click="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </main>

    <footer class="page-footer">
      <el-pagination
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="handlePageSizeChange"
        @current-change="handlePageChange"
      />
    </footer>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑视频数据' : '新增视频数据'"
      width="760px"
      destroy-on-close
      @closed="resetForm"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        status-icon
      >
        <div class="form-grid form-grid--top">
          <el-form-item label="日期" prop="dataDate">
            <el-date-picker
              v-model="form.dataDate"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY/MM/DD"
              placeholder="请选择日期"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="账号" prop="accountNo">
            <el-input v-model="form.accountNo" maxlength="100" placeholder="例如：15295155085" />
          </el-form-item>
          <el-form-item label="平台" prop="platform">
            <el-select v-model="form.platform" class="full-width" placeholder="请选择平台">
              <el-option
                v-for="item in platformOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
        </div>

        <div class="metrics-grid">
          <el-form-item label="播放量" prop="playCount">
            <el-input-number v-model="form.playCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="点赞量" prop="likeCount">
            <el-input-number v-model="form.likeCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="评论" prop="commentCount">
            <el-input-number v-model="form.commentCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="有效询盘" prop="inquiryCount">
            <el-input-number v-model="form.inquiryCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="意向客户数" prop="intentCustomerCount">
            <el-input-number v-model="form.intentCustomerCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="成交数" prop="dealCount">
            <el-input-number v-model="form.dealCount" :min="0" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
        </div>

        <el-form-item label="备注">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="可填写内容复盘、投放说明或异常备注"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { DataAnalysis, Delete, Download, Edit, Plus, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createVideoDataRecord,
  deleteVideoDataRecord,
  exportVideoData,
  getVideoDataRecords,
  getVideoDataSummary,
  updateVideoDataRecord
} from '@/api/videoData'

const platformOptions = [
  { value: 'douyin', label: '抖音' },
  { value: 'kuaishou', label: '快手' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'wechat_channel', label: '视频号' },
  { value: 'taobao', label: '淘宝' },
  { value: 'pinduoduo', label: '拼多多' },
  { value: 'alibaba1688', label: '1688' },
  { value: 'other', label: '其他' }
]

const platformLabelMap = Object.fromEntries(platformOptions.map(item => [item.value, item.label]))
const platformTagMap = {
  douyin: 'danger',
  kuaishou: 'warning',
  xiaohongshu: 'danger',
  wechat_channel: 'success',
  taobao: 'primary',
  pinduoduo: 'warning',
  alibaba1688: 'success',
  other: 'info'
}

const today = formatDateValue(new Date())
const filters = reactive({
  keyword: ''
})
const dateRange = ref([today, today])
const records = ref([])
const total = ref(0)
const summary = reactive(emptySummary())
const loading = ref(false)
const summaryLoading = ref(false)
const exporting = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editingId = ref(null)
const formRef = ref(null)
const pagination = reactive({
  page: 1,
  pageSize: 10
})
const form = reactive(blankForm())

const rules = {
  dataDate: [{ required: true, message: '请选择日期', trigger: 'change' }],
  accountNo: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  platform: [{ required: true, message: '请选择平台', trigger: 'change' }],
  playCount: [{ required: true, message: '请输入播放量', trigger: 'change' }]
}

const summaryText = computed(() => (
  `${summary.totalRecords}条 | 播放${formatNumber(summary.playCount)} 点赞${formatNumber(summary.likeCount)} 评论${formatNumber(summary.commentCount)} 询盘${formatNumber(summary.inquiryCount)} 意向${formatNumber(summary.intentCustomerCount)} 成交${formatNumber(summary.dealCount)}`
))

function blankForm() {
  return {
    dataDate: today,
    accountNo: '',
    platform: 'douyin',
    playCount: 0,
    likeCount: 0,
    commentCount: 0,
    inquiryCount: 0,
    intentCustomerCount: 0,
    dealCount: 0,
    remark: ''
  }
}

function emptySummary() {
  return {
    totalRecords: 0,
    playCount: 0,
    likeCount: 0,
    commentCount: 0,
    inquiryCount: 0,
    intentCustomerCount: 0,
    dealCount: 0
  }
}

function formatDateValue(date) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function formatDisplayDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}

function platformLabel(platform) {
  return platformLabelMap[platform] || platform || '-'
}

function platformTagType(platform) {
  return platformTagMap[platform] || 'info'
}

function resetForm() {
  Object.assign(form, blankForm())
  editingId.value = null
  formRef.value?.clearValidate()
}

function openCreate() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, {
    dataDate: row.dataDate,
    accountNo: row.accountNo,
    platform: row.platform,
    playCount: row.playCount,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    inquiryCount: row.inquiryCount,
    intentCustomerCount: row.intentCustomerCount,
    dealCount: row.dealCount,
    remark: row.remark || ''
  })
  dialogVisible.value = true
}

function buildQueryParams() {
  const params = {
    page: pagination.page,
    pageSize: pagination.pageSize
  }
  if (filters.keyword) params.keyword = filters.keyword.trim()
  if (Array.isArray(dateRange.value) && dateRange.value.length === 2) {
    params.startDate = dateRange.value[0]
    params.endDate = dateRange.value[1]
  }
  return params
}

async function loadRecords() {
  loading.value = true
  try {
    const response = await getVideoDataRecords(buildQueryParams())
    records.value = response.data?.list || []
    total.value = Number(response.data?.total || 0)
    Object.assign(summary, response.data?.summary || emptySummary())
  } catch (error) {
    ElMessage.error(error.message || '加载视频数据失败')
  } finally {
    loading.value = false
  }
}

async function calculateSummary() {
  summaryLoading.value = true
  try {
    const response = await getVideoDataSummary(buildQueryParams())
    Object.assign(summary, response.data || emptySummary())
  } catch (error) {
    ElMessage.error(error.message || '计算合计失败')
  } finally {
    summaryLoading.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await exportVideoData(buildQueryParams())
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    const start = dateRange.value?.[0] || 'all'
    const end = dateRange.value?.[1] || 'all'
    link.href = url
    link.download = `video-data-${start}-${end}.csv`
    link.click()
    window.URL.revokeObjectURL(url)
    ElMessage.success('已开始导出')
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

async function submit() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }

  saving.value = true
  const payload = {
    dataDate: form.dataDate,
    accountNo: form.accountNo.trim(),
    platform: form.platform,
    playCount: Number(form.playCount),
    likeCount: Number(form.likeCount),
    commentCount: Number(form.commentCount),
    inquiryCount: Number(form.inquiryCount),
    intentCustomerCount: Number(form.intentCustomerCount),
    dealCount: Number(form.dealCount),
    remark: form.remark.trim()
  }

  try {
    if (editingId.value) {
      await updateVideoDataRecord(editingId.value, payload)
      ElMessage.success('视频数据已更新')
    } else {
      await createVideoDataRecord(payload)
      ElMessage.success('视频数据已创建')
    }
    dialogVisible.value = false
    await loadRecords()
    await calculateSummary()
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(`确定删除账号“${row.accountNo}”的这条视频数据吗？`, '删除视频数据', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }

  try {
    await deleteVideoDataRecord(row.id)
    ElMessage.success('视频数据已删除')
    await loadRecords()
    await calculateSummary()
  } catch (error) {
    ElMessage.error(error.message || '删除失败')
  }
}

function handlePageChange(page) {
  pagination.page = page
  loadRecords()
}

function handlePageSizeChange(pageSize) {
  pagination.pageSize = pageSize
  pagination.page = 1
  loadRecords()
}

onMounted(loadRecords)
</script>

<style scoped lang="scss">
.video-data-manage-view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100%;
  padding: 20px;
  background: #f4f7f2;
  color: #27332b;
}

.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 20px 22px 18px;
  margin-bottom: 14px;
  border: 1px solid #d8e3d8;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(34, 55, 40, 0.05);
}

.page-heading h1 {
  margin: 3px 0 4px;
  font-size: 24px;
  color: #1f2a22;
}

.page-heading p {
  margin: 0;
  color: #6b766f;
  font-size: 13px;
}

.page-kicker {
  color: #5d725f;
  font-family: Consolas, monospace;
  font-size: 10px;
  letter-spacing: 1.5px;
}

.account-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 14px;
  border: 1px solid #dce8db;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(34, 55, 40, 0.04);
}

.keyword-input {
  width: min(300px, 32vw);
}

.date-range-picker {
  width: 250px;
}

.summary-text {
  margin-left: auto;
  color: #2f4e35;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.table-shell {
  flex: 1;
  min-height: 340px;
  overflow: hidden;
  border: 1px solid #d7e4d8;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(34, 55, 40, 0.04);
}

.data-table {
  width: 100%;
}

.data-table :deep(.el-table__header-wrapper th.el-table__cell) {
  background: linear-gradient(180deg, #2f6f46 0%, #2c6541 100%);
  color: #fff;
  border-bottom: 0;
}

.data-table :deep(.el-table__header-wrapper th.el-table__cell .cell) {
  color: #fff;
  font-weight: 600;
}

.data-table :deep(.el-table__body td.el-table__cell) {
  border-bottom: 1px solid #edf2ea;
}

.data-table :deep(.el-table__body tr:hover > td.el-table__cell) {
  background: #f7fbf5;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page-footer {
  display: flex;
  justify-content: flex-end;
  padding: 14px 4px 0;
}

.form-grid--top {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.full-width {
  width: 100%;
}

@media (max-width: 1200px) {
  .account-toolbar {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .keyword-input,
  .date-range-picker {
    width: 100%;
  }

  .summary-text {
    margin-left: 0;
  }
}

@media (max-width: 900px) {
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .form-grid--top,
  .metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .video-data-manage-view {
    padding: 12px;
  }

  .form-grid--top,
  .metrics-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
