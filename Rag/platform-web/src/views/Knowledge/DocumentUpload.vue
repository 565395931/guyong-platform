<template>
  <div class="doc-upload-view">
    <!-- 顶部操作栏 -->
    <div class="doc-upload-view__header">
      <el-button :icon="ArrowLeft" @click="goBack">返回</el-button>
      <span class="doc-upload-view__title">文档上传</span>
    </div>

    <!-- 模板选择 -->
    <el-card class="doc-upload-view__section" shadow="never">
      <template #header>
        <div class="doc-upload-view__section-header">
          <el-icon><Setting /></el-icon>
          <span>分块模板设置</span>
        </div>
      </template>
      <el-form :inline="true" class="doc-upload-view__template-form">
        <el-form-item label="分块模板">
          <el-select
            v-model="selectedTemplate"
            placeholder="请选择分块模板"
            style="width: 260px"
          >
            <el-option
              v-for="tpl in templateOptions"
              :key="tpl.value"
              :label="tpl.label"
              :value="tpl.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="最大标题层级">
          <el-select v-model="maxHeadingLevel" style="width: 140px">
            <el-option label="1级" :value="1" />
            <el-option label="2级" :value="2" />
            <el-option label="3级" :value="3" />
            <el-option label="4级" :value="4" />
          </el-select>
        </el-form-item>
        <el-form-item label="最大字符数">
          <el-input-number
            v-model="maxChunkSize"
            :min="200"
            :max="2000"
            :step="100"
            style="width: 140px"
          />
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 拖拽上传区域 -->
    <el-card class="doc-upload-view__section" shadow="never">
      <template #header>
        <div class="doc-upload-view__section-header">
          <el-icon><UploadFilled /></el-icon>
          <span>上传文件</span>
        </div>
      </template>
      <el-upload
        ref="uploadRef"
        class="doc-upload-view__upload"
        drag
        multiple
        :auto-upload="false"
        :on-change="handleFileChange"
        :on-remove="handleFileRemove"
        :file-list="fileList"
        accept=".doc,.docx,.pdf,.xlsx,.xls,.txt,.md"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          将文件拖拽到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">
            支持 Word、PDF、Excel、TXT、Markdown 格式文件，单个文件不超过 50MB
          </div>
        </template>
      </el-upload>

      <div class="doc-upload-view__upload-actions">
        <el-button
          type="primary"
          :icon="Upload"
          :loading="uploading"
          :disabled="fileList.length === 0"
          @click="handleUpload"
        >
          {{ uploading ? '上传中...' : `开始上传 (${fileList.length} 个文件)` }}
        </el-button>
        <el-button
          v-if="fileList.length > 0"
          :icon="Delete"
          @click="handleClearAll"
        >
          清空列表
        </el-button>
      </div>
    </el-card>

    <!-- 文件列表 -->
    <el-card class="doc-upload-view__section" shadow="never">
      <template #header>
        <div class="doc-upload-view__section-header">
          <el-icon><Files /></el-icon>
          <span>文件列表</span>
          <el-tag size="small" type="info" effect="plain">
            共 {{ fileList.length }} 个文件
          </el-tag>
        </div>
      </template>
      <el-table :data="fileList" border style="width: 100%" empty-text="暂无文件">
        <el-table-column label="文件名" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <el-icon :size="18" class="doc-upload-view__file-icon">
              <component :is="getFileIcon(row.name)" />
            </el-icon>
            <span>{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100">
          <template #default="{ row }">
            {{ formatFileSize(row.size) }}
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ getFileType(row.name) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上传状态" width="140">
          <template #default="{ row }">
            <el-tag
              :type="getStatusTagType(row.status)"
              size="small"
              effect="light"
            >
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进度" min-width="200">
          <template #default="{ row }">
            <el-progress
              :percentage="row.progress || 0"
              :status="getProgressStatus(row.status)"
              :stroke-width="8"
            />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 切片统计 -->
    <el-card v-if="uploadCompleted" class="doc-upload-view__section" shadow="never">
      <template #header>
        <div class="doc-upload-view__section-header">
          <el-icon><DataAnalysis /></el-icon>
          <span>切片统计</span>
        </div>
      </template>
      <el-row :gutter="20">
        <el-col :span="6">
          <div class="stat-block stat-block--primary">
            <div class="stat-block__value">{{ chunkStats.totalFiles }}</div>
            <div class="stat-block__label">上传文件数</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-block stat-block--success">
            <div class="stat-block__value">{{ chunkStats.totalChunks }}</div>
            <div class="stat-block__label">生成切片总数</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-block stat-block--warning">
            <div class="stat-block__value">{{ chunkStats.avgChunks }}</div>
            <div class="stat-block__label">平均切片数</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-block stat-block--info">
            <div class="stat-block__value">{{ chunkStats.totalSize }}</div>
            <div class="stat-block__label">总文件大小</div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft,
  Setting,
  UploadFilled,
  Upload,
  Delete,
  Files,
  DataAnalysis,
  Document,
  DocumentCopy,
  Tickets,
  Files as FilesIcon
} from '@element-plus/icons-vue'

