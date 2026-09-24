<template>
  <div class="message-bubble" :class="`message-bubble--${message.role}`">
    <!-- 引用消息块 -->
    <div v-if="message.quotedMsg" class="message-bubble__quoted">
      <div class="message-bubble__quoted-bar"></div>
      <div class="message-bubble__quoted-text">{{ message.quotedMsg }}</div>
    </div>

    <!-- 媒体消息 -->
    <div v-if="message.type === 'image' && message.fileUrl" class="message-bubble__media">
      <img :src="resolveAssetUrl(message.fileUrl)" :alt="message.fileName || 'image'" @click="openFile(message.fileUrl)" />
      <div v-if="message.content" class="message-bubble__caption">{{ message.content }}</div>
    </div>
    <div v-else-if="message.type === 'video' && message.fileUrl" class="message-bubble__media">
      <div class="message-bubble__video-wrap">
        <video :src="resolveAssetUrl(message.fileUrl)" controls preload="metadata" @dblclick="openVideoPreview"></video>
        <button
          type="button"
          class="message-bubble__video-action"
          title="放大播放"
          aria-label="放大播放"
          @click.stop="openVideoPreview"
        >
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 5H10V7H7V10H5V5ZM14 5H19V10H17V7H14V5ZM17 14H19V19H14V17H17V14ZM7 14V17H10V19H5V14H7Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
      <div v-if="message.content" class="message-bubble__caption">{{ message.content }}</div>
    </div>
    <div v-else-if="message.type === 'audio' && message.fileUrl" class="message-bubble__audio">
      <audio :src="resolveAssetUrl(message.fileUrl)" controls preload="metadata"></audio>
      <div v-if="message.content" class="message-bubble__caption">{{ message.content }}</div>
      <div v-if="message.transcription" class="message-bubble__transcription">{{ message.transcription }}</div>
    </div>
    <a v-else-if="message.type === 'file' && message.fileUrl" class="message-bubble__file" :href="resolveAssetUrl(message.fileUrl)" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.89 22 5.99 22H18C19.1 22 20 21.1 20 20V8L14 2ZM13 9V3.5L18.5 9H13Z" fill="currentColor"/></svg>
      <div>
        <div class="message-bubble__file-name">{{ message.fileName || '文件' }}</div>
        <div v-if="message.content" class="message-bubble__caption">{{ message.content }}</div>
      </div>
    </a>

    <!-- 正文：默认始终显示原文 -->
    <div v-else class="message-bubble__content">{{ message.content }}</div>

    <!-- 翻译标注：仅翻译过的消息才显示译文折叠区，默认展开 -->
    <div v-if="message.translated && message.translatedText && message.translatedText !== message.content" class="message-bubble__translation">
      <div class="message-bubble__translation-badge" @click="showTranslated = !showTranslated">
        <svg viewBox="0 0 24 24" fill="none" class="message-bubble__translation-icon">
          <path d="M12.87 15.07L10.33 12.56L10.36 12.53C12.1 10.59 13.34 8.36 14.07 6H17V4H10V2H8V4H1V6H12.17C11.5 7.92 10.44 9.75 9 11.35C8.07 10.24 7.31 8.99 6.72 7.63H4.64C5.31 9.36 6.16 11.04 7.18 12.56L2.58 17.17L4 18.58L8.59 14L11.29 16.66L12.87 15.07ZM18.5 10H16.5L12 22H14L15.12 19H19.87L21 22H23L18.5 10ZM15.88 17L17.5 12.67L19.12 17H15.88Z" fill="currentColor"/>
        </svg>
        <span>{{ translationBadgeText }}</span>
        <svg
          viewBox="0 0 24 24" fill="none"
          class="message-bubble__translation-arrow"
          :class="{ 'is-open': showTranslated }"
        >
          <path d="M7.41 8.59L12 13.17L16.59 8.59L18 10L12 16L6 10L7.41 8.59Z" fill="currentColor"/>
        </svg>
      </div>
      <transition name="original-collapse">
        <div v-if="showTranslated" class="message-bubble__original">
          {{ message.translatedText }}
        </div>
      </transition>
    </div>

    <div class="message-bubble__meta">
      <span class="message-bubble__time">{{ formatTime(message.timestamp) }}</span>
      <!-- AI 回复标识：坐席侧消息且 senderType 为 ai 时显示 -->
      <span v-if="message.role === 'agent' && message.senderType === 'ai'" class="message-bubble__ai-tag">AI</span>
      <button
        v-if="showMessageFeedback"
        type="button"
        class="message-bubble__feedback"
        :class="{ 'is-liked': messageFeedbackValue === 'up' }"
        :disabled="messageFeedbackLoading"
        title="点赞并保存到QA"
        aria-label="点赞并保存到QA"
        @click.stop="handleMessageFeedback"
      >
        <svg viewBox="0 0 24 24" fill="none"><path d="M1 21H5V9H1V21ZM23 10C23 8.9 22.1 8 21 8H14.69L15.64 3.43L15.67 3.11C15.67 2.7 15.5 2.32 15.23 2.05L14.17 1L7.59 7.59C7.22 7.95 7 8.45 7 9V19C7 20.1 7.9 21 9 21H18C18.83 21 19.54 20.5 19.84 19.78L22.86 12.73C22.95 12.5 23 12.26 23 12V10Z" fill="currentColor"/></svg>
      </button>
      <!-- 仅客户消息（inbound）显示 AI推荐按钮 -->
      <template v-if="message.role === 'user' && message.id && !message.id.toString().startsWith('temp_')">
        <button
          v-if="!showSuggestion && !loading"
          class="ai-btn ai-btn--spark"
          @click="handleSuggest"
        >
          <svg class="ai-btn__icon" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="currentColor"/>
            <path d="M19 14L19.7 16.3L22 17L19.7 17.7L19 20L18.3 17.7L16 17L18.3 16.3L19 14Z" fill="currentColor" opacity="0.7"/>
            <path d="M5 14L5.5 15.5L7 16L5.5 16.5L5 18L4.5 16.5L3 16L4.5 15.5L5 14Z" fill="currentColor" opacity="0.5"/>
          </svg>
          <span class="ai-btn__text">AI 推荐</span>
          <span class="ai-btn__shine"></span>
        </button>
        <div v-if="loading" class="ai-loading">
          <div class="ai-loading__dots">
            <span></span><span></span><span></span>
          </div>
          <span class="ai-loading__text">AI 生成中</span>
        </div>
      </template>
    </div>

    <!-- AI 推荐结果区 -->
    <transition name="suggestion-slide">
      <div v-if="showSuggestion" class="suggestion-card">
        <div class="suggestion-card__header">
          <div class="suggestion-card__badge">
            <svg viewBox="0 0 24 24" fill="none" class="suggestion-card__badge-icon">
              <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="currentColor"/>
            </svg>
          </div>
          <span class="suggestion-card__title">AI 推荐回答</span>
          <span v-if="!loading && suggestionText" class="suggestion-card__badge-done">已生成</span>
          <span v-else-if="loading" class="suggestion-card__badge-loading">生成中...</span>

          <!-- 模型选择器（在卡片 header 右侧） -->
          <el-select
            v-if="aiModels.length > 1"
            v-model="selectedModel"
            class="suggestion-model-select"
            size="small"
            popper-class="suggestion-model-popper"
            @change="handleModelChange"
          >
            <el-option
              v-for="m in aiModels"
              :key="m"
              :label="m"
              :value="m"
            />
          </el-select>
        </div>
        <div class="suggestion-card__body">
          <span v-if="loading && !suggestionText" class="suggestion-card__placeholder">
            正在思考中...
          </span>
          <template v-else>
            {{ suggestionText }}
            <span v-if="loading" class="suggestion-card__cursor"></span>
          </template>
        </div>
        <!-- 中文翻译版本（非中文客户时显示） -->
        <div v-if="!loading && suggestionCn" class="suggestion-card__cn">
          <div class="suggestion-card__cn-header" @click="showCn = !showCn">
            <svg viewBox="0 0 24 24" fill="none" class="suggestion-card__cn-icon">
              <path d="M12.87 15.07L10.33 12.56L10.36 12.53C12.1 10.59 13.34 8.36 14.07 6H17V4H10V2H8V4H1V6H12.17C11.5 7.92 10.44 9.75 9 11.35C8.07 10.24 7.31 8.99 6.72 7.63H4.64C5.31 9.36 6.16 11.04 7.18 12.56L2.58 17.17L4 18.58L8.59 14L11.29 16.66L12.87 15.07ZM18.5 10H16.5L12 22H14L15.12 19H19.87L21 22H23L18.5 10ZM15.88 17L17.5 12.67L19.12 17H15.88Z" fill="currentColor"/>
            </svg>
            <span>中文版本</span>
            <svg viewBox="0 0 24 24" fill="none" class="suggestion-card__cn-arrow" :class="{ 'is-open': showCn }">
              <path d="M7.41 8.59L12 13.17L16.59 8.59L18 10L12 16L6 10L7.41 8.59Z" fill="currentColor"/>
            </svg>
          </div>
          <transition name="cn-collapse">
            <div v-if="showCn" class="suggestion-card__cn-body">{{ suggestionCn }}</div>
          </transition>
        </div>
        <transition name="fade">
          <div v-if="!loading && suggestionText" class="suggestion-card__actions">
            <button class="s-action-btn s-action-btn--primary" @click="$emit('adopt', suggestionText)">
              <svg viewBox="0 0 24 24" fill="none"><path d="M9 16.17L4.83 12L3.41 13.41L9 18.83L20.59 7.41L19.17 6L9 16.17Z" fill="currentColor"/></svg>
              采纳
            </button>
            <button class="s-action-btn s-action-btn--ghost" @click="handleSuggest" title="重新生成">
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 4V1L8 5L12 9V6C15.31 6 18 8.69 18 12C18 13.01 17.69 13.95 17.18 14.75L18.65 16.22C19.48 15.07 20 13.59 20 12C20 7.58 16.42 4 12 4Z" fill="currentColor"/><path d="M12 18V21L16 17L12 13V16C8.69 16 6 13.31 6 10C6 8.99 6.31 8.05 6.82 7.25L5.35 5.78C4.52 6.93 4 8.41 4 10C4 14.42 7.58 18 12 18Z" fill="currentColor"/></svg>
              重新生成
            </button>
            <button class="s-action-btn s-action-btn--icon" :class="{ 'is-liked': feedbackValue === 'up' }" :disabled="feedbackLoading" @click="handleFeedback('up')" title="推荐有用，保存到QA">
              <svg viewBox="0 0 24 24" fill="none"><path d="M1 21H5V9H1V21ZM23 10C23 8.9 22.1 8 21 8H14.69L15.64 3.43L15.67 3.11C15.67 2.7 15.5 2.32 15.23 2.05L14.17 1L7.59 7.59C7.22 7.95 7 8.45 7 9V19C7 20.1 7.9 21 9 21H18C18.83 21 19.54 20.5 19.84 19.78L22.86 12.73C22.95 12.5 23 12.26 23 12V10Z" fill="currentColor"/></svg>
            </button>
            <button class="s-action-btn s-action-btn--icon" :class="{ 'is-disliked': feedbackValue === 'down' }" :disabled="feedbackLoading" @click="handleFeedback('down')" title="推荐无用，但记录到QA用于改进">
              <svg viewBox="0 0 24 24" fill="none"><path d="M15 3H6C5.17 3 4.46 3.5 4.16 4.22L1.14 11.27C1.05 11.5 1 11.74 1 12V14C1 15.1 1.9 16 3 16H9.31L8.36 20.57L8.33 20.89C8.33 21.3 8.5 21.68 8.77 21.95L9.83 23L16.41 16.41C16.78 16.05 17 15.55 17 15V5C17 3.9 16.1 3 15 3ZM19 3V15H23V3H19Z" fill="currentColor"/></svg>
            </button>
            <button class="s-action-btn s-action-btn--icon" @click="handleCopy" title="复制">
              <svg viewBox="0 0 24 24" fill="none"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>
            </button>
            <button class="s-action-btn s-action-btn--icon s-action-btn--close" @click="showSuggestion = false" title="收起">
              <svg viewBox="0 0 24 24" fill="none"><path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z" fill="currentColor"/></svg>
            </button>
          </div>
        </transition>
      </div>
    </transition>

    <el-dialog
      v-model="videoPreviewVisible"
      class="message-video-preview-dialog"
      append-to-body
      destroy-on-close
      width="min(92vw, 960px)"
      :show-close="true"
      @closed="handleVideoPreviewClosed"
    >
      <div class="message-video-preview">
        <video
          ref="previewVideoRef"
          :src="resolveAssetUrl(message.fileUrl)"
          controls
          autoplay
          playsinline
        ></video>
        <button
          type="button"
          class="message-video-preview__fullscreen"
          title="全屏播放"
          aria-label="全屏播放"
          @click="requestVideoFullscreen"
        >
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 5H10V7H7V10H5V5ZM14 5H19V10H17V7H14V5ZM17 14H19V19H14V17H17V14ZM7 14V17H10V19H5V14H7Z" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          class="message-video-preview__close"
          title="关闭"
          aria-label="关闭"
          @click="videoPreviewVisible = false"
        >
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M18.3 5.71L12 12L18.3 18.29L16.89 19.7L10.59 13.41L4.29 19.7L2.88 18.29L9.17 12L2.88 5.71L4.29 4.3L10.59 10.59L16.89 4.3L18.3 5.71Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { fetchSuggestions, submitSuggestionFeedback } from '@/api/messages'
import { useAiSuggestModelsStore } from '@/stores/aiSuggestModels'
import { resolveAssetUrl } from '@/utils/runtimeConfig'

