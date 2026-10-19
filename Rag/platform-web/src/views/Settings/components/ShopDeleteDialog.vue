<template>
  <el-dialog :model-value="modelValue" title="删除本地店铺资料" width="min(92vw, 520px)" append-to-body
    :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="close" @opened="cancelRef?.$el?.focus()">
    <p>将删除「{{ account?.account_name }}」的本地账号配置、聊天记录、备注、身份关联及该店铺的订单、报价等数据库关联资料。其他店铺和共享客户主档不会删除。</p>
    <p>该店铺的远端配对会解除；远端店铺登记和原始消息保留。重新配对后，历史消息仍会重新同步。本机保留加密恢复备份，页面不提供撤销。</p>
    <p v-if="loading" role="status">正在核对删除范围…</p>
    <p v-else-if="ready">将清理 {{ counts.conversations || 0 }} 个会话、{{ counts.plat_messages || 0 }} 条消息，共 {{ total }} 条数据库记录。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button v-if="!ready && !loading" :disabled="busy" @click="load">重新核对</el-button>
    <el-form label-position="top" novalidate @submit.prevent="remove">
      <el-form-item label="输入完整店铺名称确认删除">
        <el-input v-model="confirmation" :disabled="busy || !ready" autocomplete="off" :placeholder="account?.account_name" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button ref="cancelRef" :disabled="busy" @click="close">取消</el-button>
      <el-button type="danger" :loading="busy" :aria-busy="busy" :disabled="!ready || confirmation !== account?.account_name" @click="remove">删除本地店铺资料</el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { deleteChannelAccount, previewChannelAccountDeletion } from '@/api/channels'
import { useConversationStore } from '@/stores/conversation'
const props = defineProps({ modelValue: Boolean, account: Object })
const emit = defineEmits(['update:modelValue', 'deleted'])
const counts = ref({}), confirmation = ref(''), error = ref(''), loading = ref(false), busy = ref(false), ready = ref(false), cancelRef = ref()
const total = computed(() => Object.values(counts.value).reduce((sum, value) => sum + Number(value), 0))
let requestId = 0
function close() { if (!busy.value) { requestId++; emit('update:modelValue', false) } }
watch(() => props.modelValue, visible => { if (visible) { confirmation.value = ''; counts.value = {}; ready.value = false; load() } else requestId++ })
async function load() {
  const current = ++requestId, id = props.account?.id
  loading.value = true; error.value = ''; ready.value = false
  try {
    const response = await previewChannelAccountDeletion(id)
    if (current !== requestId) return
    counts.value = response.data.counts; ready.value = true
  } catch { if (current === requestId) error.value = '无法核对删除范围，请重试。尚未删除任何资料。' }
  finally { if (current === requestId) loading.value = false }
}
async function remove() {
  if (busy.value || !ready.value || confirmation.value !== props.account?.account_name) return
  const id = props.account.id
  busy.value = true; error.value = ''
  try {
    await deleteChannelAccount(id, { confirmName: confirmation.value })
    const store = useConversationStore()
    if (String(store.current?.account_id) === String(id)) store.clearCurrent()
    store.setList(store.list.filter(row => String(row.account_id) !== String(id)))
    void store.fetchPoolStats({ force: true })
    emit('update:modelValue', false); emit('deleted', id); ElMessage.success('本地店铺资料已删除')
  } catch (failure) { error.value = failure.response?.data?.message || '删除结果尚未确认，请核对列表后重试。' }
  finally { busy.value = false }
}
</script>
