<template>
  <div class="chat-input">
    <div class="chat-input__editor-wrap">
      <el-input
        v-model="text"
        type="textarea"
        :disabled="props.disabled"
        :autosize="{ minRows: 3, maxRows: 8 }"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行；输入 / 调用快捷指令"
        resize="none"
        @keydown.ctrl.enter="handleSend"
        @input="handleTextInput"
        @keydown.down="moveQuickReplyActive(1, $event)"
        @keydown.up="moveQuickReplyActive(-1, $event)"
        @keydown.enter.exact="handleEnter"
        @keydown.esc="closeQuickReplyPanel"
      />
      <div v-if="quickReplyPanelOpen" class="chat-input__quick-panel">
        <div class="chat-input__quick-header">
          <span>快捷指令</span>
          <small>{{ quickReplyQuery ? `搜索：${quickReplyQuery}` : '输入关键词筛选' }}</small>
        </div>
        <div class="chat-input__quick-list" v-loading="quickReplyLoading">
          <el-empty v-if="!quickReplyLoading && quickReplies.length === 0" description="暂无匹配指令" :image-size="40" />
          <div
            v-for="(item, index) in quickReplies"
            :key="item.id"
            class="chat-input__quick-item"
            :class="{ 'is-active': quickReplyActiveIndex === index }"
            @mousedown.prevent="selectQuickReply(item)"
          >
            <div class="chat-input__quick-main">
              <div class="chat-input__quick-title">
                <el-tag size="small" effect="plain">{{ item.shortcut }}</el-tag>
                <span>{{ item.title }}</span>
              </div>
              <div class="chat-input__quick-content">{{ item.content }}</div>
            </div>
            <el-tag v-if="item.category" size="small" type="info" effect="plain">{{ item.category }}</el-tag>
          </div>
        </div>
        <div class="chat-input__quick-footer">↑↓ 选择，Enter 填入，Shift+Enter 换行，Esc 关闭</div>
      </div>
    </div>
    <div v-if="selectedFile" class="chat-input__selected-file">
      <div class="chat-input__file-info">
        <img
          v-if="selectedFile?.mediaType === 'image'"
          :src="selectedFile?.url"
          class="chat-input__file-thumb"
          alt=""
        />
        <el-icon v-else-if="selectedFile?.mediaType === 'video'"><VideoPlay /></el-icon>
        <el-icon v-else><Document /></el-icon>
        <span :title="selectedFile?.displayName || selectedFile?.originalName">{{ selectedFile?.displayName || selectedFile?.originalName }}</span>
      </div>
      <el-button text size="small" type="danger" @click="clearSelectedFile">移除</el-button>
    </div>
    <div class="chat-input__toolbar">
      <div class="chat-input__left">
        <el-popover trigger="click" width="200" placement="top-start">
          <template #reference>
            <el-button circle size="small"><el-icon><ChatLineSquare /></el-icon></el-button>
          </template>
          <div class="chat-input__emojis">
            <span v-for="e in emojis" :key="e" @click="text += e">{{ e }}</span>
          </div>
        </el-popover>
        <el-upload
          :show-file-list="false"
          :auto-upload="false"
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar"
          @change="handleLocalUpload"
        >
          <el-button circle size="small"><el-icon><Paperclip /></el-icon></el-button>
        </el-upload>
        <el-button
          circle
          size="small"
          :type="filePanelOpen ? 'primary' : 'default'"
          @click="toggleFilePanel"
        >
          <el-icon><Folder /></el-icon>
        </el-button>
      </div>
      <div class="chat-input__right">
        <el-tooltip content="将输入内容翻译为客户语言并发送" placement="top">
          <el-button
            size="small"
            :icon="Switch"
            :loading="props.sendingMode === 'translate'"
            :disabled="!canTranslateAndSend"
            @click="handleTranslateAndSend"
          >翻译并发送</el-button>
        </el-tooltip>
        <el-button
          type="primary"
          size="small"
          :icon="Position"
          :loading="props.sendingMode === 'send'"
          :disabled="!canSend"
          @click="handleSend"
        >发送</el-button>
      </div>
    </div>
    <div v-if="filePanelOpen" class="chat-input__file-strip">
      <div class="chat-input__file-strip-controls">
        <el-select v-model="query.mediaType" size="small" clearable placeholder="全部类型" @change="fetchFiles">
          <el-option label="图片" value="image" />
          <el-option label="视频" value="video" />
          <el-option label="语音" value="audio" />
          <el-option label="文件" value="file" />
        </el-select>
        <el-autocomplete
          v-model="query.keyword"
          size="small"
          clearable
          placeholder="搜索文件"
          :fetch-suggestions="searchHistorySuggest"
          :trigger-on-focus="false"
          @keyup.enter="onSearch"
          @clear="onSearch"
          @select="onSearch"
        >
          <template #append>
            <el-button :icon="Search" @click="onSearch" />
          </template>
        </el-autocomplete>
      </div>
      <div class="chat-input__file-library" v-loading="loading">
        <el-empty v-if="!loading && fileList.length === 0" description="暂无可选文件" :image-size="40" />
        <div v-for="file in fileList" :key="file.id" class="chat-input__file-item" :class="{ 'is-selected': selectedFile?.id === file.id }">
          <div class="chat-input__file-item-thumb">
            <img v-if="file.mediaType === 'image'" :src="file.url" :alt="file.displayName || file.originalName" />
            <el-icon v-else-if="file.mediaType === 'video'"><VideoPlay /></el-icon>
            <el-icon v-else><Document /></el-icon>
          </div>
          <div class="chat-input__file-item-main">
            <div class="chat-input__file-item-name" :title="file.displayName || file.originalName">{{ file.displayName || file.originalName }}</div>
            <div v-if="file.description" class="chat-input__file-item-desc" :title="file.description">{{ file.description }}</div>
          </div>
          <el-button size="small" :type="selectedFile?.id === file.id ? 'default' : 'primary'" plain @click="handleLibrarySelect(file)">选择</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import { Position, Switch, ChatLineSquare, VideoPlay, Document, Search, Folder, Paperclip } from '@element-plus/icons-vue'
