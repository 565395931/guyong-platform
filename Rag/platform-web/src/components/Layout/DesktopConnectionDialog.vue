<template>
  <el-dialog
    v-model="visible"
    title="桌面端连接设置"
    width="520px"
    :close-on-click-modal="false"
    @closed="reset"
  >
    <el-alert
      title="桌面端只负责工作台界面，数据仍由中心服务处理。"
      type="info"
      :closable="false"
      show-icon
      class="desktop-connection-dialog__alert"
    />
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="中心服务地址" :error="error">
        <el-input
          v-model="serverUrl"
          placeholder="例如：http://127.0.0.1:3001"
          autocomplete="url"
          @keyup.enter="save"
        />
      </el-form-item>
    </el-form>
    <p class="desktop-connection-dialog__hint">
      当前模式：{{ currentMode }}。保存后应用会重新加载，请在新的服务上重新登录。
    </p>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存并重载</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getDesktopBridge, runtimeConfig } from '@/utils/runtimeConfig'
import { clearSession, loginUrl } from '@/utils/sessionNavigation'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])
const bridge = getDesktopBridge()
const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})
const serverUrl = ref(bridge?.config?.serverUrl || runtimeConfig.serverUrl || 'http://127.0.0.1:3001')
const error = ref('')
const saving = ref(false)
const currentMode = computed(() => runtimeConfig.mode === 'remote-server' ? '远程/本地中心服务' : 'Vite 开发代理')

watch(() => props.modelValue, open => {
  if (open) {
    serverUrl.value = bridge?.config?.serverUrl || runtimeConfig.serverUrl || 'http://127.0.0.1:3001'
    error.value = ''
  }
})

async function save() {
  if (!bridge) return
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    const result = await bridge.setServerUrl(serverUrl.value)
    if (!result.success) {
      error.value = result.message || '保存失败'
      return
    }
    ElMessage.success('连接地址已更新，正在重新加载')
    clearSession()
    // The main process replies first; clearing credentials must precede reload.
    window.location.replace(loginUrl(window.location))
    window.location.reload()
  } catch {
    error.value = '无法保存连接地址，请重试或重新打开应用'
  } finally {
    saving.value = false
  }
}

function reset() {
  error.value = ''
}
</script>

<style scoped lang="scss">
.desktop-connection-dialog__alert { margin-bottom: 18px; }
.desktop-connection-dialog__hint { margin: -4px 0 0; color: #909399; font-size: 12px; line-height: 1.5; }
</style>
