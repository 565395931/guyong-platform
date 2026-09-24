<template>
  <div class="rag-panel">
    <div class="rag-panel__title">
      <el-icon><MagicStick /></el-icon>
      <span>AI 智能推荐</span>
    </div>
    <LoadingSkeleton v-if="loading" :rows="2" height="80px" />
    <template v-else-if="suggestions.length > 0">
      <div v-for="(item, idx) in suggestions" :key="idx" class="rag-panel__card">
        <div class="rag-panel__content">{{ item.content }}</div>
        <div class="rag-panel__source">
          <el-tag size="small" type="info" effect="plain">{{ item.source }}</el-tag>
          <span class="rag-panel__score">相关度: {{ (item.score * 100).toFixed(0) }}%</span>
        </div>
        <div class="rag-panel__actions">
          <el-button size="small" type="primary" @click="handleAdopt(item)">采纳</el-button>
          <el-button size="small" :icon="CopyDocument" @click="handleCopy(item)" />
        </div>
      </div>
    </template>
    <EmptyState v-else description="暂无推荐回答" />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { MagicStick, CopyDocument } from '@element-plus/icons-vue'
import LoadingSkeleton from '@/components/Common/LoadingSkeleton.vue'
import EmptyState from '@/components/Common/EmptyState.vue'

const props = defineProps({
  conversationId: { type: [Number, String], default: null }
})

const loading = ref(false)
const suggestions = ref([])

const mockSuggestions = [
  { content: '您好！我们最新款产品是 X-Pro 2024，支持智能语音控制，价格 2999 元。目前有新品 9 折优惠，需要我发详细资料吗？', source: '产品手册.pdf', score: 0.92 },
  { content: '根据我们的产品目录，X-Pro 系列包含三个型号：标准版 1999 元、Pro 版 2999 元、Max 版 3999 元，均支持 30 天无理由退换。', source: '价格表.xlsx', score: 0.85 }
]

const loadSuggestions = () => {
  loading.value = true
  suggestions.value = []
  setTimeout(() => {
    suggestions.value = mockSuggestions
    loading.value = false
  }, 1500)
}

watch(() => props.conversationId, (val) => { if (val) loadSuggestions() }, { immediate: true })

const handleAdopt = (item) => { ElMessage.success('已采纳推荐回答') }
const handleCopy = (item) => {
  navigator.clipboard.writeText(item.content)
  ElMessage.success('已复制到剪贴板')
}
</script>

<style lang="scss" scoped>
.rag-panel {
  &__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: #1e293b;
    padding: 12px 0;
  }
  &__card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 12px;
  }
  &__content {
    font-size: 13px;
    line-height: 1.6;
    color: #475569;
    margin-bottom: 8px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  &__source {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  &__score { font-size: 12px; color: #94a3b8; }
  &__actions { display: flex; gap: 8px; }
}
</style>
