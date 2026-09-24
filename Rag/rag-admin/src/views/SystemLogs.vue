<template>
  <div class="system-logs">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>系统日志</span>
          <div class="header-actions">
            <el-button size="small" @click="loadFiles">刷新文件</el-button>
            <el-button type="primary" size="small" :loading="loading" @click="loadLogs">查询</el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" :model="filters" class="filter-form">
        <el-form-item label="日期">
          <el-select v-model="filters.date" placeholder="选择日志日期" style="width: 180px;" @change="loadLogs">
            <el-option
              v-for="file in logFiles"
              :key="file.date"
              :label="`${file.date} (${formatBytes(file.size)})`"
              :value="file.date"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="级别">
          <el-select v-model="filters.level" clearable placeholder="全部" style="width: 110px;">
            <el-option label="INFO" value="INFO" />
            <el-option label="WARN" value="WARN" />
            <el-option label="ERROR" value="ERROR" />
            <el-option label="RAW" value="RAW" />
          </el-select>
        </el-form-item>

        <el-form-item label="事件">
          <el-input
            v-model="filters.event"
            clearable
            placeholder="如 webhook / message"
            style="width: 220px;"
            @keyup.enter="loadLogs"
          />
        </el-form-item>

        <el-form-item label="关键字">
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="会话ID / accountId / 错误"
            style="width: 260px;"
            @keyup.enter="loadLogs"
          />
        </el-form-item>

        <el-form-item label="行数">
          <el-select v-model="filters.limit" style="width: 100px;">
            <el-option :value="100" label="100" />
            <el-option :value="200" label="200" />
            <el-option :value="500" label="500" />
            <el-option :value="1000" label="1000" />
          </el-select>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" @click="loadLogs">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="logMeta.truncated"
        type="warning"
        :closable="false"
        show-icon
        class="log-alert"
        title="日志文件较大，本页只读取文件末尾约 5MB。请缩小日期或关键字继续排查。"
      />
    </el-card>

    <el-card class="table-card">
      <template #header>
        <div class="card-header">
          <span>日志明细</span>
          <span class="meta-text">
            {{ logMeta.date || '-' }} · {{ formatBytes(logMeta.fileSize || 0) }} · {{ logList.length }} 条
          </span>
        </div>
      </template>

      <el-table
        :data="logList"
        v-loading="loading"
        border
        stripe
        style="width: 100%;"
        row-key="_rowKey"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="json-view">{{ formatJson(row) }}</pre>
          </template>
        </el-table-column>

        <el-table-column label="时间" width="190">
          <template #default="{ row }">
            <div>{{ row.localTs || formatTime(row.ts) || '-' }}</div>
            <div class="sub-text">{{ row.ts || '' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="级别" width="90">
          <template #default="{ row }">
            <el-tag :type="levelType(row.level)" size="small">{{ row.level || '-' }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="event" label="事件" width="220" show-overflow-tooltip />
        <el-table-column prop="pid" label="PID" width="90" />

        <el-table-column label="摘要" min-width="360">
          <template #default="{ row }">
            <span class="summary">{{ summarize(row) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/admin'

const loading = ref(false)
const logFiles = ref([])
const logList = ref([])
const logMeta = reactive({
  date: '',
  fileSize: 0,
  truncated: false
})

const filters = reactive({
  date: '',
  level: '',
  event: '',
  keyword: '',
  limit: 200
})

const today = () => {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const loadFiles = async () => {
  try {
    const res = await adminApi.getSystemLogFiles()
    logFiles.value = res.data.data || []
    if (!filters.date) {
      filters.date = logFiles.value[0]?.date || today()
    }
  } catch (err) {
    console.error('[SystemLogs] 加载日志文件失败:', err)
    ElMessage.error('加载日志文件失败')
  }
}

const loadLogs = async () => {
  loading.value = true
  try {
    const params = {
      date: filters.date || today(),
      limit: filters.limit
    }
    if (filters.level) params.level = filters.level
    if (filters.event) params.event = filters.event
    if (filters.keyword) params.keyword = filters.keyword

    const res = await adminApi.getSystemLogs(params)
    const data = res.data.data || {}
    logMeta.date = data.date
    logMeta.fileSize = data.fileSize || 0
    logMeta.truncated = Boolean(data.truncated)
    logList.value = (data.list || []).map((item, index) => ({
      ...item,
      _rowKey: `${item.ts || 'raw'}-${item.event || 'event'}-${index}`
    }))
  } catch (err) {
    console.error('[SystemLogs] 查询系统日志失败:', err)
    ElMessage.error(err.response?.data?.message || '查询系统日志失败')
  } finally {
    loading.value = false
  }
}

const resetFilters = () => {
  filters.level = ''
  filters.event = ''
  filters.keyword = ''
  filters.limit = 200
  loadLogs()
}

const levelType = (level) => {
  if (level === 'ERROR') return 'danger'
  if (level === 'WARN') return 'warning'
  if (level === 'INFO') return 'success'
  return 'info'
}

const formatTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const formatBytes = (value) => {
  const size = Number(value) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const formatJson = (row) => JSON.stringify(row, null, 2)

const summarize = (row) => {
  const data = row.data || {}
  if (data.error?.message) return data.error.message
  if (data.errorMessage) return data.errorMessage
  if (data.reason) return data.reason
  if (data.conversationId) return `conversationId=${data.conversationId}`
  if (data.channelMessageId) return `channelMessageId=${data.channelMessageId}`
  return JSON.stringify(data)
}

onMounted(async () => {
  await loadFiles()
  await loadLogs()
})
</script>

<style scoped>
.system-logs {
  padding: 0;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
}

.log-alert {
  margin-top: 12px;
}

.table-card {
  margin-top: 16px;
}

.meta-text,
.sub-text {
  color: #909399;
  font-size: 12px;
}

.json-view {
  margin: 0;
  max-height: 420px;
  overflow: auto;
  padding: 12px;
  background: #0f172a;
  color: #e5e7eb;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}

.summary {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: #303133;
  word-break: break-all;
}
</style>
