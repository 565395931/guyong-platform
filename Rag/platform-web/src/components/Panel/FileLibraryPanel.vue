<template>
  <div class="file-library-panel">
    <div class="file-library-panel__filters">
      <el-select v-model="query.mediaType" size="small" clearable placeholder="全部类型" @change="fetchFiles">
        <el-option label="图片" value="image" />
        <el-option label="视频" value="video" />
        <el-option label="语音" value="audio" />
        <el-option label="文件" value="file" />
      </el-select>
      <el-input
        v-model="query.keyword"
        size="small"
        clearable
        placeholder="搜索文件"
        @keyup.enter="fetchFiles"
        @clear="fetchFiles"
      >
        <template #append>
          <el-button :icon="Search" @click="fetchFiles" />
        </template>
      </el-input>
    </div>

    <div v-loading="loading" class="file-library-panel__list">
      <el-empty v-if="!loading && files.length === 0" description="暂无可发送文件" :image-size="60" />
      <div v-for="file in files" :key="file.id" class="file-card">
        <div class="file-card__preview" :class="`file-card__preview--${file.mediaType}`">
          <img v-if="file.mediaType === 'image'" :src="resolveAssetUrl(file.url)" :alt="file.originalName" />
          <el-icon v-else-if="file.mediaType === 'video'"><VideoPlay /></el-icon>
          <el-icon v-else><Document /></el-icon>
        </div>
        <div class="file-card__body">
          <div class="file-card__name" :title="file.displayName || file.originalName">{{ file.displayName || file.originalName }}</div>
          <div v-if="file.description" class="file-card__description" :title="file.description">{{ file.description }}</div>
          <div class="file-card__meta">
            <el-tag size="small" :type="typeTag(file.mediaType)" effect="plain">{{ typeLabel(file.mediaType) }}</el-tag>
            <span>{{ formatSize(file.size) }}</span>
          </div>
        </div>
        <el-button size="small" type="primary" plain @click="selectFile(file)">选择</el-button>
      </div>
    </div>

    <div v-if="total > query.pageSize" class="file-library-panel__pager">
      <el-pagination
        v-model:current-page="query.page"
        small
        layout="prev, pager, next"
        :page-size="query.pageSize"
        :total="total"
        @current-change="fetchFiles"
      />
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, VideoPlay, Document } from '@element-plus/icons-vue'
import { getMediaFiles } from '@/api/messages'
import { resolveAssetUrl } from '@/utils/runtimeConfig'

const emit = defineEmits(['select'])

const loading = ref(false)
const files = ref([])
const total = ref(0)
const query = reactive({
  mediaType: '',
  keyword: '',
  page: 1,
  pageSize: 12
})

const fetchFiles = async () => {
  loading.value = true
  try {
    const res = await getMediaFiles(query)
    const data = res.data || {}
    files.value = data.list || []
    total.value = data.total || 0
  } catch (err) {
    ElMessage.error('获取文件列表失败: ' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

const selectFile = (file) => {
  emit('select', file)
}

const typeLabel = (type) => ({ image: '图片', video: '视频', audio: '语音', file: '文件' }[type] || type)
const typeTag = (type) => ({ image: 'success', video: 'warning', audio: 'primary', file: 'info' }[type] || 'info')
const formatSize = (size) => {
  const n = Number(size || 0)
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

onMounted(fetchFiles)
</script>

<style scoped lang="scss">
.file-library-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;

  &__filters {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 8px;
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 220px;
  }

  &__pager {
    display: flex;
    justify-content: center;
    padding-top: 4px;
  }
}

.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  transition: border-color 0.2s, box-shadow 0.2s;

  &:hover {
    border-color: #93c5fd;
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.06);
  }

  &__preview {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f1f5f9;
    color: #64748b;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .el-icon {
      font-size: 22px;
    }

    &--image { background: #f0fdf4; color: #16a34a; }
    &--video { background: #fffbeb; color: #d97706; }
    &--file { background: #f8fafc; color: #475569; }
  }

  &__body {
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-size: 13px;
    font-weight: 600;
    color: #1e293b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 6px;
  }

  &__description {
    margin: -2px 0 6px;
    font-size: 12px;
    line-height: 1.35;
    color: #64748b;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #64748b;
  }
}
</style>
