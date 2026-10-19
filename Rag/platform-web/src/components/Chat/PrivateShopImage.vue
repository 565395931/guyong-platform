<template>
  <div class="private-shop-image">
    <el-image v-if="imageUrl" :src="imageUrl" :preview-src-list="[imageUrl]" preview-teleported fit="contain" :alt="label" />
    <span v-else-if="loading" role="status">正在读取图片…</span>
    <div v-else role="status"><span>图片暂时无法读取</span><el-button size="small" @click="load">重试</el-button></div>
  </div>
</template>
<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import request from '@/api/index'
const props = defineProps({ source: { type: String, required: true }, label: { type: String, default: '客户发送的图片' } })
const imageUrl = ref(''), loading = ref(false)
let sequence = 0, controller
function clear() { if (imageUrl.value) URL.revokeObjectURL(imageUrl.value); imageUrl.value = '' }
async function load() {
  const current = ++sequence; controller?.abort(); controller = new AbortController(); clear(); loading.value = true
  try {
    if (!/^\/api\/v1\/local-workbench\/media\/\d+\/[a-zA-Z0-9-]+$/.test(props.source)) return
    const blob = await request.get(props.source.replace(/^\/api/, ''), { responseType: 'blob', signal: controller.signal })
    if (current === sequence) imageUrl.value = URL.createObjectURL(blob)
  } catch { /* Retain an inline retry action; don't expose the remote token. */ }
  finally { if (current === sequence) loading.value = false }
}
watch(() => props.source, load, { immediate: true })
onBeforeUnmount(() => { ++sequence; controller?.abort(); clear() })
</script>
<style scoped>
.private-shop-image { min-width: 160px; min-height: 80px; }
.private-shop-image :deep(.el-image) { max-width: 260px; max-height: 280px; cursor: pointer; }
</style>
