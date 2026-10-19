<template>
  <div v-if="userStore.userInfo?.role === 'agent'" class="seat-presence" aria-live="polite">
    <el-button size="small" :type="status === 'online' ? 'success' : status === 'busy' ? 'warning' : 'info'" :loading="saving"
      :aria-label="`接待状态：${labels[status]}，点击切换为${labels[nextStatus[status]]}`" @click="changeStatus(nextStatus[status])">{{ labels[status] }}</el-button>
    <span v-if="!error" title="主动回复过的不同客户数，每天北京时间19:00重置">今日接待 {{ current }} 人</span>
    <el-button v-else link type="danger" @click="refresh">状态获取失败，重试</el-button>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import request from '@/api/index'
import { websocketService } from '@/api/websocket'

const userStore = useUserStore()
const labels = { online: '在线', busy: '忙碌', offline: '离线' }
const nextStatus = { online: 'busy', busy: 'offline', offline: 'online' }
const status = ref('online')
const current = ref(0)
const saving = ref(false)
const error = ref(false)
let timer
let reading = false
let disposed = false
async function refresh() {
  if (reading || saving.value || userStore.userInfo?.role !== 'agent') return
  reading = true
  try {
    const res = await request.get('/v1/conversations/seat-status', { silent: true })
    if (!disposed) { status.value = res.data.status; current.value = res.data.current; error.value = false }
  } catch { if (!disposed) error.value = true }
  finally { reading = false }
}
async function changeStatus(value) {
  if (saving.value) return
  saving.value = true
  try {
    await request.post('/v1/conversations/seat-status', { status: value })
    ElMessage.success(`接待状态已切换为${labels[value]}`)
  } finally { saving.value = false; await refresh() }
}
onMounted(() => { websocketService.on('conversation_update', refresh); refresh(); timer = setInterval(refresh, 3000) })
onBeforeUnmount(() => { websocketService.off('conversation_update', refresh); disposed = true; clearInterval(timer) })
</script>

<style scoped>
.seat-presence { display: flex; align-items: center; gap: 8px; white-space: nowrap; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
