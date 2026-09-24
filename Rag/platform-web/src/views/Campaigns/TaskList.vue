<template>
  <div class="campaign-list">
    <div class="campaign-list__toolbar">
      <div class="campaign-list__filters">
        <el-input
          v-model="filters.keyword"
          clearable
          placeholder="搜索任务名"
          style="width: 220px"
          @keyup.enter="loadTasks"
        />
        <el-select
          v-model="filters.status"
          clearable
          placeholder="状态"
          style="width: 140px"
          @change="loadTasks"
        >
          <el-option label="运行中" value="running" />
          <el-option label="已暂停" value="paused" />
          <el-option label="已完成" value="completed" />
          <el-option label="已终止" value="terminated" />
        </el-select>
        <el-select
          v-model="filters.type"
          clearable
          placeholder="类型"
          style="width: 150px"
          @change="loadTasks"
        >
          <el-option label="批量私信" value="dm" />
          <el-option label="评论回复" value="comment" />
          <el-option label="关键词触达" value="keyword" />
        </el-select>
        <el-button @click="loadTasks">查询</el-button>
      </div>
      <div class="campaign-list__actions">
        <el-button :icon="Refresh" @click="loadTasks">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="goCreate">新建任务</el-button>
      </div>
    </div>

    <el-table
      v-loading="loading"
      :data="visibleTasks"
      border
      stripe
      class="campaign-list__table"
      empty-text="暂无营销任务"
    >
      <el-table-column label="任务" min-width="240">
        <template #default="{ row }">
          <div class="campaign-list__task-name">{{ row.name }}</div>
          <div class="campaign-list__task-meta">
            {{ row.typeLabel }} · 创建时间 {{ row.createdAt || '-' }}
          </div>
        </template>
      </el-table-column>

      <el-table-column label="渠道" min-width="180">
        <template #default="{ row }">
          <el-tag
            v-for="channel in row.targetChannels"
            :key="`${row.id}-${channel}`"
            size="small"
            effect="plain"
            class="campaign-list__tag"
          >
            {{ channel }}
          </el-tag>
          <span v-if="!row.targetChannels.length">-</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" effect="dark">
            {{ row.statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="执行进度" min-width="220">
        <template #default="{ row }">
          <el-progress :percentage="progress(row)" :stroke-width="8" />
          <div class="campaign-list__task-meta">
            {{ row.successCount }} 成功 / {{ row.failedCount }} 失败 / {{ row.pendingCount }} 待发
          </div>
        </template>
      </el-table-column>

      <el-table-column label="总量" width="90" align="right">
        <template #default="{ row }">
          {{ row.totalCount }}
        </template>
      </el-table-column>

      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button text type="primary" size="small" :icon="View" @click="showTask(row)">
            详情
          </el-button>
          <el-button
            v-if="row.status === 'running'"
            text
            type="warning"
            size="small"
            :icon="VideoPause"
            @click="changeStatus(row, 'paused')"
          >
            暂停
          </el-button>
          <el-button
            v-if="row.status === 'paused'"
            text
            type="success"
            size="small"
            :icon="VideoPlay"
            @click="changeStatus(row, 'running')"
          >
            继续
          </el-button>
          <el-button
            v-if="['running', 'paused'].includes(row.status)"
            text
            type="danger"
            size="small"
            :icon="CircleClose"
            @click="changeStatus(row, 'terminated')"
          >
            终止
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty
      v-if="!loading && visibleTasks.length === 0"
      description="还没有营销任务"
      class="campaign-list__empty"
    >
      <el-button type="primary" :icon="Plus" @click="goCreate">新建任务</el-button>
    </el-empty>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleClose,
  Plus,
  Refresh,
  VideoPause,
  VideoPlay,
  View
} from '@element-plus/icons-vue'
import { getTasks, updateTask } from '@/api/campaigns'

const router = useRouter()
const loading = ref(false)
const tasks = ref([])
const filters = reactive({
  keyword: '',
  status: '',
  type: ''
})

const visibleTasks = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase()
  if (!keyword) return tasks.value
  return tasks.value.filter(task => {
    return [task.name, task.typeLabel, task.statusLabel, task.targetChannels.join(',')]
      .some(value => String(value || '').toLowerCase().includes(keyword))
  })
})

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(item => String(item))
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(item => String(item))
  } catch {
    // Fall through to comma splitting.
  }
  return String(value).split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
}

