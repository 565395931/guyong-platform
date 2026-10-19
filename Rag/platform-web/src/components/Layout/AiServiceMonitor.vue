<template><span hidden aria-hidden="true" /></template>
<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { aiServiceStatus, refreshAiServiceStatus } from '@/utils/aiServiceStatus'
let timer, active = false, disposed = false
const memory = new Map()
function read(key) { try { return localStorage.getItem(key) } catch { return memory.get(key) } }
function write(key, value) { memory.set(key, value); try { localStorage.setItem(key, value) } catch {} }
async function check() {
  if (disposed || document.visibilityState === 'hidden') return
  await refreshAiServiceStatus()
  if (active || disposed || !aiServiceStatus.connectionId) return
  const status = aiServiceStatus, prefix = 'ai-notice:' + status.connectionId
  const now = Date.now(), lowKey = prefix + ':low'
  let message, title
  if (status.managed && status.balance !== null && status.balance < 10 && now - Number(read(lowKey) || 0) >= 3600000) {
    write(lowKey, String(now))
    message = '大模型余额已不足10元，请及时联系管理员补充大模型额度。'
    title = '大模型余额提醒'
  } else if (!status.managed && status.consecutiveReplyFailures >= 3 && read(prefix + ':failure') !== status.failureEpisode) {
    write(prefix + ':failure', status.failureEpisode)
    message = '连续AI回复失败，请查看您的大模型配置。'
    title = '大模型连接提醒'
  }
  if (!message) return
  active = true
  try { await ElMessageBox.alert(message, title, { confirmButtonText: '确认', type: 'warning', showClose: false, closeOnClickModal: false, closeOnPressEscape: false }) }
  finally { active = false }
}
onMounted(() => { check(); timer = setInterval(check, 60000); document.addEventListener('visibilitychange', check) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', check) })
</script>