const props = defineProps({
  message: { type: Object, required: true }
})

const emit = defineEmits(['adopt'])

const showSuggestion = ref(false)
const loading = ref(false)
const suggestionText = ref('')
const suggestionCn = ref('')
const customerLang = ref('zh')
const suggestionSources = ref([])
const feedbackValue = ref('none')
const feedbackLoading = ref(false)
const messageFeedbackValue = ref('none')
const messageFeedbackLoading = ref(false)
const showTranslated = ref(true)
const showCn = ref(false)
const videoPreviewVisible = ref(false)
const previewVideoRef = ref(null)
let abortFn = null

const aiSuggestModelsStore = useAiSuggestModelsStore()
const aiModels = computed(() => aiSuggestModelsStore.availableModels)
const selectedModel = computed({
  get: () => aiSuggestModelsStore.selectedModel,
  set: (model) => aiSuggestModelsStore.setSelectedModel(model)
})

const languageLabels = {
  zh: '中文', en: '英语', es: '西班牙语', fr: '法语', de: '德语',
  ja: '日语', ko: '韩语', ar: '阿拉伯语', ru: '俄语', pt: '葡萄牙语',
  th: '泰语', vi: '越南语', id: '印度尼西亚语', tr: '土耳其语',
  it: '意大利语', hi: '印地语', ur: '乌尔都语', fa: '波斯语',
  ms: '马来语', tl: '菲律宾语', nl: '荷兰语', pl: '波兰语'
}