function numberValue(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function typeLabel(type) {
  return {
    dm: '批量私信',
    comment: '评论回复',
    keyword: '关键词触达'
  }[type] || type || '-'
}

function statusLabel(status) {
  return {
    draft: '草稿',
    running: '运行中',
    paused: '已暂停',
    completed: '已完成',
    terminated: '已终止'
  }[status] || status || '-'
}

function statusTagType(status) {
  return {
    running: 'success',
    paused: 'warning',
    completed: 'info',
    terminated: 'danger'
  }[status] || 'info'
}

function normalizeTask(row = {}) {
  const totalCount = numberValue(row.totalCount ?? row.total_count)
  const successCount = numberValue(row.successCount ?? row.success_count)
  const failedCount = numberValue(row.failedCount ?? row.failed_count ?? row.failCount)
  const pendingCount = numberValue(row.pendingCount ?? row.pending_count) ||
    Math.max(totalCount - successCount - failedCount, 0)
  const status = row.status || 'draft'
  const type = row.type || 'dm'

  return {
    id: row.id,
    name: row.name || '未命名任务',
    type,
    typeLabel: typeLabel(type),
    status,
    statusLabel: statusLabel(status),
    targetChannels: toList(row.targetChannels ?? row.target_channels),
    totalCount,
    successCount,
    failedCount,
    pendingCount,
    createdAt: row.createdAt || row.created_at || ''
  }
}

function progress(task) {
  if (!task.totalCount) return 0
  return Math.min(100, Math.round(((task.successCount + task.failedCount) / task.totalCount) * 100))
}

async function loadTasks() {
  loading.value = true
  try {
    const response = await getTasks({
      page: 1,
      pageSize: 100,
      status: filters.status || undefined,
      type: filters.type || undefined
    })
    const payload = response?.data || {}
    const list = Array.isArray(payload.list) ? payload.list : []
    tasks.value = list.map(normalizeTask)
  } catch (error) {
    ElMessage.error(error.message || '加载营销任务失败')
  } finally {
    loading.value = false
  }
}

function goCreate() {
  router.push('/campaigns/create')
}

function showTask(task) {
  ElMessage.info(`任务 ${task.id}：${task.successCount} 成功，${task.failedCount} 失败，${task.pendingCount} 待发`)
}

async function changeStatus(task, nextStatus) {
  const confirmText = nextStatus === 'terminated'
    ? `确认终止任务「${task.name}」吗？未发送的投放会被取消。`
    : nextStatus === 'paused'
      ? `确认暂停任务「${task.name}」吗？`
      : ''

  try {
    if (confirmText) {
      await ElMessageBox.confirm(confirmText, '确认操作', { type: nextStatus === 'terminated' ? 'error' : 'warning' })
    }
    await updateTask(task.id, { status: nextStatus })
    ElMessage.success('任务状态已更新')
    await loadTasks()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error.message || '更新任务状态失败')
  }
}

onMounted(loadTasks)
</script>

<style scoped>
.campaign-list {
  padding: 20px;
}

.campaign-list__toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.campaign-list__filters,
.campaign-list__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.campaign-list__table {
  width: 100%;
}

.campaign-list__task-name {
  font-weight: 600;
  color: #1f2937;
}

.campaign-list__task-meta {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.campaign-list__tag {
  margin: 0 6px 6px 0;
}

.campaign-list__empty {
  margin-top: 32px;
}
</style>
