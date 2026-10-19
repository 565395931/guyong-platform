<template>
  <section class="remote-connection" aria-label="远端小店连接">
    <div class="remote-connection__head">
      <strong>远端小店连接</strong>
      <el-button type="primary" @click="openPair">连接远端</el-button>
      <el-button :loading="loading" @click="refresh">刷新状态</el-button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!connections.length && !loading">尚未连接。在远端店铺列表点击“连接本地工作台”，复制配对码到这里。</p>
    <div v-for="connection in connections" :key="connection.id" class="remote-connection__row">
      <span>{{ connection.shopNames.join('、') }}</span>
      <el-tag :type="connection.state === 'connected' ? 'success' : 'warning'" effect="plain">
        {{ connection.state === 'connected' ? '已连接 · 人工回复' : connection.state === 'rejected' ? '授权失效 · 请重新配对' : '连接中 · 暂不能发送' }}
      </el-tag>
      <span v-if="connection.message" role="status">{{ connection.message }}</span>
      <el-button :loading="disconnecting === connection.id" @click="disconnect(connection)">断开连接</el-button>
    </div>
    <el-dialog v-model="visible" title="连接远端小店" width="min(92vw, 520px)" append-to-body destroy-on-close
      :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @closed="clearPair">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="pair">
        <p>配对后自动导入授权店铺，沿用远端的所属客户，不需要再填写小店密钥。不会开启自动回复。</p>
        <el-form-item label="一次性配对码" prop="code">
          <el-input v-model="form.code" :disabled="saving" autocomplete="off" spellcheck="false"
            placeholder="粘贴远端生成的配对码" @input="pairError = ''" />
        </el-form-item>
        <p v-if="pairError" role="alert">{{ pairError }}</p>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="pair">连接并导入店铺</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/api/index'
import { useChannelHealth } from '@/modules/channels/channelHealth'
const emit = defineEmits(['changed'])
const connections = ref([]), loading = ref(false), error = ref(''), visible = ref(false), saving = ref(false)
const formRef = ref(), form = reactive({ code: '' }), pairError = ref(''), disconnecting = ref('')
const rules = { code: [{ required: true, message: '请粘贴配对码', trigger: 'blur' },
  { pattern: /^lwp_[A-Za-z0-9_-]{20,100}$/, message: '配对码格式不正确，请完整复制', trigger: 'blur' }] }
let timer, disposed = false
const health = useChannelHealth()
function clearPair() { form.code = ''; pairError.value = '' }
function openPair() { clearPair(); visible.value = true }
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await request.get('/v1/local-workbench')
    if (!disposed) {
      connections.value = result.data
      health.remoteShopAccounts.value = result.data.flatMap(connection => connection.accounts.map(accountId => ({ accountId, state: connection.state })))
      error.value = ''
    }
  }
  catch { if (!disposed) error.value = '连接状态暂时无法读取，请点击刷新重试' }
  finally { loading.value = false }
}
async function pair() {
  if (saving.value) return
  form.code = form.code.trim()
  try { await formRef.value.validate() } catch { return }
  saving.value = true; pairError.value = ''
  try {
    await request.post('/v1/local-workbench/pair', { code: form.code })
    visible.value = false; clearPair(); await refresh(); await health.refresh(); emit('changed')
    ElMessage.success('店铺已导入，正在建立实时连接')
  } catch (error) { pairError.value = error.response?.data?.message || error.message || '连接失败，请重新生成配对码后重试' }
  finally { saving.value = false }
}
async function disconnect(connection) {
  try { await ElMessageBox.confirm('停止同步并解除远端接管，聊天记录保留。以后可重新配对。', '断开连接', { confirmButtonText: '确认断开', cancelButtonText: '取消', type: 'warning' }) }
  catch { return }
  disconnecting.value = connection.id
  try { await request.post(`/v1/local-workbench/${connection.id}/disconnect`); await refresh(); await health.refresh(); emit('changed'); ElMessage.success('已断开连接') }
  finally { disconnecting.value = '' }
}
onMounted(() => { refresh(); timer = setInterval(() => { if (!document.hidden && connections.value.length) refresh() }, 5000) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer); clearPair() })
</script>

<style scoped lang="scss">
.remote-connection {
  border: 1px solid var(--el-border-color); border-radius: 8px; padding: 16px; margin-bottom: 16px;
  &__head, &__row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  &__head strong { margin-right: auto; }
  &__row { margin-top: 12px; }
  p { color: var(--el-text-color-secondary); line-height: 1.6; }
}
</style>
