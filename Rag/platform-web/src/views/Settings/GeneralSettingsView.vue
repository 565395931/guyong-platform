<template>
  <section class="general-settings">
    <h1>通用设置</h1>
    <p>设置客户转入待人工时收到的提示。</p>
    <p v-if="error" role="alert">{{ error }} <el-button link @click="load">重新读取</el-button></p>
    <el-form v-loading="loading" label-position="top" novalidate>
      <el-form-item label="发送转人工提示"><el-switch v-model="form.handoffNoticeEnabled" :disabled="loading || saving" aria-label="发送转人工提示" /></el-form-item>
      <el-form-item label="转人工提示内容">
        <el-input v-model="form.handoffNoticeText" type="textarea" :rows="4" resize="none" maxlength="1000" show-word-limit :disabled="loading || saving" aria-label="转人工提示内容" />
      </el-form-item>
      <p>客户进入 Admin 待人工后，等待 10 秒再自动分配；你可以在这期间指定客服。接待人数每天北京时间 19:00 重置。</p>
      <el-button type="primary" :loading="saving" :disabled="loading || !!error" @click="save">保存通用设置</el-button>
    </el-form>
  </section>
</template>
<script setup>
import { onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/api/index'
const form = reactive({ handoffNoticeEnabled: true, handoffNoticeText: '' })
const loading = ref(false), saving = ref(false), error = ref('')
let saved = ''
async function load() {
  loading.value = true; error.value = ''
  try { const result = await request.get('/v1/conversations/general-settings'); Object.assign(form, result.data); saved = JSON.stringify(form) }
  catch (e) { error.value = e.message || '读取失败，请重试' }
  finally { loading.value = false }
}
async function save() {
  if (saving.value) return
  if (form.handoffNoticeEnabled && !form.handoffNoticeText.trim()) return ElMessage.warning('请输入转人工提示，或关闭提示')
  saving.value = true
  try { await request.put('/v1/conversations/general-settings', form); saved = JSON.stringify(form); ElMessage.success('通用设置已保存') }
  catch (e) { ElMessage.error(e.message || '保存失败，请重试') }
  finally { saving.value = false }
}
onBeforeRouteLeave(async () => {
  if (saving.value) return false
  if (!saved || saved === JSON.stringify(form)) return true
  try { await ElMessageBox.confirm('通用设置尚未保存，放弃修改吗？', '放弃修改', { confirmButtonText: '放弃', cancelButtonText: '继续编辑' }); return true } catch { return false }
})
onMounted(load)
</script>
<style scoped>.general-settings { max-width: 760px; padding: 24px; }.general-settings p { color: var(--el-text-color-secondary); line-height: 1.7; }</style>
