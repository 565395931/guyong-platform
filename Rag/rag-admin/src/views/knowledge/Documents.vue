<template>
  <div class="documents">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>文档管理</span>
          <div class="header-actions">
            <el-button @click="loadDocuments" :loading="loading">
              <el-icon><Refresh /></el-icon>
              刷新列表
            </el-button>
            <el-button type="danger" @click="batchDelete" :disabled="selectedDocuments.length === 0">
              <el-icon><Delete /></el-icon>
              批量删除 ({{ selectedDocuments.length }})
            </el-button>
            <el-button type="primary" @click="showUploadDialog">
              <el-icon><Plus /></el-icon>
              上传文档
            </el-button>
          </div>
        </div>
      </template>
      
      <el-tabs v-model="activeKnowledgeScope" class="scope-tabs" @tab-change="handleScopeTabChange">
        <el-tab-pane v-for="item in knowledgeScopeOptions" :key="item.value" :label="item.label" :name="item.value" />
      </el-tabs>

      <el-table 
        :data="filteredDocuments"
        style="width: 100%" 
        v-loading="loading"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="55" />
        <el-table-column prop="displayFileName" label="文档名称" min-width="220">
          <template #default="{ row }">
            <span>{{ row.displayFileName || row.fileName }}</span>
            <el-tag v-if="row.isChunkGroup" size="small" type="info" class="chunk-group-tag">
              {{ row.chunkCount }} 个切片
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="documentId" label="文件ID" min-width="180">
          <template #default="{ row }">
            <span v-if="row.isChunkGroup">{{ row.chunkCount }} 个切片文档</span>
            <span v-else>{{ row.documentId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="fileType" label="文件类型" width="100" />
        <el-table-column label="适用范围" width="110">
          <template #default="{ row }">
            {{ scopeLabel(row.knowledgeScope) }}
          </template>
        </el-table-column>
        <el-table-column label="适用渠道" width="130" show-overflow-tooltip>
          <template #default="{ row }">
            {{ channelLabels(row.knowledgeChannels).join(' / ') }}
          </template>
        </el-table-column>
        <el-table-column prop="size" label="文件大小" width="120">
          <template #default="{ row }">
            {{ formatFileSize(row.size) }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="gmtModified" label="更新时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.gmtModified) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="viewChunks(row)">切片详情</el-button>
            <el-button size="small" type="success" link :disabled="!row.downloadAvailable" @click="downloadDocument(row)">
              <el-icon><Download /></el-icon>
              下载
            </el-button>
            <el-button size="small" type="danger" link @click="deleteDocument(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    
    <!-- 上传对话框 -->
    <el-dialog 
      v-model="uploadDialogVisible" 
      title="上传文档到知识库" 
      width="800px"
      :close-on-click-modal="false"
    >
      <!-- 上传模式选择 -->
      <div class="upload-mode-selector">
        <span class="selector-label">上传模式：</span>
        <el-radio-group v-model="uploadMode" @change="handleModeChange">
          <el-radio value="aliyun">
            <span>阿里云知识库直接上传</span>
            <el-text type="info" size="small">（百炼自动解析处理）</el-text>
          </el-radio>
          <el-radio value="local">
            <span>本地解析+百炼上传</span>
            <el-text type="info" size="small">（自定义模板分块）</el-text>
          </el-radio>
        </el-radio-group>
      </div>
      
      <!-- 模式说明 -->
      <div class="mode-description">
        <el-text type="info" size="small">
          {{ uploadMode === 'aliyun' 
            ? '文件直接上传到阿里云百炼知识库，由百炼自动进行文档解析和索引。' 
            : '本地结构化解析 → 模板分块 → 向量化 → 上传百炼索引，完整处理链路。' }}
        </el-text>
      </div>

      <div class="upload-scope-banner">
        <span>适用范围：</span>
        <el-select v-model="uploadKnowledgeScope" style="width: 180px">
          <el-option v-for="item in knowledgeScopeOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </div>
      
      <!-- 模板选择（仅本地解析模式显示） -->
      <div v-if="uploadMode === 'local'" class="template-selector">
        <span class="selector-label">分块模板：</span>
        <el-select v-model="selectedTemplateId" placeholder="请选择分块模板" style="width: 300px">
          <el-option 
            v-for="template in templates" 
            :key="template.templateId" 
            :label="template.name + (template.isDefault ? ' (默认)' : '')" 
            :value="template.templateId"
          >
            <div class="template-option">
              <span>{{ template.name }}</span>
              <el-tag v-if="template.isDefault" type="success" size="small">默认</el-tag>
            </div>
          </el-option>
        </el-select>
        <el-button type="primary" link @click="showTemplateConfig">查看配置</el-button>
      </div>
      
      <el-upload
        ref="uploadRef"
        drag
        :auto-upload="false"
        :on-change="handleFileChange"
        :on-remove="handleFileRemove"
        :file-list="fileList"
        :limit="10"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md"
        multiple
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          拖拽文件到此处或<em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">
            支持 PDF、Word、Excel、PPT、TXT、Markdown 格式，单个文件最大50MB，最多10个文件
          </div>
        </template>
      </el-upload>
      
      <!-- 上传进度 -->
      <div v-if="uploading" class="upload-progress">
        <el-progress 
          :percentage="uploadProgress" 
          :status="uploadProgress === 100 ? 'success' : ''"
        />
        <div class="upload-status">{{ uploadStatusText }}</div>
      </div>
      
      <template #footer>
        <el-button @click="uploadDialogVisible = false" :disabled="uploading">取消</el-button>
        <el-button 
          type="primary" 
          @click="handleUpload" 
          :loading="uploading"
          :disabled="fileList.length === 0"
        >
          {{ uploading ? '上传中...' : '开始上传' }}
        </el-button>
      </template>
    </el-dialog>
    
    <!-- 上传结果对话框 -->
    <el-dialog 
      v-model="resultDialogVisible" 
      title="上传结果" 
      width="700px"
    >
      <el-table :data="uploadResults" style="width: 100%">
        <el-table-column prop="fileName" label="文件名" min-width="150" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : 'danger'">
              {{ row.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="chunkCount" label="分块数" width="100">
          <template #default="{ row }">
            <span v-if="row.chunkCount">{{ row.chunkCount }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="jobId" label="任务ID" min-width="180" />
        <el-table-column prop="error" label="错误信息" min-width="150">
          <template #default="{ row }">
            <span v-if="row.error" style="color: #f56c6c">{{ row.error }}</span>
          </template>
        </el-table-column>
      </el-table>
      
      <template #footer>
        <el-button type="primary" @click="closeResultDialog">确定</el-button>
      </template>
    </el-dialog>
    
    <!-- 分块预览对话框 -->
    <el-dialog 
      v-model="previewDialogVisible" 
      title="分块预览 - 确认后上传" 
      width="900px"
      :close-on-click-modal="false"
    >
      <!-- 统计信息 -->
      <el-descriptions :column="4" border class="preview-stats">
        <el-descriptions-item label="文件名">{{ previewData.fileName }}</el-descriptions-item>
        <el-descriptions-item label="适用范围">{{ scopeLabel(previewData.knowledgeScope) }}</el-descriptions-item>
        <el-descriptions-item label="适用渠道">{{ channelLabels(previewData.knowledgeChannels).join(' / ') }}</el-descriptions-item>
        <el-descriptions-item label="分块数量">{{ previewData.chunkStats?.total || 0 }}</el-descriptions-item>
        <el-descriptions-item label="平均长度">{{ previewData.chunkStats?.avgLength || 0 }} 字符</el-descriptions-item>
        <el-descriptions-item label="结构节点数">{{ previewData.structuredNodes || 0 }}</el-descriptions-item>
      </el-descriptions>
      
      <!-- 分块类型统计 -->
      <div class="chunk-type-stats">
        <span class="stats-label">分块类型：</span>
        <el-tag v-for="(count, type) in previewData.chunkStats?.byType" :key="type" class="type-tag">
          {{ type }}: {{ count }}
        </el-tag>
      </div>
      
      <!-- 分块列表 -->
      <el-table :data="previewData.chunks" style="width: 100%; margin-top: 15px" max-height="400">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="metadata.chunkType" label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.metadata?.chunkType || 'paragraph' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="metadata.chapterPath" label="章节路径" min-width="150">
          <template #default="{ row }">
            <span v-if="row.metadata?.chapterPath?.length">
              {{ row.metadata.chapterPath.join('/') }}
            </span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="内容预览" min-width="300">
          <template #default="{ row }">
            <div class="chunk-content-preview">
              {{ row.content?.substring(0, 150) }}{{ row.content?.length > 150 ? '...' : '' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="content.length" label="长度" width="80">
          <template #default="{ row }">
            {{ row.content?.length || 0 }}
          </template>
        </el-table-column>
      </el-table>
      
      <template #footer>
        <el-button @click="cancelPreview">取消</el-button>
        <el-button type="primary" @click="confirmUpload" :loading="confirmingUpload">
          确认上传到百炼
        </el-button>
      </template>
    </el-dialog>
    
    <!-- 模板配置详情对话框 -->
    <el-dialog 
      v-model="templateConfigVisible" 
      title="模板配置详情" 
      width="400px"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="模板名称">{{ selectedTemplate?.name }}</el-descriptions-item>
        <el-descriptions-item label="标题拆分层级">{{ selectedTemplate?.config?.maxHeadingLevel }}级</el-descriptions-item>
        <el-descriptions-item label="最大分块大小">{{ selectedTemplate?.config?.maxChunkSize }}字符</el-descriptions-item>
        <el-descriptions-item label="重叠字符数">{{ selectedTemplate?.config?.chunkOverlap }}字符</el-descriptions-item>
        <el-descriptions-item label="表格整块保留">{{ selectedTemplate?.config?.keepTableWhole ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="列表整块保留">{{ selectedTemplate?.config?.keepListWhole ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="注入章节路径">{{ selectedTemplate?.config?.injectHeadingPath ? '是' : '否' }}</el-descriptions-item>
      </el-descriptions>
      
      <template #footer>
        <el-button type="primary" @click="templateConfigVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 切片详情抽屉 -->
    <el-drawer
      v-model="chunkDrawerVisible"
      :title="'切片详情 - ' + (chunkDrawerDoc?.displayFileName || chunkDrawerDoc?.fileName)"
      size="70%"
      :destroy-on-close="true"
    >
      <div v-if="chunkDrawerDoc" class="chunk-drawer">
        <!-- 文档基本信息 -->
        <el-descriptions :column="3" border size="small" class="chunk-doc-info">
          <el-descriptions-item label="文档名称">{{ chunkDrawerDoc.displayFileName || chunkDrawerDoc.fileName }}</el-descriptions-item>
          <el-descriptions-item label="文件ID">{{ chunkDrawerDoc.isChunkGroup ? `${chunkDrawerDoc.chunkCount} 个切片文档` : chunkDrawerDoc.documentId }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(chunkDrawerDoc.status)" size="small">
              {{ getStatusText(chunkDrawerDoc.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="文件类型">{{ chunkDrawerDoc.fileType }}</el-descriptions-item>
          <el-descriptions-item label="文件大小">{{ formatFileSize(chunkDrawerDoc.size) }}</el-descriptions-item>
          <el-descriptions-item label="切片总数">{{ chunksTotal }}</el-descriptions-item>
        </el-descriptions>

        <!-- 切片列表 -->
        <div class="chunk-list-section">
          <div class="chunk-list-header">
            <span class="chunk-list-title">切片列表</span>
            <el-pagination
              v-model:current-page="chunksPage"
              v-model:page-size="chunksPageSize"
              :total="chunksTotal"
              :page-sizes="[10, 20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadChunks"
              @size-change="handleChunkSizeChange"
              small
            />
          </div>

          <div v-loading="chunksLoading" class="chunk-list-content">
            <div v-if="chunksList.length === 0 && !chunksLoading" class="chunk-empty">
              <el-empty description="暂无切片数据" />
            </div>
            <div v-else class="chunk-cards">
              <div v-for="(chunk, index) in chunksList" :key="index" class="chunk-card">
                <div class="chunk-card-header">
                  <span class="chunk-card-index">#{{ (chunksPage - 1) * chunksPageSize + index + 1 }}</span>
                  <el-tag v-if="chunk.metadata?.chunkType" size="small" type="info">
                    {{ chunk.metadata.chunkType }}
                  </el-tag>
                  <el-tag v-if="chunk.metadata?.chapterPath?.length" size="small" type="warning">
                    {{ chunk.metadata.chapterPath.join('/') }}
                  </el-tag>
                  <span class="chunk-card-length">{{ chunk.text?.length || 0 }} 字</span>
                </div>
                <div class="chunk-card-body">
                  <pre class="chunk-card-text">{{ chunk.text }}</pre>
                </div>
                <div v-if="chunk.metadata && Object.keys(chunk.metadata).length > 0" class="chunk-card-meta">
                  <el-descriptions :column="2" border size="small">
                    <el-descriptions-item v-for="(val, key) in filteredMetadata(chunk.metadata)" :key="key" :label="key">
                      {{ formatMetaValue(val) }}
                    </el-descriptions-item>
                  </el-descriptions>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, UploadFilled, Refresh, Delete, Download } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

const documents = ref([])
const uploadDialogVisible = ref(false)
const resultDialogVisible = ref(false)
const fileList = ref([])
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadStatusText = ref('')
const uploadResults = ref([])
const loading = ref(false)
const uploadRef = ref(null)

// 选中的文档（用于批量删除）
const selectedDocuments = ref([])

// 上传模式
const uploadMode = ref('aliyun') // 默认阿里云知识库直接上传
const activeKnowledgeScope = ref('overseas')
const uploadKnowledgeScope = ref('overseas')
const knowledgeScopeOptions = [
  { label: '国内业务', value: 'domestic' },
  { label: '海外业务', value: 'overseas' },
  { label: '通用', value: 'common' }
]

// 模板相关变量
const templates = ref([])
const selectedTemplateId = ref('default')
const selectedTemplate = ref(null)
const templateConfigVisible = ref(false)

// 分块预览相关变量
const previewDialogVisible = ref(false)
const previewData = ref({
  fileName: '',
  chunks: [],
  chunkStats: {},
  structuredNodes: 0,
  sourceArchiveId: null,
  knowledgeScope: 'overseas',
  knowledgeChannels: ['all']
})
const confirmingUpload = ref(false)

// 切片详情抽屉相关变量
const chunkDrawerVisible = ref(false)
const chunkDrawerDoc = ref(null)
const chunksList = ref([])
const chunksTotal = ref(0)
const chunksPage = ref(1)
const chunksPageSize = ref(10)
const chunksLoading = ref(false)

onMounted(async () => {
  loadDocuments()
})

const filteredDocuments = computed(() => {
  return groupedDocuments.value.filter(doc => (doc.knowledgeScope || 'overseas') === activeKnowledgeScope.value)
})

const groupedDocuments = computed(() => groupLocalChunkDocuments(documents.value))

const groupLocalChunkDocuments = (items = []) => {
  const groups = new Map()
  const result = []

  for (const doc of items) {
    if (doc.isChunkGroup) {
      result.push({
        ...doc,
        displayFileName: doc.displayFileName || doc.fileName,
        documentIds: doc.documentIds?.length ? doc.documentIds : (doc.documentId ? [doc.documentId] : []),
        chunkDocuments: doc.chunkDocuments || [],
        chunkCount: doc.chunkCount || doc.chunkDocuments?.length || 0
      })
      continue
    }

    const chunkInfo = parseLocalChunkFileName(doc.fileName)
    if (!chunkInfo) {
      result.push({
        ...doc,
        displayFileName: doc.fileName,
        documentIds: doc.documentId ? [doc.documentId] : [],
        chunkDocuments: [doc],
        chunkCount: 1
      })
      continue
    }

    const scope = doc.knowledgeScope || 'overseas'
    const groupKey = `${scope}::${chunkInfo.baseName}`
    if (!groups.has(groupKey)) {
      const group = {
        ...doc,
        displayFileName: `${chunkInfo.baseName}（本地解析）`,
        documentIds: [],
        chunkDocuments: [],
        chunkCount: 0,
        isChunkGroup: true,
        fileType: 'txt',
        size: 0
      }
      groups.set(groupKey, group)
      result.push(group)
    }

    const group = groups.get(groupKey)
    group.documentIds.push(doc.documentId)
    group.chunkDocuments.push({ ...doc, chunkIndex: chunkInfo.index })
    group.chunkCount += 1
    group.size += Number(doc.size) || 0
    group.downloadAvailable = group.downloadAvailable || doc.downloadAvailable
    if (new Date(doc.gmtModified || 0) > new Date(group.gmtModified || 0)) {
      group.gmtModified = doc.gmtModified
    }
    if (doc.status !== 'FINISH') {
      group.status = doc.status
    }
  }

  for (const item of result) {
    if (item.isChunkGroup) {
      item.chunkDocuments.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0))
      item.documentId = item.documentIds[0]
      item.fileName = item.chunkDocuments[0]?.fileName || item.fileName
    }
  }

  return result
}

const parseLocalChunkFileName = (fileName = '') => {
  const match = String(fileName).match(/^(.*)_chunk_(\d+)(?:\.txt)?$/i)
  if (!match) return null
  return {
    baseName: match[1],
    index: Number(match[2]) || 0
  }
}

// 加载模板列表
const loadTemplates = async () => {
  try {
    const res = await adminApi.getTemplates()
    if (res.data.success) {
      templates.value = res.data.data.templates || []
      // 设置默认模板
      const defaultTemplate = templates.value.find(t => t.isDefault)
      if (defaultTemplate) {
        selectedTemplateId.value = defaultTemplate.templateId
        selectedTemplate.value = defaultTemplate
      }
    }
  } catch (error) {
    console.error('加载模板列表失败:', error)
    // 如果模板列表加载失败，使用内置默认模板
    templates.value = [{
      templateId: 'default',
      name: '默认模板',
      isDefault: true,
      config: {
        maxHeadingLevel: 3,
        maxChunkSize: 800,
        chunkOverlap: 120,
        keepTableWhole: true,
        keepListWhole: true,
        injectHeadingPath: true
      }
    }]
    selectedTemplateId.value = 'default'
    selectedTemplate.value = templates.value[0]
  }
}

// 显示模板配置详情
const showTemplateConfig = () => {
  selectedTemplate.value = templates.value.find(t => t.templateId === selectedTemplateId.value)
  templateConfigVisible.value = true
}

const loadDocuments = async () => {
  loading.value = true
  try {
    const res = await adminApi.getDocuments({ pageSize: 500, aggregateLocalChunks: true })
    if (res.data.success) {
      documents.value = res.data.data.documents || []
    } else {
      documents.value = []
      ElMessage.warning(res.data.message || '获取文档列表失败')
    }
  } catch (error) {
    ElMessage.error('获取文档列表失败: ' + (error.message || '未知错误'))
    documents.value = []
  } finally {
    loading.value = false
  }
}

// 延迟刷新（用于操作完成后等待百炼后台处理）
const loadDocumentsWithDelay = (delayMs = 2000) => {
  return new Promise((resolve) => {
    setTimeout(async () => {
      await loadDocuments()
      resolve()
    }, delayMs)
  })
}

// 状态映射
const getStatusType = (status) => {
  const statusMap = {
    'FINISH': 'success',
    'RUNNING': 'warning',
    'INSERT_ERROR': 'danger',
    'DELETED': 'info'
  }
  return statusMap[status] || 'info'
}

const getStatusText = (status) => {
  const statusMap = {
    'FINISH': '导入成功',
    'RUNNING': '导入中',
    'INSERT_ERROR': '导入失败',
    'DELETED': '已删除'
  }
  return statusMap[status] || status
}

// 文件大小格式化
const formatFileSize = (bytes) => {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

// 时间格式化
const formatTime = (timestamp) => {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const getDownloadFileName = (response, fallbackName = 'document') => {
  const disposition = response.headers?.['content-disposition'] || ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch (error) {
      return utf8Match[1]
    }
  }
  const asciiMatch = disposition.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] || fallbackName
}

const saveBlobFile = (blob, fileName) => {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

const downloadDocument = async (row) => {
  if (!row.downloadAvailable) {
    ElMessage.warning('该文档没有可下载的本地源文件，请重新上传后再下载')
    return
  }

  try {
    const res = await adminApi.downloadDocument(row)
    const fileName = getDownloadFileName(res, row.displayFileName || row.fileName || 'document')
    saveBlobFile(res.data, fileName)
  } catch (error) {
    const blob = error.response?.data
    if (blob instanceof Blob) {
      try {
        const text = await blob.text()
        const parsed = JSON.parse(text)
        ElMessage.error(parsed.message || '下载失败')
        return
      } catch (parseError) {
        // 使用默认错误提示
      }
    }
    ElMessage.error('下载失败: ' + (error.message || '未知错误'))
  }
}

// 查看文档切片详情
const viewChunks = (row) => {
  chunkDrawerDoc.value = row
  chunksPage.value = 1
  chunksPageSize.value = 10
  chunksList.value = []
  chunksTotal.value = 0
  chunkDrawerVisible.value = true
  if (row.isChunkGroup) {
    chunksTotal.value = row.chunkDocuments.length
    chunksList.value = row.chunkDocuments.slice(0, chunksPageSize.value).map(doc => ({
      text: doc.fileName,
      metadata: {
        chunkType: 'local-upload-document',
        documentId: doc.documentId,
        status: getStatusText(doc.status),
        gmtModified: formatTime(doc.gmtModified)
      }
    }))
    return
  }
  loadChunks()
}

// 加载切片列表
const loadChunks = async () => {
  if (!chunkDrawerDoc.value?.documentId) return
  if (chunkDrawerDoc.value?.isChunkGroup) {
    const start = (chunksPage.value - 1) * chunksPageSize.value
    chunksList.value = chunkDrawerDoc.value.chunkDocuments
      .slice(start, start + chunksPageSize.value)
      .map(doc => ({
        text: doc.fileName,
        metadata: {
          chunkType: 'local-upload-document',
          documentId: doc.documentId,
          status: getStatusText(doc.status),
          gmtModified: formatTime(doc.gmtModified)
        }
      }))
    chunksTotal.value = chunkDrawerDoc.value.chunkDocuments.length
    return
  }
  chunksLoading.value = true
  try {
    const res = await adminApi.getDocumentChunks(
      chunkDrawerDoc.value.documentId,
      chunksPage.value,
      chunksPageSize.value
    )
    if (res.data.success) {
      chunksList.value = res.data.data.chunks || []
      chunksTotal.value = res.data.data.total || 0
    } else {
      ElMessage.warning(res.data.message || '获取切片数据失败')
      chunksList.value = []
      chunksTotal.value = 0
    }
  } catch (error) {
    ElMessage.error('获取切片数据失败: ' + (error.message || '未知错误'))
    chunksList.value = []
    chunksTotal.value = 0
  } finally {
    chunksLoading.value = false
  }
}

// 切片分页大小变更
const handleChunkSizeChange = () => {
  chunksPage.value = 1
  loadChunks()
}

// 过滤 metadata 中不需要展示的字段
const filteredMetadata = (metadata) => {
  const filtered = {}
  const skipKeys = ['chunkType', 'chapterPath'] // 这些已在卡片头部展示
  for (const [key, val] of Object.entries(metadata)) {
    if (!skipKeys.includes(key) && val !== undefined && val !== null) {
      filtered[key] = val
    }
  }
  return filtered
}

// 格式化 metadata 值
const formatMetaValue = (val) => {
  if (Array.isArray(val)) return val.join('/')
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

const getKnowledgeMeta = () => {
  return {
    knowledgeScope: uploadKnowledgeScope.value,
    knowledgeChannels: ['all']
  }
}

const scopeLabel = (value) => knowledgeScopeOptions.find(item => item.value === value)?.label || value || '-'
const channelLabels = (channels = []) => {
  const map = { all: '全部', whatsapp: 'WhatsApp', wechat: '微信', douyin: '抖音' }
  return (channels && channels.length ? channels : ['all']).map(channel => map[channel] || channel)
}

const handleScopeTabChange = () => {
  selectedDocuments.value = []
}

// 删除文档
const deleteDocument = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除文档 "${row.displayFileName || row.fileName}" 吗？删除后无法恢复。`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    const res = row.documentIds?.length > 1
      ? await adminApi.deleteDocuments(row.documentIds)
      : await adminApi.deleteDocument(row.documentId)
    if (res.data.success) {
      ElMessage.success('删除成功')
      loadDocumentsWithDelay()
    } else {
      ElMessage.error(res.data.message || '删除失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败: ' + (error.message || '未知错误'))
    }
  }
}

// 处理表格选择变化
const handleSelectionChange = (selection) => {
  selectedDocuments.value = selection
}

// 批量删除文档
const batchDelete = async () => {
  if (selectedDocuments.value.length === 0) {
    ElMessage.warning('请先选择要删除的文档')
    return
  }
  
  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedDocuments.value.length} 个文档吗？删除后无法恢复。`,
      '批量删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    // 批量删除
    const documentIds = selectedDocuments.value.flatMap(doc => doc.documentIds?.length ? doc.documentIds : [doc.documentId])
    const res = await adminApi.deleteDocuments(documentIds)
    
    if (res.data.success) {
      ElMessage.success(`成功删除 ${selectedDocuments.value.length} 个文档`)
      selectedDocuments.value = []
      loadDocumentsWithDelay()
    } else {
      ElMessage.error(res.data.message || '批量删除失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('批量删除失败: ' + (error.message || '未知错误'))
    }
  }
}

const showUploadDialog = async () => {
  fileList.value = []
  uploadProgress.value = 0
  uploadStatusText.value = ''
  uploadResults.value = []
  uploadMode.value = 'aliyun' // 默认阿里云知识库直接上传
  uploadKnowledgeScope.value = activeKnowledgeScope.value
  selectedTemplateId.value = 'default'
  selectedTemplate.value = null
  
  // 加载模板列表
  await loadTemplates()
  
  uploadDialogVisible.value = true
}

const handleModeChange = () => {
  // 模式切换时，如果是本地解析模式，需要加载模板
  if (uploadMode.value === 'local') {
    loadTemplates()
  }
}

const handleFileChange = (file, files) => {
  fileList.value = files
}

const handleFileRemove = (file, files) => {
  fileList.value = files
}

const handleUpload = async () => {
  if (fileList.value.length === 0) {
    ElMessage.warning('请选择要上传的文件')
    return
  }
  
  uploading.value = true
  uploadProgress.value = 0
  uploadStatusText.value = '准备上传...'
  const knowledgeMeta = getKnowledgeMeta()
  
  try {
    if (uploadMode.value === 'aliyun') {
      // ========== 阿里云知识库直接上传模式 ==========
      uploadStatusText.value = '正在上传到阿里云知识库...'
      uploadProgress.value = 20
      
      if (fileList.value.length === 1) {
        const file = fileList.value[0].raw
        
        uploadProgress.value = 40
        uploadStatusText.value = '正在解析文档...'
        
        const res = await adminApi.uploadFile(file, knowledgeMeta)
        
        uploadProgress.value = 80
        uploadStatusText.value = '正在加入索引...'
        
        if (res.data.success) {
          uploadProgress.value = 100
          uploadStatusText.value = '上传完成！'
          
          uploadResults.value = [{
            fileName: res.data.data.fileName,
            status: 'success',
            fileId: res.data.data.fileId,
            jobId: res.data.data.jobId
          }]
        } else {
          throw new Error(res.data.message || '上传失败')
        }
      } else {
        uploadStatusText.value = '正在批量上传...'
        uploadProgress.value = 30
        
        const files = fileList.value.map(f => f.raw)
        const res = await adminApi.uploadFiles(files, knowledgeMeta)
        
        uploadProgress.value = 100
        uploadStatusText.value = '批量上传完成！'
        
        uploadResults.value = res.data.data || []
      }
      
    } else {
      // ========== 本地解析 + 百炼上传模式（带预览）==========
      const currentTemplate = templates.value.find(t => t.templateId === selectedTemplateId.value)
      const templateConfig = currentTemplate?.config || null
      
      if (fileList.value.length === 1) {
        // 单文件：先预览分块，用户确认后再上传
        uploadStatusText.value = '正在结构化解析和分块...'
        uploadProgress.value = 50
        
        const file = fileList.value[0].raw
        
        // 调用预览接口（只解析，不上传）
        const res = await adminApi.previewChunks(file, selectedTemplateId.value, templateConfig, knowledgeMeta)
        
        if (res.data.success) {
          uploadProgress.value = 100
          uploadStatusText.value = '分块预览完成！'
          
          // 存储预览数据
          previewData.value = {
            fileName: res.data.data.fileName,
            chunks: res.data.data.chunks,
            chunkStats: res.data.data.chunkStats,
            structuredNodes: res.data.data.structuredNodes,
            templateId: selectedTemplateId.value,
            sourceArchiveId: res.data.data.sourceArchiveId || null,
            knowledgeScope: res.data.data.knowledgeScope || knowledgeMeta.knowledgeScope,
            knowledgeChannels: res.data.data.knowledgeChannels || knowledgeMeta.knowledgeChannels
          }
          
          // 关闭上传对话框，显示预览对话框
          uploadDialogVisible.value = false
          previewDialogVisible.value = true
        } else {
          throw new Error(res.data.message || '预览失败')
        }
      } else {
        // 多文件批量：不预览，直接上传
        uploadStatusText.value = '正在批量处理...'
        uploadProgress.value = 30
        
        const files = fileList.value.map(f => f.raw)
        const res = await adminApi.uploadToBailianBatch(files, selectedTemplateId.value, templateConfig, knowledgeMeta)
        
        uploadProgress.value = 100
        uploadStatusText.value = '批量处理完成！'
        
        uploadResults.value = res.data.data || []
        
        // 显示上传结果
        uploadDialogVisible.value = false
        resultDialogVisible.value = true
        activeKnowledgeScope.value = uploadKnowledgeScope.value
        loadDocumentsWithDelay(3000)
      }
    }
    
    // 阿里云模式的后续处理
    if (uploadMode.value === 'aliyun') {
      // 显示上传结果
      uploadDialogVisible.value = false
      resultDialogVisible.value = true
      activeKnowledgeScope.value = uploadKnowledgeScope.value
      
      // 延迟刷新文档列表
      loadDocumentsWithDelay(3000)
    }
    
  } catch (error) {
    console.error('上传失败:', error)
    uploadProgress.value = 0
    uploadStatusText.value = '上传失败: ' + (error.message || '未知错误')
    
    uploadResults.value = [{
      fileName: fileList.value[0]?.name || '未知文件',
      status: 'failed',
      error: error.message || '上传失败'
    }]
    
    uploadDialogVisible.value = false
    resultDialogVisible.value = true
    
  } finally {
    uploading.value = false
  }
}

const closeResultDialog = () => {
  resultDialogVisible.value = false
  // 清空上传列表
  fileList.value = []
  if (uploadRef.value) {
    uploadRef.value.clearFiles()
  }
}

// 取消预览（不上传）
const cancelPreview = () => {
  previewDialogVisible.value = false
  // 清空预览数据
  previewData.value = {
    fileName: '',
    chunks: [],
    chunkStats: {},
    structuredNodes: 0,
    sourceArchiveId: null,
    knowledgeScope: uploadKnowledgeScope.value,
    knowledgeChannels: ['all']
  }
  // 清空上传列表
  fileList.value = []
  if (uploadRef.value) {
    uploadRef.value.clearFiles()
  }
  ElMessage.info('已取消上传')
}

// 确认上传（从预览数据上传到百炼）
const confirmUpload = async () => {
  if (!previewData.value.chunks || previewData.value.chunks.length === 0) {
    ElMessage.warning('分块数据为空')
    return
  }
  
  confirmingUpload.value = true
  
  try {
    // 调用确认上传接口
    const res = await adminApi.confirmUpload(
      previewData.value.chunks,
      previewData.value.fileName,
      false, // 不等待索引完成
      previewData.value.sourceArchiveId,
      {
        knowledgeScope: previewData.value.knowledgeScope,
        knowledgeChannels: previewData.value.knowledgeChannels
      }
    )
    
    if (res.data.success) {
      ElMessage.success(`成功上传 ${res.data.data.uploadedCount} 个分块到百炼`)
      
      // 关闭预览对话框
      previewDialogVisible.value = false
      
      // 设置上传结果
      uploadResults.value = [{
        fileName: res.data.data.fileName,
        status: 'success',
        chunkCount: res.data.data.uploadedCount,
        jobId: res.data.data.jobId
      }]
      
      // 显示结果对话框
      resultDialogVisible.value = true
      activeKnowledgeScope.value = previewData.value.knowledgeScope
      
      // 延迟刷新文档列表
      loadDocumentsWithDelay(3000)
      
      // 清空预览数据
      previewData.value = {
        fileName: '',
        chunks: [],
        chunkStats: {},
        structuredNodes: 0,
        sourceArchiveId: null,
        knowledgeScope: uploadKnowledgeScope.value,
        knowledgeChannels: ['all']
      }
      
      // 清空上传列表
      fileList.value = []
      if (uploadRef.value) {
        uploadRef.value.clearFiles()
      }
    } else {
      throw new Error(res.data.message || '上传失败')
    }
  } catch (error) {
    ElMessage.error('上传失败: ' + (error.message || '未知错误'))
  } finally {
    confirmingUpload.value = false
  }
}
</script>

<style scoped lang="scss">
.documents {
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    
    .header-actions {
      display: flex;
      gap: 10px;
    }
  }
  
  .upload-mode-selector {
    margin-bottom: 15px;
    padding: 15px;
    background: #fdf6ec;
    border-radius: 4px;
    
    .selector-label {
      font-weight: 500;
      color: #303133;
      margin-right: 15px;
    }
    
    .el-radio-group {
      display: flex;
      flex-direction: row;
      gap: 30px;

      .el-radio {
        display: flex;
        align-items: center;
        gap: 8px;

        span {
          font-weight: 500;
        }
      }
    }
  }
  
  .mode-description {
    margin-bottom: 15px;
    padding: 10px 15px;
    background: #ecf5ff;
    border-radius: 4px;
  }

  .scope-tabs {
    margin-bottom: 12px;
  }

  .upload-scope-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 15px;
    padding: 12px 15px;
    background: #f5f7fa;
    border-radius: 4px;
  }
  
  .template-selector {
    margin-bottom: 15px;
    padding: 15px;
    background: #f0f9eb;
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 15px;
    
    .selector-label {
      font-weight: 500;
      color: #303133;
    }
    
    .template-option {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }
  
  .upload-progress {
    margin-top: 20px;
    padding: 15px;
    background: #f5f7fa;
    border-radius: 4px;
    
    .upload-status {
      margin-top: 10px;
      text-align: center;
      color: #606266;
      font-size: 14px;
    }
  }
  
  .el-upload__tip {
    color: #909399;
    font-size: 12px;
    margin-top: 7px;
  }
  
  // 分块预览对话框样式
  .preview-stats {
    margin-bottom: 15px;
  }
  
  .chunk-type-stats {
    margin-top: 10px;
    
    .stats-label {
      font-weight: 500;
      margin-right: 10px;
    }
    
    .type-tag {
      margin-right: 8px;
    }
  }
  
  .chunk-content-preview {
    font-size: 13px;
    color: #606266;
    line-height: 1.5;
  }

  // 切片详情抽屉样式
  .chunk-drawer {
    .chunk-doc-info {
      margin-bottom: 20px;
    }

    .chunk-list-section {
      .chunk-list-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
        padding-bottom: 10px;
        border-bottom: 1px solid #ebeef5;

        .chunk-list-title {
          font-size: 16px;
          font-weight: 600;
          color: #303133;
        }
      }

      .chunk-list-content {
        min-height: 200px;
      }

      .chunk-empty {
        padding: 40px 0;
      }

      .chunk-cards {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .chunk-card {
        border: 1px solid #e4e7ed;
        border-radius: 8px;
        overflow: hidden;
        transition: border-color 0.2s;

        &:hover {
          border-color: #409eff;
        }

        .chunk-card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          background: #f5f7fa;
          border-bottom: 1px solid #e4e7ed;

          .chunk-card-index {
            font-weight: 700;
            color: #409eff;
            font-size: 14px;
          }

          .chunk-card-length {
            color: #909399;
            font-size: 12px;
            margin-left: auto;
          }
        }

        .chunk-card-body {
          padding: 16px;

          .chunk-card-text {
            font-size: 14px;
            line-height: 1.8;
            color: #303133;
            white-space: pre-wrap;
            word-wrap: break-word;
            margin: 0;
            font-family: inherit;
            max-height: 300px;
            overflow-y: auto;
          }
        }

        .chunk-card-meta {
          padding: 10px 16px;
          background: #fafafa;
          border-top: 1px solid #e4e7ed;
        }
      }
    }
  }
}
</style>