import { getMediaFiles, uploadMediaFile, getQuickReplies, useQuickReply } from '@/api/messages'
import { ElMessage } from 'element-plus'

const props = defineProps({
  disabled: { type: Boolean, default: false },
  sendingMode: { type: String, default: '' }
})

const emit = defineEmits(['send'])
const text = ref('')
const selectedFile = ref(null)
const fileList = ref([])
const loading = ref(false)
const filePanelOpen = ref(false)
const quickReplyPanelOpen = ref(false)
const quickReplyLoading = ref(false)
const quickReplies = ref([])
const quickReplyQuery = ref('')
const quickReplyActiveIndex = ref(0)
let quickReplyTimer = null
const emojis = ['😀', '😃', '😄', '😁', '🙂', '😊', '👍', '👌', '🎉', '❤️']

const query = reactive({
  mediaType: '',
  keyword: '',
  page: 1,
  pageSize: 20
})

const STORAGE_KEY = 'chatinput_file_search_history'

// ---- 搜索历史（localStorage）----
const loadSearchHistory = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

const saveSearchHistory = (keyword) => {
  if (!keyword) return
  const history = loadSearchHistory().filter(h => h !== keyword)
  history.unshift(keyword)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 20)))
}

const searchHistorySuggest = (queryString, cb) => {
  const all = loadSearchHistory()
  if (!queryString) return cb(all.map(v => ({ value: v })))
  const results = all.filter(v => v.toLowerCase().includes(queryString.toLowerCase()))
  cb(results.map(v => ({ value: v })))
}

const onSearch = () => {
  if (query.keyword) saveSearchHistory(query.keyword)
  fetchFiles()
}

const canSend = computed(() => !props.disabled && Boolean(text.value.trim() || selectedFile.value))
const canTranslateAndSend = computed(() =>
  !props.disabled && !selectedFile.value && Boolean(text.value.trim())
)

const getCurrentCommand = () => {
  const value = text.value || ''
  const textarea = document.querySelector('.chat-input textarea')
  const cursor = textarea?.selectionStart ?? value.length
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)\/([^\s]*)$/)
  if (!match) return null
  return {
    keyword: match[1] || '',
    start: beforeCursor.length - match[0].trimStart().length,
    end: cursor
  }
}

const focusTextarea = () => {
  nextTick(() => {
    const textarea = document.querySelector('.chat-input textarea')
    if (textarea) textarea.focus()
  })
}

