<template>
  <section
    class="connection-section"
    :class="{ 'connection-section--embedded': props.embedded }"
  >
    <div class="section-heading">
      <div>
        <h2>企业连接</h2>
        <p>每个企业主体只保存一份官方凭据，验证后自动同步旗下微信客服账号。</p>
      </div>
      <div class="section-actions">
        <el-button :icon="Refresh" :loading="loading" @click="$emit('refresh')">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="$emit('add')">添加企业主体</el-button>
      </div>
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      row-key="id"
      highlight-current-row
      :current-row-key="selectedId"
      empty-text="尚未添加企业微信连接"
      @current-change="row => row && $emit('select', row.id)"
    >
      <el-table-column prop="connectionName" label="企业连接" min-width="190">
        <template #default="{ row }">
          <div class="connection-name">
            <span class="connection-mark">企</span>
            <div><strong>{{ row.connectionName }}</strong><small>{{ row.corpId }}</small></div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="连接状态" width="125">
        <template #default="{ row }">
          <el-tag :type="statusType(row)" effect="plain">{{ statusText(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="accountCount" label="客服账号" width="100" align="right" />
      <el-table-column label="最近同步" min-width="165">
        <template #default="{ row }">{{ formatTime(row.lastSyncAt) }}</template>
      </el-table-column>
      <el-table-column label="最近回调" min-width="165">
        <template #default="{ row }">{{ formatTime(row.lastCallbackAt) }}</template>
      </el-table-column>
      <el-table-column prop="healthMessage" label="状态说明" :min-width="props.embedded ? 180 : 220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.healthMessage || '等待验证' }}</template>
      </el-table-column>
      <el-table-column
        label="操作"
        :width="props.embedded ? 280 : 500"
        :fixed="props.embedded ? undefined : 'right'"
      >
        <template #default="{ row }">
          <div class="connection-actions">
            <el-button link type="primary" @click.stop="$emit('select', row.id)">查看账号</el-button>
            <el-button link type="primary" @click.stop="$emit('replace', row)">替换凭据</el-button>
            <el-button link type="primary" :loading="verifyingId === row.id" @click.stop="$emit('verify', row.id)">验证并同步</el-button>
            <el-button
              link
              type="primary"
              :icon="DocumentCopy"
              :disabled="!row.callbackUrl"
              @click.stop="copyCallbackUrl(row)"
            >复制回调地址</el-button>
            <el-button
              link
              type="success"
              :disabled="!canPublishRuntime(row)"
              :loading="publishingId === row.id"
              @click.stop="$emit('publish', row.id)"
            >发布到网关</el-button>
            <el-button
              link
              type="danger"
              :icon="SwitchButton"
              :disabled="!canDisableRuntime(row)"
              :loading="disablingId === row.id"
              @click.stop="$emit('disable', row.id)"
            >停用网关</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<script setup>
import { ElMessage } from 'element-plus'
import { DocumentCopy, Plus, Refresh, SwitchButton } from '@element-plus/icons-vue'
import { canDisableRuntime, canPublishRuntime } from '@/modules/platformConnections/connectionForm'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  selectedId: { type: [Number, String], default: '' },
  loading: { type: Boolean, default: false },
  verifyingId: { type: [Number, String], default: '' },
  publishingId: { type: [Number, String], default: '' },
  disablingId: { type: [Number, String], default: '' },
  embedded: { type: Boolean, default: false }
})
defineEmits(['add', 'refresh', 'select', 'replace', 'verify', 'publish', 'disable'])

const statusText = row => {
  if (row.healthStatus === 'error') return '连接异常'
  return ({ draft: '待验证', verified: '已验证', active: '运行中', disabled: '已停用', error: '连接异常' }[row.status] || row.status)
}
const statusType = row => row.healthStatus === 'error'
  ? 'danger'
  : ({ verified: 'success', active: 'success', disabled: 'info', error: 'danger' }[row.status] || 'warning')
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'

async function copyCallbackUrl(row) {
  if (!row?.callbackUrl) return
  try {
    await navigator.clipboard.writeText(row.callbackUrl)
    ElMessage.success('企业微信回调地址已复制')
  } catch {
    ElMessage.error('复制回调地址失败')
  }
}
</script>

<style scoped>
.connection-section { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; box-sizing: border-box; background: #fff; border: 1px solid #dde4e1; border-radius: 8px; padding: 18px; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.section-heading h2 { margin: 0 0 4px; font-size: 17px; color: #15231d; }
.section-heading p { margin: 0; color: #68756f; font-size: 13px; }
.section-actions { display: flex; gap: 8px; flex-shrink: 0; }
.connection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
}
.connection-actions :deep(.el-button) { margin: 0; }
.connection-name { display: flex; align-items: center; gap: 10px; }
.connection-name strong, .connection-name small { display: block; }
.connection-name small { margin-top: 2px; color: #809088; font-family: Consolas, monospace; }
.connection-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: #e7f6ef; color: #16885b; font-weight: 700; }
.connection-section--embedded { padding: 16px; }
.connection-section--embedded .section-heading { gap: 12px; }
.connection-section--embedded .section-actions { flex-wrap: wrap; justify-content: flex-start; }
@media (max-width: 900px) { .section-heading { flex-direction: column; } }
</style>
