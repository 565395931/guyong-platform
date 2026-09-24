<template>
  <div class="pool-logs">
    <!-- 筛选区域 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>池状态流转日志</span>
          <div>
            <el-button-group size="small" style="margin-right: 8px;">
              <el-button @click="quickFilter('today')">今日</el-button>
              <el-button @click="quickFilter('3d')">近3天</el-button>
              <el-button @click="quickFilter('7d')">近7天</el-button>
              <el-button @click="quickFilter('all')">全部</el-button>
            </el-button-group>
            <el-button type="primary" size="small" @click="loadLogs" :loading="loading">刷新</el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" :model="filters" class="filter-form">
        <el-form-item label="会话ID">
          <el-input
            v-model="filters.conversationId"
            placeholder="输入会话 UUID"
            clearable
            style="width: 280px;"
            @keyup.enter="handleSearch"
          />
        </el-form-item>

        <el-form-item label="操作类型">
          <el-select
            v-model="filters.actions"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="全部操作"
            clearable
            style="width: 240px;"
          >
            <el-option-group
              v-for="group in actionGroups"
              :key="group.label"
              :label="group.label"
            >
              <el-option
                v-for="item in group.options"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-option-group>
          </el-select>
        </el-form-item>

        <el-form-item label="源池">
          <el-select v-model="filters.fromPool" placeholder="全部" clearable style="width: 130px;">
            <el-option v-for="(label, value) in poolLabels" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>

        <el-form-item label="目标池">
          <el-select v-model="filters.toPool" placeholder="全部" clearable style="width: 130px;">
            <el-option v-for="(label, value) in poolLabels" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>

        <el-form-item label="操作者类型">
          <el-select v-model="filters.operatorType" placeholder="全部" clearable style="width: 120px;">
            <el-option label="系统" value="system" />
            <el-option label="坐席" value="agent" />
            <el-option label="AI" value="ai" />
          </el-select>
        </el-form-item>

        <el-form-item label="时间范围">
          <el-date-picker
            v-model="filters.dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 340px;"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 日志表格 -->
    <el-card style="margin-top: 16px;">
      <el-table
        :data="logList"
        v-loading="loading"
        border
        stripe
        style="width: 100%;"
        :default-sort="{ prop: 'created_at', order: 'descending' }"
      >
        <el-table-column prop="created_at" label="时间" width="165" sortable>
          <template #default="{ row }">
            {{ formatTime(row.created_at) }}
          </template>
        </el-table-column>

        <el-table-column prop="action" label="操作" width="130">
          <template #default="{ row }">
            <el-tag :type="getActionTagType(row.action)" size="small">
              {{ actionOptions[row.action] || row.action }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="流转路径" width="190">
          <template #default="{ row }">
            <div class="flow-path">
              <span class="pool-tag" :class="getPoolClass(row.from_pool)">{{ poolLabels[row.from_pool] || row.from_pool || '-' }}</span>
              <el-icon class="flow-arrow"><Right /></el-icon>
              <span class="pool-tag" :class="getPoolClass(row.to_pool)">{{ poolLabels[row.to_pool] || row.to_pool || '归档' }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作者" width="160">
          <template #default="{ row }">
            <div class="operator-info">
              <el-tag :type="getOperatorTagType(row.operator_type)" size="small" effect="plain">
                {{ operatorTypeLabels[row.operator_type] || row.operator_type || 'system' }}
              </el-tag>
              <span v-if="row.operator_name" class="operator-name">{{ row.operator_name }}</span>
              <span v-if="row.operator_id" class="operator-id">#{{ row.operator_id }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="会话ID" width="120">
          <template #default="{ row }">
            <div class="conv-id-cell">
              <span class="conv-id-text" @click="copyText(row.conversation_id)">{{ truncateId(row.conversation_id) }}</span>
              <el-icon class="copy-icon" @click="copyText(row.conversation_id)"><CopyDocument /></el-icon>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="reason-text">{{ row.reason || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-wrapper">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Right, CopyDocument } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

// ========== 筛选条件 ==========
const filters = reactive({
  conversationId: '',
  actions: [],
  fromPool: '',
  toPool: '',
  operatorType: '',
  dateRange: null
})

// 操作类型分组
const actionGroups = [
  {
    label: '坐席操作',
    options: [
      { value: 'claim', label: '抢单认领' },
      { value: 'release', label: '释放' },
      { value: 'transfer', label: '转交' },
      { value: 'mark_long_term', label: '标记长期' },
      { value: 'archive', label: '归档' },
    ]
  },
  {
    label: '系统自动',
    options: [
      { value: 'ai_to_human', label: 'AI转人工' },
      { value: 'timeout_transfer', label: '超时转池' },
      { value: 'aging_transfer', label: '超龄转池' },
      { value: 'auto_archive', label: '自动归档' },
      { value: 'seat_offline_release', label: '坐席离线释放' },
      { value: 'private_stale_release', label: '私有池超时释放' },
    ]
  },
  {
    label: '其他',
    options: [
      { value: 'pool_change', label: '池切换' },
      { value: 'revive', label: '复活归档会话' },
    ]
  }
]

// 操作类型扁平映射
const actionOptions = Object.assign({}, ...actionGroups.map(g => Object.fromEntries(g.options.map(o => [o.value, o.label]))))

// 池类型中文标签
const poolLabels = {
  ai_self: 'AI自助池',
  pending_human: '待人工池',
  public: '公共池',
  private: '私有池',
  long_term: '长期跟进池'
}

// 操作者类型标签
const operatorTypeLabels = {
  system: '系统',
  agent: '坐席',
  ai: 'AI'
}

// ========== 数据 ==========
const loading = ref(false)
const logList = ref([])
const pagination = reactive({
  page: 1,
  pageSize: 50,
  total: 0
})

// ========== 加载数据 ==========
const loadLogs = async () => {
  loading.value = true
  try {
    const params = {
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize
    }

    if (filters.conversationId) params.conversationId = filters.conversationId
    if (filters.actions.length > 0) params.actions = filters.actions.join(',')
    if (filters.fromPool) params.fromPool = filters.fromPool
    if (filters.toPool) params.toPool = filters.toPool
    if (filters.operatorType) params.operatorType = filters.operatorType
    if (filters.dateRange && filters.dateRange.length === 2) {
      params.startDate = filters.dateRange[0]
      params.endDate = filters.dateRange[1]
    }

    const res = await adminApi.getPoolLogs(params)
    const data = res.data?.data || { list: [], total: 0 }
    logList.value = data.list || []
    pagination.total = data.total || 0
  } catch (err) {
    console.error('[PoolLogs] 加载日志失败:', err)
    ElMessage.error('加载日志失败: ' + (err.response?.data?.message || err.message))
  } finally {
    loading.value = false
  }
}

// ========== 快捷时间筛选 ==========
const quickFilter = (type) => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  if (type === 'all') {
    filters.dateRange = null
  } else {
    const start = new Date()
    if (type === 'today') start.setHours(0, 0, 0, 0)
    else if (type === '3d') start.setDate(start.getDate() - 3)
    else if (type === '7d') start.setDate(start.getDate() - 7)
    filters.dateRange = [fmt(start), fmt(now)]
  }
  pagination.page = 1
  loadLogs()
}

// ========== 筛选操作 ==========
const handleSearch = () => {
  pagination.page = 1
  loadLogs()
}

const handleReset = () => {
  filters.conversationId = ''
  filters.actions = []
  filters.fromPool = ''
  filters.toPool = ''
  filters.operatorType = ''
  filters.dateRange = null
  pagination.page = 1
  loadLogs()
}

const handleSizeChange = (size) => {
  pagination.pageSize = size
  pagination.page = 1
  loadLogs()
}

const handlePageChange = (page) => {
  pagination.page = page
  loadLogs()
}

// ========== 工具函数 ==========
const formatTime = (time) => {
  if (!time) return '-'
  const d = new Date(time)
  if (isNaN(d.getTime())) return time
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const truncateId = (id) => {
  if (!id) return '-'
  return id.length > 12 ? id.substring(0, 8) + '..' : id
}

const copyText = (text) => {
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success('已复制: ' + text.substring(0, 16) + '...')
  }).catch(() => {})
}

const getActionTagType = (action) => {
  const typeMap = {
    claim: 'success',
    release: 'warning',
    mark_long_term: 'info',
    archive: 'danger',
    transfer: 'primary',
    ai_to_human: 'warning',
    seat_offline_release: 'warning',
    private_stale_release: 'warning',
    timeout_transfer: 'warning',
    aging_transfer: 'warning',
    auto_archive: 'danger',
    pool_change: '',
    revive: 'success'
  }
  return typeMap[action] || ''
}

const getPoolClass = (pool) => {
  if (!pool) return 'pool-tag--archive'
  return `pool-tag--${pool}`
}

const getOperatorTagType = (type) => {
  const typeMap = { system: 'info', agent: '', ai: 'success' }
  return typeMap[type] || 'info'
}

onMounted(() => {
  quickFilter('today')
})
</script>

<style scoped lang="scss">
.pool-logs {
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .filter-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0;

    .el-form-item {
      margin-bottom: 12px;
    }
  }

  .flow-path {
    display: flex;
    align-items: center;
    gap: 6px;

    .flow-arrow {
      font-size: 14px;
      color: #909399;
    }
  }

  .pool-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;

    &--ai_self { background: #e8f4fd; color: #409eff; }
    &--pending_human { background: #fdf6ec; color: #e6a23c; }
    &--public { background: #f0f9eb; color: #67c23a; }
    &--private { background: #ecf5ff; color: #3b82f6; }
    &--long_term { background: #f4f4f5; color: #909399; }
    &--archive { background: #fef0f0; color: #f56c6c; }
  }

  .operator-info {
    display: flex;
    align-items: center;
    gap: 6px;

    .operator-name { font-size: 13px; color: #303133; }
    .operator-id { font-size: 12px; color: #909399; }
  }

  .conv-id-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;

    .conv-id-text {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      color: #409eff;

      &:hover { text-decoration: underline; }
    }

    .copy-icon {
      font-size: 13px;
      color: #c0c4cc;

      &:hover { color: #409eff; }
    }
  }

  .reason-text { font-size: 13px; color: #606266; }

  .pagination-wrapper {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
}
</style>