const fetchQuickReplyList = async () => {
  quickReplyLoading.value = true
  try {
    const res = await getQuickReplies({
      keyword: quickReplyQuery.value || undefined,
      enabledOnly: 'true',
      page: 1,
      pageSize: 8
    })
    const data = res.data || res || {}
    quickReplies.value = data.list || data.data?.list || []
    quickReplyActiveIndex.value = 0
  } catch (err) {
    console.error('[ChatInput] 获取快捷指令失败:', err)
    quickReplies.value = []
  } finally {
    quickReplyLoading.value = false
  }
}

const openQuickReplyPanel = () => {
  quickReplyPanelOpen.value = true
  filePanelOpen.value = false
  if (quickReplyTimer) clearTimeout(quickReplyTimer)
  quickReplyTimer = setTimeout(fetchQuickReplyList, 180)
}

const closeQuickReplyPanel = () => {
  quickReplyPanelOpen.value = false
}

const handleTextInput = () => {
  const command = getCurrentCommand()
  if (!command) {
    closeQuickReplyPanel()
    return
  }
  quickReplyQuery.value = command.keyword
  openQuickReplyPanel()
}

const moveQuickReplyActive = (step, event) => {
  if (!quickReplyPanelOpen.value || quickReplies.value.length === 0) return
  event?.preventDefault()
  const total = quickReplies.value.length
  quickReplyActiveIndex.value = (quickReplyActiveIndex.value + step + total) % total
}

const handleEnter = (event) => {
  if (event?.isComposing || event?.keyCode === 229) return
  event?.preventDefault()

  if (!quickReplyPanelOpen.value) {
    handleSend()
    return
  }

  const item = quickReplies.value[quickReplyActiveIndex.value]
  if (!item) return
  selectQuickReply(item)
}

const selectQuickReply = async (item) => {
  const command = getCurrentCommand()
  const value = text.value || ''
  if (command) {
    text.value = `${value.slice(0, command.start)}${item.content}${value.slice(command.end)}`
  } else {
    text.value = item.content
  }
  closeQuickReplyPanel()
  focusTextarea()
  try {
    await useQuickReply(item.id)
  } catch (err) {
    console.warn('[ChatInput] 记录快捷指令使用失败:', err)
  }
}

// ---- 折叠/展开文件面板 ----
const toggleFilePanel = () => {
  filePanelOpen.value = !filePanelOpen.value
  if (filePanelOpen.value) fetchFiles()
}

// ---- 文件列表拉取 ----
const fetchFiles = async () => {
  loading.value = true
  try {
    const res = await getMediaFiles({
      mediaType: query.mediaType || undefined,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize
    })
    const data = res.data || res || {}
    fileList.value = data.list || data.data?.list || []
  } catch (err) {
    console.error('[ChatInput] 获取文件列表失败:', err)
    fileList.value = []
  } finally {
    loading.value = false
  }
}

// ---- 从文件列表选择文件 ----
const handleLibrarySelect = (file) => {
  if (!file) return
  selectedFile.value = file
  nextTick(() => {
    const textarea = document.querySelector('.chat-input textarea')
    if (textarea) textarea.focus()
  })
}

// ---- 自行上传本地文件（先上传到后台，再选为发送附件）----
const uploadLoading = ref(false)
const handleLocalUpload = async (uploadFile) => {
  const raw = uploadFile?.raw
  if (!raw) return

  uploadLoading.value = true
  try {
    const res = await uploadMediaFile(raw)
    const payload = res.data || res || {}
    const uploaded = payload.file || payload.data?.file || payload.list?.[0] || payload.data?.list?.[0] || payload
    if (!uploaded?.url && !uploaded?.fullUrl) {
      throw new Error('上传成功但未返回文件访问地址')
    }
    // 用后台返回的完整信息替换
    selectedFile.value = {
      id: uploaded.id,
      displayName: uploaded.displayName || uploaded.originalName || raw.name,
      originalName: uploaded.originalName || raw.name,
      mediaType: uploaded.mediaType || getMediaTypeFromMime(raw.type, raw.name),
      mimeType: uploaded.mimeType || raw.type || 'application/octet-stream',
      size: uploaded.size || raw.size,
      url: uploaded.url,
      fullUrl: uploaded.fullUrl || uploaded.url,
      description: uploaded.description || '',
      _local: false
    }
    ElMessage.success('文件已上传')
  } catch (err) {
    ElMessage.error('上传失败: ' + (err.message || '未知错误'))
  } finally {
    uploadLoading.value = false
  }
}

