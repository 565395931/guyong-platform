<template>
  <div class="media-files-page">
    <div class="page-header">
      <div>
        <h2>文件上传</h2>
        <p>上传图片、视频和文件，供聚合工作台选择后发送给客户。</p>
      </div>
      <el-button type="primary" :icon="Upload" @click="uploadDialogVisible = true">上传文件</el-button>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" :model="query" @submit.prevent>
        <el-form-item label="类型">
          <el-select v-model="query.mediaType" placeholder="全部类型" clearable style="width: 140px" @change="fetchFiles">
            <el-option label="图片" value="image" />
            <el-option label="视频" value="video" />
            <el-option label="语音" value="audio" />
            <el-option label="文件" value="file" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="query.keyword" placeholder="搜索文件名" clearable style="width: 240px" @keyup.enter="fetchFiles" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="fetchFiles">查询</el-button>
          <el-button @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="files" style="width: 100%">
        <el-table-column label="预览" width="100">
          <template #default="{ row }">
            <div class="file-preview" :class="`file-preview--${row.mediaType}`">
              <img v-if="row.mediaType === 'image'" :src="row.url" :alt="row.originalName" />
              <el-icon v-else-if="row.mediaType === 'video'"><VideoPlay /></el-icon>
              <el-icon v-else><Document /></el-icon>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="文件名" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="file-name-cell">
              <div class="file-name-cell__display">{{ row.displayName || row.originalName }}</div>
              <div v-if="row.displayName && row.displayName !== row.originalName" class="file-name-cell__original">原始：{{ row.originalName }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="file-description">{{ row.description || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="typeTag(row.mediaType)" effect="plain">{{ typeLabel(row.mediaType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="mimeType" label="MIME" min-width="150" show-overflow-tooltip />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="上传时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="editFile(row)">编辑</el-button>
            <el-button link type="primary" @click="copyUrl(row.fullUrl)">复制URL</el-button>
            <el-button link type="primary" @click="openFile(row.fullUrl)">打开</el-button>
            <el-button link type="danger" @click="deleteFile(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="fetchFiles"
          @current-change="fetchFiles"
        />
      </div>
    </el-card>

    <el-dialog v-model="editDialogVisible" title="编辑文件信息" width="520px">
      <el-form label-position="top" :model="editForm">
        <el-form-item label="文件名">
          <el-input v-model="editForm.displayName" maxlength="255" show-word-limit placeholder="请输入展示文件名" />
        </el-form-item>
        <el-form-item label="文件描述">
          <el-input
            v-model="editForm.description"
            type="textarea"
            :rows="5"
            maxlength="2000"
            show-word-limit
            placeholder="请输入文件描述，便于客服在工作台选择文件"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false" :disabled="savingEdit">取消</el-button>
        <el-button type="primary" :loading="savingEdit" @click="saveFileEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="uploadDialogVisible" title="上传可发送文件" width="560px">
      <el-upload
        ref="uploadRef"
        drag
        :auto-upload="false"
        multiple
        :limit="50"
        :on-change="handleFileChange"
        :on-remove="handleFileRemove"
        :file-list="uploadFileList"
        accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.m4v,.webm,.mp3,.m4a,.aac,.wav,.ogg,.opus,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.zip,.rar"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖拽文件到此处，或 <em>点击选择</em></div>
        <template #tip>
          <div class="el-upload__tip">支持一次选择多个文件，最多 50 个；单文件最大 100MB。</div>
        </template>
      </el-upload>
      <template #footer>
        <el-button @click="uploadDialogVisible = false" :disabled="uploading">取消</el-button>
        <el-button type="primary" :loading="uploading" :disabled="selectedFiles.length === 0" @click="submitUpload">
          上传{{ selectedFiles.length ? ` ${selectedFiles.length} 个文件` : '' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Upload, UploadFilled, Search, VideoPlay, Document } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { adminApi } from '@/api/admin'

const loading = ref(false)
const uploading = ref(false)
const uploadDialogVisible = ref(false)
const editDialogVisible = ref(false)
const savingEdit = ref(false)
const uploadRef = ref(null)
const selectedFiles = ref([])
const uploadFileList = ref([])
const files = ref([])
const total = ref(0)
const editingFile = ref(null)
const editForm = reactive({
  displayName: '',
  description: ''
})

const query = reactive({
  mediaType: '',
  keyword: '',
  page: 1,
  pageSize: 20
})

const fetchFiles = async () => {
  loading.value = true
  try {
    const res = await adminApi.getMediaFiles(query)
    const data = res.data?.data || res.data || {}
    files.value = data.list || []
    total.value = data.total || 0
  } catch (err) {
    ElMessage.error('获取文件列表失败: ' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

const resetQuery = () => {
  query.mediaType = ''
  query.keyword = ''
  query.page = 1
  fetchFiles()
}

const syncSelectedFiles = (fileList) => {
  uploadFileList.value = fileList
  selectedFiles.value = fileList.map(item => item.raw).filter(Boolean)
}

const handleFileChange = (file, fileList) => {
  syncSelectedFiles(fileList)
}

const handleFileRemove = (file, fileList) => {
  syncSelectedFiles(fileList)
}

const resetUploadState = () => {
  selectedFiles.value = []
  uploadFileList.value = []
  uploadRef.value?.clearFiles()
}

const submitUpload = async () => {
  if (selectedFiles.value.length === 0) return
  uploading.value = true
  try {
    const filesToUpload = [...selectedFiles.value]
    if (filesToUpload.length === 1) {
      await adminApi.uploadMediaFile(filesToUpload[0])
    } else {
      await adminApi.uploadMediaFiles(filesToUpload)
    }
    ElMessage.success(filesToUpload.length === 1 ? '上传成功' : `成功上传 ${filesToUpload.length} 个文件`)
    uploadDialogVisible.value = false
    resetUploadState()
    query.page = 1
    fetchFiles()
  } catch (err) {
    ElMessage.error('上传失败: ' + (err.message || '未知错误'))
  } finally {
    uploading.value = false
  }
}

const editFile = (row) => {
  editingFile.value = row
  editForm.displayName = row.displayName || row.originalName || ''
  editForm.description = row.description || ''
  editDialogVisible.value = true
}

const saveFileEdit = async () => {
  if (!editingFile.value?.id || savingEdit.value) return
  const displayName = editForm.displayName.trim()
  if (!displayName) {
    ElMessage.warning('文件名不能为空')
    return
  }

  savingEdit.value = true
  try {
    await adminApi.updateMediaFile(editingFile.value.id, {
      displayName,
      description: editForm.description.trim()
    })
    ElMessage.success('保存成功')
    editDialogVisible.value = false
    editingFile.value = null
    fetchFiles()
  } catch (err) {
    ElMessage.error('保存失败: ' + (err.message || '未知错误'))
  } finally {
    savingEdit.value = false
  }
}

const deleteFile = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除文件「${row.originalName}」？删除后工作台将无法再选择该文件。`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await adminApi.deleteMediaFile(row.id)
    ElMessage.success('删除成功')
    fetchFiles()
  } catch (err) {
    if (err !== 'cancel' && err?.message !== 'cancel') {
      ElMessage.error('删除失败: ' + (err.message || '未知错误'))
    }
  }
}

const copyUrl = async (url) => {
  await navigator.clipboard.writeText(url)
  ElMessage.success('已复制 URL')
}

const openFile = (url) => {
  window.open(url, '_blank')
}

const typeLabel = (type) => ({ image: '图片', video: '视频', audio: '语音', file: '文件' }[type] || type)
const typeTag = (type) => ({ image: 'success', video: 'warning', audio: 'primary', file: 'info' }[type] || 'info')
const formatTime = (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm') : '-'
const formatSize = (size) => {
  const n = Number(size || 0)
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

onMounted(fetchFiles)
</script>

<style scoped lang="scss">
.media-files-page {
  padding: 24px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;

  h2 {
    margin: 0 0 6px;
    color: #1e293b;
    font-size: 24px;
  }

  p {
    margin: 0;
    color: #64748b;
    font-size: 14px;
  }
}

.filter-card {
  margin-bottom: 16px;
}

.table-card {
  :deep(.el-card__body) {
    padding-bottom: 12px;
  }
}

.file-name-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;

  &__display {
    font-weight: 600;
    color: #1e293b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__original {
    font-size: 12px;
    color: #94a3b8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.file-description {
  color: #64748b;
}

.file-preview {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #f1f5f9;
  color: #64748b;
  border: 1px solid #e2e8f0;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .el-icon {
    font-size: 24px;
  }

  &--image { background: #f0fdf4; color: #16a34a; }
  &--video { background: #fffbeb; color: #d97706; }
  &--file { background: #f8fafc; color: #475569; }
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}
</style>