const languageLabelAliases = {
  english: '英语', spanish: '西班牙语', french: '法语', german: '德语',
  japanese: '日语', korean: '韩语', arabic: '阿拉伯语', russian: '俄语',
  portuguese: '葡萄牙语', thai: '泰语', vietnamese: '越南语',
  indonesian: '印度尼西亚语', turkish: '土耳其语', italian: '意大利语',
  hindi: '印地语', urdu: '乌尔都语', persian: '波斯语', malay: '马来语',
  filipino: '菲律宾语', chinese: '中文'
}

const originalLanguageLabel = computed(() => {
  const label = String(props.message.langLabel || '').trim()
  if (label && !['未知语言', 'unknown'].includes(label.toLowerCase())) {
    return languageLabelAliases[label.toLowerCase()] || label
  }
  const code = String(props.message.originalLang || '').trim().toLowerCase()
  if (!code || code === 'unknown') return '未知语言'
  return languageLabels[code] || code.toUpperCase()
})

const translationBadgeText = computed(() => {
  const action = showTranslated.value ? '收起译文' : '查看译文'
  return `已翻译 · 原文：${originalLanguageLabel.value} · ${action}`
})

const isPersistedMessage = computed(() => props.message.id && !props.message.id.toString().startsWith('temp_'))
const messageAnswerText = computed(() => String(props.message.content || '').trim())
const showMessageFeedback = computed(() => {
  return isPersistedMessage.value &&
    props.message.role === 'agent' &&
    ['agent', 'ai'].includes(props.message.senderType) &&
    !!messageAnswerText.value
})