const getMediaTypeFromMime = (mimeType, filename) => {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  const ext = (filename || '').split('.').pop()?.toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus'].includes(ext)) return 'audio'
  return 'file'
}

const clearSelectedFile = () => {
  selectedFile.value = null
}

const handleExternalFileSelect = (event) => {
  selectedFile.value = event.detail || null
}

const handleSend = () => {
  if (props.disabled) return
  if (quickReplyPanelOpen.value) return
  if (!canSend.value) return
  if (selectedFile.value) {
    emit('send', {
      type: selectedFile.value.mediaType || 'file',
      caption: text.value.trim(),
      file: selectedFile.value
    })
    text.value = ''
    selectedFile.value = null
    filePanelOpen.value = false
    return
  }
  emit('send', text.value.trim())
  text.value = ''
}

const handleTranslateAndSend = () => {
  if (!canTranslateAndSend.value || quickReplyPanelOpen.value) return
  emit('send', {
    text: text.value.trim(),
    translateToCustomerLanguage: true
  })
}

onMounted(() => {
  window.addEventListener('workbench:file-selected', handleExternalFileSelect)
})

onBeforeUnmount(() => {
  window.removeEventListener('workbench:file-selected', handleExternalFileSelect)
  if (quickReplyTimer) clearTimeout(quickReplyTimer)
})

defineExpose({
  setText: (val) => { text.value = val || '' },
  getText: () => text.value,
  clearTextIfMatches: (val) => {
    if (text.value.trim() === String(val || '').trim()) {
      text.value = ''
    }
  },
  setFile: (file) => { selectedFile.value = file || null },
  focusEnd: () => {
    nextTick(() => {
      const textarea = document.querySelector('.chat-input textarea')
      if (textarea) {
        textarea.focus()
        const len = text.value.length
        textarea.setSelectionRange(len, len)
      }
    })
  }
})
</script>

<style lang="scss" scoped>
.chat-input {
  border-top: 1px solid #e2e8f0;
  padding: 8px 12px;

  &__editor-wrap {
    position: relative;
  }
  &__quick-panel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 20;
    border: 1px solid #bfdbfe;
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 16px 40px rgba(15, 23, 42, .16);
    overflow: hidden;
  }
  &__quick-header,
  &__quick-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    background: #f8fafc;
    color: #334155;
    font-size: 12px;
    border-bottom: 1px solid #e2e8f0;

    small {
      color: #94a3b8;
      font-weight: 400;
    }
  }
  &__quick-footer {
    justify-content: flex-start;
    border-top: 1px solid #e2e8f0;
    border-bottom: 0;
    color: #94a3b8;
  }
  &__quick-list {
    max-height: 260px;
    overflow: auto;
    padding: 6px;
  }
  &__quick-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px;
    border-radius: 8px;
    cursor: pointer;
    transition: background .15s, border-color .15s;

    &:hover,
    &.is-active {
      background: #eff6ff;
    }
  }
  &__quick-main {
    min-width: 0;
    flex: 1;
  }
  &__quick-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: #1e293b;
  }
  &__quick-content {
    margin-top: 4px;
    color: #64748b;
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }

  &__toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  &__left { display: flex; gap: 8px; align-items: center; }
  &__right {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-left: auto;
  }
  &__file-thumb {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
  }
  &__file-strip {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #fff;
  }
  &__file-strip-controls {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 6px;
    align-items: center;
  }
  &__file-library {
    margin-top: 6px;
    max-height: 160px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  &__file-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    background: #fafbfc;
    transition: border-color .15s;

    &.is-selected {
      border-color: #409eff;
      background: #ecf5ff;
    }
  }
  &__file-item-thumb {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f1f5f9;
    color: #94a3b8;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .el-icon { font-size: 18px; }
  }
  &__file-item-main {
    min-width: 0;
    flex: 1;
  }
  &__file-item-name {
    font-size: 12px;
    font-weight: 600;
    color: #1e293b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  &__file-item-desc {
    font-size: 11px;
    line-height: 1.3;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }
  &__selected-file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid #bfdbfe;
    background: #eff6ff;
    border-radius: 8px;
  }
  &__file-info {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: #1e40af;
    font-size: 13px;
    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  &__emojis {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
    span { cursor: pointer; font-size: 20px; }
  }
}
</style>
