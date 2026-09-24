<template>
  <el-drawer v-model="visible" class="allowlist-drawer" size="520px" :title="drawerTitle" destroy-on-close>
    <div class="drawer-body">
      <el-alert
        v-if="connection?.status === 'active'"
        type="warning"
        :closable="false"
        show-icon
        title="网关运行中，停用后才能修改白名单"
      />

      <el-form class="allowlist-form" label-position="top" @submit.prevent="submit">
        <el-form-item label="外部联系人 ID" required>
          <el-input v-model="form.externalUserId" maxlength="160" placeholder="企业微信 external_userid" :disabled="!editable" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.label" maxlength="120" placeholder="例如：内部测试手机" :disabled="!editable" />
        </el-form-item>
        <el-button type="primary" :icon="Plus" :loading="adding" :disabled="!editable" @click="submit">添加到白名单</el-button>
      </el-form>

      <div class="list-heading">
        <h3>当前白名单</h3>
        <el-tag effect="plain">{{ rows.length }} 人</el-tag>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="尚未添加测试联系人">
        <el-table-column label="外部联系人" min-width="190">
          <template #default="{ row }">
            <strong class="external-id">{{ row.externalUserId }}</strong>
            <small>{{ row.label || '无备注' }}</small>
          </template>
        </el-table-column>
        <el-table-column label="添加时间" width="150">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="64" align="center">
          <template #default="{ row }">
            <el-tooltip content="移出白名单" placement="top">
              <el-button link type="danger" :icon="Delete" :disabled="!editable" @click="$emit('remove', row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import {
  canEditAccountConfiguration,
  normalizeAllowlistForm,
  validateAllowlistForm
} from '@/modules/platformConnections/connectionForm'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  account: { type: Object, default: null },
  connection: { type: Object, default: null },
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  adding: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'add', 'remove'])
const form = reactive({ externalUserId: '', label: '' })
const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})
const drawerTitle = computed(() => `${props.account?.accountName || '测试账号'} · 白名单`)
const editable = computed(() => canEditAccountConfiguration(props.connection))

function submit() {
  const payload = normalizeAllowlistForm(form)
  const errors = validateAllowlistForm(payload)
  if (errors.length) return ElMessage.warning(errors[0])
  emit('add', payload)
}

function resetForm() {
  form.externalUserId = ''
  form.label = ''
}

watch(() => props.account?.id, resetForm)
watch(() => props.rows.length, (value, oldValue) => {
  if (value > oldValue) resetForm()
})

const formatTime = value => value
  ? new Date(value).toLocaleString('zh-CN', { hour12: false })
  : '-'
</script>

<style scoped>
.drawer-body { display: grid; gap: 20px; }
.allowlist-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) auto; gap: 10px; align-items: end; }
.allowlist-form :deep(.el-form-item) { margin-bottom: 0; }
.allowlist-form > .el-button { margin-bottom: 1px; }
.list-heading { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e2e8e5; padding-top: 16px; }
.list-heading h3 { margin: 0; color: #1b2a23; font-size: 15px; }
.external-id, small { display: block; }
.external-id { color: #24352d; font-family: Consolas, monospace; font-size: 13px; font-weight: 600; }
small { margin-top: 3px; color: #7b8982; }
@media (max-width: 720px) {
  .allowlist-form { grid-template-columns: 1fr; }
  .allowlist-form > .el-button { width: 100%; }
  :global(.allowlist-drawer) { width: 100% !important; }
}
</style>