// 切换模型时由 Pinia 统一记住选择并重新生成
const handleModelChange = () => {
  handleSuggest()
}

const openFile = (url) => {
  window.open(resolveAssetUrl(url), '_blank', 'noopener,noreferrer')
}

const openVideoPreview = () => {
  videoPreviewVisible.value = true
}

const handleVideoPreviewClosed = () => {
  if (previewVideoRef.value) {
    previewVideoRef.value.pause()
  }
}

const requestVideoFullscreen = async () => {
  const video = previewVideoRef.value
  if (!video) return
  try {
    if (video.requestFullscreen) {
      await video.requestFullscreen()
    } else if (video.webkitRequestFullscreen) {
      video.webkitRequestFullscreen()
    } else if (video.msRequestFullscreen) {
      video.msRequestFullscreen()
    } else {
      openFile(props.message.fileUrl)
    }
  } catch (error) {
    ElMessage.warning('无法进入全屏播放')
  }
}

const formatTime = (time) => {
  if (!time) return ''
  const d = dayjs(time)
  const now = dayjs()
  if (d.isSame(now, 'day')) return d.format('HH:mm')
  if (d.isSame(now, 'year')) return d.format('MM-DD HH:mm')
  return d.format('YYYY-MM-DD HH:mm')
}

// 防抖：500ms 内重复点击只执行最后一次
let suggestTimer = null
const handleSuggest = () => {
  if (suggestTimer) {
    clearTimeout(suggestTimer)
  }
  suggestTimer = setTimeout(() => {
    suggestTimer = null
    doSuggest()
  }, 500)
}

