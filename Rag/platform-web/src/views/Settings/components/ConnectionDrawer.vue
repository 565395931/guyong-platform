<template>
  <el-drawer :model-value="modelValue" :title="replacing ? '替换企业微信凭据' : '添加企业微信主体'" size="520px" @close="close">
    <el-alert
      :title="replacing ? '替换后连接会回到待验证状态，不会自动启用 AI 或改变客服账号。' : '这里使用企业微信“微信客服”的官方接口凭据。保存后密钥只能替换，不能查看。'"
      type="info"
      :closable="false"
      show-icon
    />
    <el-form class="connection-form" label-position="top">
      <el-form-item label="企业连接名称"><el-input v-model="form.connectionName" :disabled="replacing" placeholder="例如：孤勇者企业微信" /></el-form-item>
      <el-form-item label="CorpID"><el-input v-model="form.corpId" :disabled="replacing" placeholder="企业 ID" autocomplete="off" /></el-form-item>
      <el-form-item label="微信客服 Secret"><el-input v-model="form.secret" type="password" show-password autocomplete="new-password" /></el-form-item>
      <el-form-item label="回调 Token"><el-input v-model="form.callbackToken" type="password" show-password autocomplete="new-password" /></el-form-item>
      <el-form-item label="EncodingAESKey"><el-input v-model="form.encodingAesKey" type="password" show-password autocomplete="new-password" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submit">保存连接</el-button>
    </template>
  </el-drawer>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  normalizeConnectionForm,
  normalizeCredentialReplacementForm,
  validateConnectionForm,
  validateCredentialReplacementForm
} from '@/modules/platformConnections/connectionForm'

const props = defineProps({ modelValue: Boolean, loading: Boolean, connection: { type: Object, default: null } })
const emit = defineEmits(['update:modelValue', 'save'])
const emptyForm = () => ({ connectionName: '', corpId: '', secret: '', callbackToken: '', encodingAesKey: '' })
const form = reactive(emptyForm())
const replacing = computed(() => Boolean(props.connection))

watch(() => props.modelValue, visible => {
  if (!visible) return
  Object.assign(form, emptyForm(), props.connection ? {
    connectionName: props.connection.connectionName,
    corpId: props.connection.corpId
  } : {})
})
function close() { Object.assign(form, emptyForm()); emit('update:modelValue', false) }
function submit() {
  const payload = replacing.value
    ? normalizeCredentialReplacementForm(form)
    : normalizeConnectionForm(form)
  const errors = replacing.value
    ? validateCredentialReplacementForm(payload)
    : validateConnectionForm(payload)
  if (errors.length) return ElMessage.warning(errors[0])
  emit('save', payload)
}
</script>

<style scoped>
.connection-form { margin-top: 20px; }
</style>