const router = useRouter()
const uploadRef = ref(null)
const uploading = ref(false)
const uploadCompleted = ref(false)

const selectedTemplate = ref('default')
const maxHeadingLevel = ref(3)
const maxChunkSize = ref(800)

const templateOptions = [
  { value: 'default', label: '默认模板（标题驱动+800字兜底）' },
  { value: 'qa', label: '问答模板（Q&A对保留）' },
  { value: 'manual', label: '手册模板（章节+步骤）' },
  { value: 'product', label: '产品模板（规格+对比）' }
]

const fileList = ref([])

const chunkStats = reactive({
  totalFiles: 0,
  totalChunks: 0,
  avgChunks: 0,
  totalSize: '0 MB'
})

const formatFileSize = (bytes) => {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

const getFileType = (name) => {
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    doc: 'Word', docx: 'Word',
    pdf: 'PDF',
    xls: 'Excel', xlsx: 'Excel',
    txt: 'TXT',
    md: 'MD'
  }
  return map[ext] || '文件'
}

const getFileIcon = (name) => {
  const ext = name.split('.').pop().toLowerCase()
  if (['doc', 'docx'].includes(ext)) return DocumentCopy
  if (['xls', 'xlsx'].includes(ext)) return Tickets
  if (['pdf'].includes(ext)) return Document
  return FilesIcon
}

const getStatusTagType = (status) => {
  const map = {
    pending: 'info',
    uploading: 'warning',
    success: 'success',
    fail: 'danger'
  }
  return map[status] || 'info'
}

const getStatusLabel = (status) => {
  const map = {
    pending: '等待中',
    uploading: '上传中',
    success: '已完成',
    fail: '失败'
  }
  return map[status] || '等待中'
}

const getProgressStatus = (status) => {
  if (status === 'success') return 'success'
  if (status === 'fail') return 'exception'
  return undefined
}

const handleFileChange = (file) => {
  fileList.value.push({
    ...file,
    name: file.name,
    size: file.size,
    status: 'pending',
    progress: 0
  })
}

const handleFileRemove = (file) => {
  fileList.value = fileList.value.filter((f) => f.uid !== file.uid)
}

const handleClearAll = () => {
  ElMessageBox.confirm('确认清空所有文件吗？', '提示', { type: 'warning' })
    .then(() => {
      fileList.value = []
      uploadCompleted.value = false
      ElMessage.success('已清空')
    })
    .catch(() => {})
}

const handleUpload = async () => {
  if (fileList.value.length === 0) {
    ElMessage.warning('请先添加文件')
    return
  }

  uploading.value = true
  uploadCompleted.value = false

  let totalChunks = 0
  let totalSize = 0

  for (const file of fileList.value) {
    if (file.status === 'success') continue

    file.status = 'uploading'

    // 模拟上传进度
    for (let i = 0; i <= 100; i += 10) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      file.progress = i
    }

    file.status = 'success'
    const chunks = Math.floor(Math.random() * 40) + 10
    totalChunks += chunks
    totalSize += file.size || 0
  }

  chunkStats.totalFiles = fileList.value.filter((f) => f.status === 'success').length
  chunkStats.totalChunks = totalChunks
  chunkStats.avgChunks = chunkStats.totalFiles > 0 ? Math.round(totalChunks / chunkStats.totalFiles) : 0
  chunkStats.totalSize = formatFileSize(totalSize)

  uploading.value = false
  uploadCompleted.value = true
  ElMessage.success('全部文件上传完成')
}

const goBack = () => {
  router.back()
}
</script>

<style scoped lang="scss">
.doc-upload-view {
  padding: 20px;

  &__header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
  }

  &__title {
    font-size: 18px;
    font-weight: 600;
    color: $text-primary;
  }

  &__section {
    margin-bottom: 20px;
    border-radius: $radius-base;
  }

  &__section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: $text-primary;
  }

  &__template-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
  }

  &__upload {
    width: 100%;

    :deep(.el-upload-dragger) {
      width: 100%;
      padding: 40px 20px;
    }
  }

  &__upload-actions {
    display: flex;
    gap: 12px;
    margin-top: 16px;
  }

  &__file-icon {
    vertical-align: middle;
    margin-right: 6px;
    color: $primary-color;
  }
}

.stat-block {
  text-align: center;
  padding: 24px 16px;
  border-radius: $radius-base;
  background: #f5f7fa;

  &--primary {
    background: linear-gradient(135deg, #ecf5ff, #f0f9ff);
  }

  &--success {
    background: linear-gradient(135deg, #f0f9eb, #f5fbeb);
  }

  &--warning {
    background: linear-gradient(135deg, #fdf6ec, #fefcf0);
  }

  &--info {
    background: linear-gradient(135deg, #f4f4f5, #fafafa);
  }

  &__value {
    font-size: 32px;
    font-weight: 700;
    color: $text-primary;
    margin-bottom: 4px;
  }

  &__label {
    font-size: 13px;
    color: $text-secondary;
  }
}
</style>