const doSuggest = () => {
  if (abortFn) abortFn()
  suggestionText.value = ''
  suggestionCn.value = ''
  suggestionSources.value = []
  feedbackValue.value = 'none'
  customerLang.value = 'zh'
  showSuggestion.value = true
  loading.value = true

  const options = { regenerate: false }
  if (selectedModel.value) {
    options.model = selectedModel.value
  }

  abortFn = fetchSuggestions(
    props.message.id,
    options,
    {
      onSources: (sources) => {
        suggestionSources.value = sources || []
      },
      onChunk: (content) => {
        suggestionText.value += content
      },
      onDone: (fullText, chineseText, lang) => {
        loading.value = false
        customerLang.value = lang
        // 缓存命中时后端只发 done 事件（没有 text chunk），onChunk 不会被调用，
        // 因此必须在此处用 done 返回的完整文本回填 suggestionText，否则卡片空白、按钮不显示。
        // 正常流式生成时 onChunk 已逐字填充，此处赋值是幂等的（内容一致）。
        if (fullText) {
          suggestionText.value = fullText
        }
        if (chineseText) {
          suggestionCn.value = chineseText
        }
        persistSuggestionFeedback('none', { silent: true })
      },
      onError: (err) => {
        loading.value = false
        ElMessage.error('AI推荐生成失败: ' + (err.message || '未知错误'))
      }
    }
  )
}

const persistSuggestionFeedback = async (value, { silent = false } = {}) => {
  if (!suggestionText.value || feedbackLoading.value) return
  feedbackLoading.value = true
  try {
    await submitSuggestionFeedback(props.message.id, {
      answer: suggestionText.value,
      answerCn: suggestionCn.value || null,
      customerLang: customerLang.value,
      model: selectedModel.value,
      feedback: value,
      sources: suggestionSources.value
    })
    feedbackValue.value = value
    if (!silent) {
      ElMessage.success(value === 'up' ? '已点赞并保存到QA列表' : value === 'down' ? '已点踩并保存到QA列表' : '已保存到QA列表')
    }
  } catch (error) {
    if (!silent) {
      ElMessage.error('反馈保存失败: ' + (error.response?.data?.message || error.message || '未知错误'))
    }
  } finally {
    feedbackLoading.value = false
  }
}

const handleFeedback = (value) => persistSuggestionFeedback(value)

