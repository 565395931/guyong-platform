<template>
  <el-dialog v-model="visible" title="配置客服账号" width="560px" append-to-body :close-on-click-modal="false" :before-close="beforeClose">
    <el-form label-position="top" novalidate>
      <el-form-item label="平台账号">
        <el-select v-model="accountId" aria-label="选择要配置的平台账号" style="width: 100%" :disabled="saving" @change="load">
          <el-option v-for="account in accounts" :key="account.id" :label="account.account_name" :value="account.id" />
        </el-select>
      </el-form-item>
      <el-alert type="info" :closable="false" show-icon title="只有配置到这里的客服可以查看 AI 对话和接待客户。一个客服时，即使离线也会分配给他；多个客服时不分给离线的人。" />
      <p v-if="error" role="alert">{{ error }} <el-button link @click="load">重试</el-button></p>
      <div v-loading="loading" class="seat-options">
        <el-checkbox-group v-model="selected" aria-label="允许接待此平台账号的客服" :disabled="saving || loading">
          <el-checkbox v-for="seat in seats" :key="seat.id" :value="seat.id">{{ seat.username }}</el-checkbox>
        </el-checkbox-group>
        <el-empty v-if="!loading && !seats.length" description="暂无启用的普通客服，请先在系统账号管理中创建" :image-size="48" />
      </div>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="beforeClose(() => visible = false)">取消</el-button><el-button type="primary" :loading="saving" :disabled="loading || !!error || !accountId" @click="save">保存增减</el-button></template>
  </el-dialog>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/api/index'
const props = defineProps({ modelValue: Boolean, accounts: { type: Array, default: () => [] }, initialAccountId: [Number, String] })
const emit = defineEmits(['update:modelValue', 'saved'])
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const accountId = ref(null), seats = ref([]), selected = ref([]), bindings = ref([]), loading = ref(false), saving = ref(false), error = ref('')
let requestVersion = 0
async function load() {
  const version = ++requestVersion
  if (!accountId.value) return
  loading.value = true; error.value = ''
  try {
    const [users, linked] = await Promise.all([request.get('/v1/system-accounts', { params: { role: 'agent', status: 'active' } }), request.get('/v1/seat-bindings', { params: { account_id: accountId.value, status: 'active' } })])
    if (version !== requestVersion) return
    seats.value = users.data || []; bindings.value = linked.data || []
    selected.value = bindings.value.map(binding => Number(binding.seat_id))
  } catch (e) { if (version === requestVersion) error.value = e.message || '读取失败，请重试' }
  finally { if (version === requestVersion) loading.value = false }
}
async function save() {
  if (saving.value) return
  saving.value = true; error.value = ''
  try {
    for (const binding of bindings.value) if (!selected.value.includes(Number(binding.seat_id))) await request.delete(`/v1/seat-bindings/${binding.id}`)
    for (const id of selected.value) if (!bindings.value.some(binding => Number(binding.seat_id) === id)) await request.post('/v1/seat-bindings', { account_id: accountId.value, seat_id: id })
    ElMessage.success('客服账号配置已保存'); emit('saved'); visible.value = false
  } catch (e) { await load(); error.value = e.message || '保存失败，请重新读取后重试' }
  finally { saving.value = false }
}
async function beforeClose(done) {
  if (saving.value) return
  const original = bindings.value.map(row => Number(row.seat_id)).sort().join(',')
  if ([...selected.value].sort().join(',') !== original) {
    try { await ElMessageBox.confirm('客服账号配置尚未保存，放弃这次增减吗？', '放弃修改', { confirmButtonText: '放弃', cancelButtonText: '继续配置' }) } catch { return }
  }
  done()
}
watch(() => props.modelValue, value => { if (value) { accountId.value = Number(props.initialAccountId) || props.accounts[0]?.id || null; load() } else requestVersion++ })
</script>
<style scoped>.seat-options { min-height: 100px; margin-top: 16px; }.seat-options :deep(.el-checkbox-group) { display: flex; flex-wrap: wrap; gap: 12px; }</style>
