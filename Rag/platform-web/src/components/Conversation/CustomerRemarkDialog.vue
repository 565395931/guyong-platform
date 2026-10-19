<template>
  <el-dialog :model-value="modelValue" title="本地客户备注" width="min(92vw, 460px)" append-to-body
    :before-close="beforeClose" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
    <el-form label-position="top" novalidate @submit.prevent="save">
      <el-form-item label="备注名称" :error="error">
        <el-input ref="inputRef" v-model="draft" maxlength="100" show-word-limit clearable
          placeholder="例如：张先生｜汽车隔热膜咨询" :disabled="saving" @input="error = ''" />
      </el-form-item>
      <p>只保存在本机，同一店铺的后续咨询沿用此名称；不会修改微信资料。清空后显示渠道用户 ID。</p>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="beforeClose(close)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存备注</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { updateConversation } from '@/api/conversations'
const props = defineProps({ modelValue: Boolean, conversation: { type: Object, default: null } })
const emit = defineEmits(['update:modelValue', 'updated'])
const draft = ref(''), error = ref(''), saving = ref(false), inputRef = ref()
let initial = '', editingId = null
const close = () => emit('update:modelValue', false)
watch(() => props.modelValue, async visible => {
  if (!visible) { draft.value = ''; error.value = ''; return }
  editingId = props.conversation?.id
  initial = props.conversation?.user_name === props.conversation?.user_id ? '' : (props.conversation?.user_name || '')
  draft.value = initial; error.value = ''
  await nextTick(); inputRef.value?.focus()
})
watch(() => props.conversation?.id, () => { if (props.modelValue) close() })
async function beforeClose(done) {
  if (saving.value) return
  if (draft.value !== initial) {
    try { await ElMessageBox.confirm('本地备注尚未保存，是否放弃修改？', '放弃修改', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' }) }
    catch { return }
  }
  done()
}
async function save() {
  if (saving.value || !editingId || editingId !== props.conversation?.id) return
  const id = editingId
  const userName = draft.value.trim() || props.conversation.user_id
  if (!userName || draft.value.trim().length > 100) { error.value = '备注最多 100 字'; inputRef.value?.focus(); return }
  saving.value = true; error.value = ''
  try {
    const response = await updateConversation(id, { user_name: userName })
    if (response.success === false) throw new Error('save failed')
    emit('updated', { id, user_name: userName })
    if (id === editingId && props.modelValue) { initial = draft.value; close(); ElMessage.success('本地备注已保存') }
  } catch { if (id === editingId && props.modelValue) error.value = '备注未保存，请重试' }
  finally { saving.value = false }
}
</script>