const handleMessageFeedback = async () => {
  if (!showMessageFeedback.value || messageFeedbackLoading.value) return
  if (messageFeedbackValue.value === 'up') {
    ElMessage.info('这条消息已点赞')
    return
  }

  messageFeedbackLoading.value = true
  try {
    await submitSuggestionFeedback(props.message.id, {
      answer: messageAnswerText.value,
      answerCn: null,
      customerLang: 'zh',
      model: props.message.senderType === 'ai' ? 'ai_reply' : 'agent_reply',
      feedback: 'up',
      sources: []
    })
    messageFeedbackValue.value = 'up'
    ElMessage.success('已点赞并保存到QA列表')
  } catch (error) {
    ElMessage.error('点赞保存失败: ' + (error.response?.data?.message || error.message || '未知错误'))
  } finally {
    messageFeedbackLoading.value = false
  }
}

const handleCopy = () => {
  let text = suggestionText.value
  if (suggestionCn.value) {
    text += '\n\n--- 中文版本 ---\n' + suggestionCn.value
  }
  navigator.clipboard.writeText(text)
  ElMessage.success('已复制到剪贴板')
}
</script>

<style lang="scss" scoped>
.message-bubble {
  max-width: 70%;
  padding: 8px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  word-break: break-word;

  &--user {
    align-self: flex-start;
    background: #f1f5f9;
    color: #1e293b;
    border-top-left-radius: 2px;
  }
  &--agent {
    align-self: flex-end;
    background: #3b82f6;
    color: #fff;
    border-top-right-radius: 2px;
  }

  &__content {
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  &__media {
    display: flex;
    flex-direction: column;
    gap: 6px;
    img,
    video {
      max-width: 260px;
      max-height: 220px;
      border-radius: 8px;
      object-fit: contain;
      background: rgba(15, 23, 42, 0.08);
    }
    img {
      cursor: zoom-in;
    }
  }
  &__video-wrap {
    position: relative;
    width: fit-content;
    max-width: 100%;
    line-height: 0;

    video {
      display: block;
    }
  }
  &__video-action {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: 6px;
    color: #fff;
    background: rgba(15, 23, 42, 0.62);
    box-shadow: 0 2px 10px rgba(15, 23, 42, 0.22);
    cursor: zoom-in;
    transition: background 0.18s ease, transform 0.18s ease;

    svg {
      width: 17px;
      height: 17px;
    }

    &:hover {
      background: rgba(15, 23, 42, 0.82);
      transform: translateY(-1px);
    }
  }
  &__caption {
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  &__audio {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 240px;
    audio {
      width: 260px;
      max-width: 100%;
    }
  }
  &__transcription {
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.06);
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  &--agent &__transcription {
    background: rgba(255, 255, 255, 0.18);
  }
  &__file {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 220px;
    padding: 10px;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    background: rgba(255, 255, 255, 0.18);
    svg {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }
  }
  &__file-name {
    font-size: 13px;
    font-weight: 600;
    word-break: break-all;
  }
  &--user &__file {
    background: rgba(15, 23, 42, 0.05);
  }
  &__quoted {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.04);
    border-left: 3px solid #94a3b8;
    font-size: 12px;
    line-height: 1.4;
    color: #64748b;
    overflow: hidden;
  }
  &__quoted-bar {
    display: none;
  }
  &__quoted-text {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
  }
  &--agent &__quoted {
    background: rgba(255, 255, 255, 0.15);
    border-left-color: rgba(255, 255, 255, 0.5);
    color: rgba(255, 255, 255, 0.8);
  }
  &__meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  &__time {
    font-size: 11px;
    opacity: 0.6;
  }
  &__ai-tag {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    height: 16px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    background: rgba(139, 92, 246, 0.2);
    color: #a78bfa;
    border: 1px solid rgba(139, 92, 246, 0.3);
  }
  &__feedback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.42);
    border-radius: 5px;
    color: rgba(255, 255, 255, 0.82);
    background: rgba(255, 255, 255, 0.14);
    cursor: pointer;
    transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease;

    svg {
      width: 12px;
      height: 12px;
    }

    &:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.24);
      border-color: rgba(255, 255, 255, 0.72);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }

    &.is-liked {
      color: #15803d;
      background: #dcfce7;
      border-color: #86efac;
    }
  }
}

