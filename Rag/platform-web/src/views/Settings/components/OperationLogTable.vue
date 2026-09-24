<template>
  <section class="operation-section">
    <div class="section-heading">
      <div><h2>操作日志</h2><p>企业连接、账号策略、白名单和网关运行状态变更。</p></div>
      <div class="filters">
        <el-select v-model="filters.connectionId" clearable placeholder="全部企业" @change="submit">
          <el-option v-for="item in connections" :key="item.id" :label="item.connectionName" :value="item.id" />
        </el-select>
        <el-select v-model="filters.action" clearable placeholder="全部操作" @change="submit">
          <el-option v-for="item in actions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button :icon="Refresh" :loading="loading" @click="submit">刷新</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无操作记录">
      <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作人" width="120"><template #default="{ row }">{{ row.operatorName || `用户 #${row.operatorId || '-'}` }}</template></el-table-column>
      <el-table-column label="对象" min-width="180">
        <template #default="{ row }">
          <strong>{{ row.accountName || row.connectionName || '-' }}</strong>
          <small v-if="row.accountName && row.connectionName">{{ row.connectionName }}</small>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150"><template #default="{ row }"><el-tag effect="plain">{{ actionText(row.action) }}</el-tag></template></el-table-column>
      <el-table-column label="变更摘要" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">{{ changeText(row) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="total > pageSize"
      class="pagination"
      background
      layout="prev, pager, next, total"
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      @current-change="changePage"
    />
  </section>
</template>

<script setup>
import { reactive } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { normalizeOperationLogFilters } from '@/modules/platformConnections/connectionForm'

defineProps({
  rows: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  loading: { type: Boolean, default: false }
})
const emit = defineEmits(['query'])
const filters = reactive({ connectionId: '', action: '' })
const actions = [
  { value: 'connection_created', label: '创建企业连接' },
  { value: 'connection_credentials_replaced', label: '替换凭据' },
  { value: 'connection_verified', label: '验证并同步' },
  { value: 'runtime_config_published', label: '发布到网关' },
  { value: 'runtime_config_disabled', label: '停用网关' },
  { value: 'account_policy_updated', label: '账号策略' },
  { value: 'allowlist_added', label: '添加白名单' },
  { value: 'allowlist_removed', label: '移出白名单' }
]

const actionText = value => actions.find(item => item.value === value)?.label || value
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
function changeText(row) {
  const value = row.after || row.before
  if (!value) return '-'
  return Object.entries(value).map(([key, item]) => `${key}: ${item ?? '-'}`).join(' · ')
}
function submit() {
  emit('query', normalizeOperationLogFilters({ ...filters, page: 1, pageSize: 20 }))
}
function changePage(page) {
  emit('query', normalizeOperationLogFilters({ ...filters, page, pageSize: 20 }))
}
</script>

<style scoped>
.operation-section { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; box-sizing: border-box; background: #fff; border: 1px solid #dde4e1; border-radius: 8px; padding: 18px; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.section-heading h2 { margin: 0 0 4px; color: #15231d; font-size: 17px; }
.section-heading p { margin: 0; color: #68756f; font-size: 13px; }
.filters { display: flex; gap: 8px; }
.filters .el-select { width: 150px; }
strong, small { display: block; }
small { margin-top: 3px; color: #7c8983; }
.pagination { justify-content: flex-end; margin-top: 16px; }
@media (max-width: 900px) {
  .section-heading, .filters { align-items: stretch; flex-direction: column; }
  .filters .el-select { width: 100%; }
}
</style>