/* ===== AI 推荐按钮 ===== */
.ai-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border: none;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.3s ease;

  &__icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  &--spark {
    color: #fff;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.5);
    }
    &:active {
      transform: translateY(0);
    }
  }

  &__shine {
    position: absolute;
    top: 0;
    left: -100%;
    width: 60%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
    animation: shine 2.5s infinite;
    pointer-events: none;
  }
}

@keyframes shine {
  0% { left: -100%; }
  50% { left: 120%; }
  100% { left: 120%; }
}

/* ===== AI 生成中 loading ===== */
.ai-loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 20px;
  background: linear-gradient(135deg, #6366f1, #a855f7);
  color: #fff;
  font-size: 11px;
  font-weight: 600;

  &__dots {
    display: inline-flex;
    gap: 3px;
    span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #fff;
      animation: dot-bounce 1.2s infinite ease-in-out;
      &:nth-child(2) { animation-delay: 0.15s; }
      &:nth-child(3) { animation-delay: 0.3s; }
    }
  }
}

@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ===== 推荐卡片 ===== */
.suggestion-card {
  margin-top: 10px;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e0e7ff;
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.12);

  &__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: linear-gradient(135deg, #eef2ff 0%, #f5f3ff 50%, #faf5ff 100%);
    border-bottom: 1px solid #e0e7ff;
  }

  &__badge {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #6366f1, #a855f7);
    color: #fff;
    box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
    flex-shrink: 0;
  }

  &__badge-icon {
    width: 14px;
    height: 14px;
  }

  &__title {
    font-size: 12px;
    font-weight: 700;
    background: linear-gradient(135deg, #6366f1, #a855f7);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    flex-shrink: 0;
  }

  &__badge-done {
    font-size: 10px;
    font-weight: 600;
    color: #10b981;
    padding: 1px 7px;
    border-radius: 10px;
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    flex-shrink: 0;
  }

  &__badge-loading {
    font-size: 10px;
    color: #f59e0b;
    padding: 1px 7px;
    border-radius: 10px;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    flex-shrink: 0;
  }

  &__body {
    padding: 12px;
    font-size: 13px;
    line-height: 1.7;
    color: #334155;
    white-space: pre-wrap;
    min-height: 28px;
  }

  &__placeholder {
    color: #94a3b8;
    font-style: italic;
  }

  &__cursor {
    display: inline-block;
    width: 8px;
    height: 16px;
    margin-left: 1px;
    vertical-align: text-bottom;
    border-radius: 1px;
    background: linear-gradient(180deg, #6366f1, #a855f7);
    animation: cursor-blink 1s infinite;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid #f1f5f9;
    background: #fafbff;
  }

  // 中文版本区域
  &__cn {
    border-top: 1px dashed #e2e8f0;
  }
  &__cn-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    cursor: pointer;
    font-size: 11px;
    color: #ef4444;
    font-weight: 600;
    user-select: none;
    transition: background 0.15s;
    border-radius: 0 0 12px 12px;

    &:hover { background: #fef2f2; }
  }
  &__cn-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }
  &__cn-arrow {
    width: 14px;
    height: 14px;
    margin-left: auto;
    flex-shrink: 0;
    transition: transform 0.25s ease;
    &.is-open { transform: rotate(180deg); }
  }
  &__cn-body {
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.7;
    color: #334155;
    white-space: pre-wrap;
    background: #fef2f2;
    border-top: 1px solid #fecaca;
    border-radius: 0 0 12px 12px;
  }
}

/* ===== 卡片内模型选择器 ===== */
.suggestion-model-select {
  width: 140px;
  margin-left: auto;

  :deep(.el-input__wrapper) {
    height: 26px;
    min-height: 26px;
    padding: 0 6px;
    border-radius: 6px;
    background: #fff;
    border: 1px solid #c7d2fe;
    font-size: 11px;
    box-shadow: none;

    &:hover { border-color: #a5b4fc; background: #f5f3ff; }
    &.is-focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
  }
  :deep(.el-input__inner) {
    height: 26px;
    line-height: 26px;
    font-size: 11px;
    color: #4338ca;
    font-weight: 500;
  }
  :deep(.el-input__suffix) {
    .el-icon { width: 12px; height: 12px; color: #6366f1; }
  }
}

/* ===== 操作按钮 ===== */
.s-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;

  svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  &--primary {
    color: #fff;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.45);
    }
  }

  &--ghost {
    color: #6366f1;
    background: #eef2ff;
    border: 1px solid #c7d2fe;

    &:hover {
      background: #e0e7ff;
      border-color: #a5b4fc;
    }
  }

  &--icon {
    padding: 5px;
    width: 28px;
    height: 28px;
    justify-content: center;
    color: #64748b;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;

    &:hover {
      color: #6366f1;
      background: #eef2ff;
      border-color: #c7d2fe;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    &.is-liked {
      color: #16a34a;
      background: #dcfce7;
      border-color: #86efac;
    }

    &.is-disliked {
      color: #dc2626;
      background: #fee2e2;
      border-color: #fecaca;
    }

    &--close:hover {
      color: #ef4444;
      background: #fef2f2;
      border-color: #fecaca;
    }
  }
}

/* ===== 翻译标注 ===== */
.message-bubble__translation {
  margin-top: 6px;
}
.message-bubble__translation-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 6px;
  border-radius: 14px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  font-size: 11px;
  color: #3b82f6;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
  max-width: 100%;

  span {
    min-width: 0;
    white-space: normal;
  }

  &:hover {
    background: #dbeafe;
    border-color: #93c5fd;
  }
}
.message-bubble__translation-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.message-bubble__translation-arrow {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 0.25s ease;
  &.is-open { transform: rotate(180deg); }
}
.message-bubble__original {
  padding: 8px 12px;
  margin-top: 4px;
  border-radius: 8px;
  background: #fefce8;
  border: 1px solid #fde68a;
  font-size: 13px;
  line-height: 1.5;
  color: #92400e;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 翻译原文折叠动画 */
.original-collapse-enter-active {
  transition: all 0.25s ease;
  overflow: hidden;
}
.original-collapse-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.original-collapse-enter-from,
.original-collapse-leave-to {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.original-collapse-enter-to,
.original-collapse-leave-from {
  opacity: 1;
  max-height: 200px;
}

/* 中文版本折叠动画 */
.cn-collapse-enter-active {
  transition: all 0.25s ease;
  overflow: hidden;
}
.cn-collapse-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.cn-collapse-enter-from,
.cn-collapse-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.cn-collapse-enter-to,
.cn-collapse-leave-from {
  opacity: 1;
  max-height: 400px;
}

/* ===== 动画 ===== */
.suggestion-slide-enter-active {
  transition: all 0.3s ease;
  overflow: hidden;
}
.suggestion-slide-enter-from {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
}
.suggestion-slide-enter-to {
  opacity: 1;
  max-height: 500px;
  margin-top: 10px;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

@keyframes cursor-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

:global(.message-video-preview-dialog.el-dialog),
:global(.message-video-preview-dialog .el-dialog) {
  --el-dialog-padding-primary: 0;
  background: #05070b;
  border-radius: 8px;
  overflow: hidden;
}

:global(.message-video-preview-dialog.el-dialog) {
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
}

:global(.message-video-preview-dialog .el-dialog__header) {
  display: none;
}

:global(.message-video-preview-dialog .el-dialog__body) {
  padding: 0;
}

.message-video-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  max-height: 84vh;
  background: #05070b;

  video {
    display: block;
    width: 100%;
    max-height: 84vh;
    object-fit: contain;
    background: #05070b;
  }

  &__fullscreen {
    position: absolute;
    top: 12px;
    right: 56px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 6px;
    color: #fff;
    background: rgba(15, 23, 42, 0.66);
    cursor: pointer;
    transition: background 0.18s ease, transform 0.18s ease;

    svg {
      width: 20px;
      height: 20px;
    }

    &:hover {
      background: rgba(15, 23, 42, 0.86);
      transform: translateY(-1px);
    }
  }

  &__close {
    position: absolute;
    top: 12px;
    right: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 6px;
    color: #fff;
    background: rgba(15, 23, 42, 0.66);
    cursor: pointer;
    transition: background 0.18s ease, transform 0.18s ease;

    svg {
      width: 20px;
      height: 20px;
    }

    &:hover {
      background: rgba(15, 23, 42, 0.86);
      transform: translateY(-1px);
    }
  }
}
</style>
