import request from './index'
import { resolveApiUrl } from '@/utils/runtimeConfig'
import { redirectToLogin } from '@/utils/sessionNavigation'

export function getMessages(convId, params) {
  return request.get(`/v1/conversations/${convId}/messages`, { params })
}

export function sendMessage(convId, data) {
  return request.post(`/v1/conversations/${convId}/messages`, data, {
    timeout: data?.translateToCustomerLanguage ? 90000 : 30000
  })
}

export function previewTranslation(convId, data = {}) {
  return request.post(`/v1/conversations/${encodeURIComponent(convId)}/translation-preview`, data, {
    timeout: 90000
  })
}

export function getMediaFiles(params = {}) {
  return request.get('/v1/media-files', { params })
}

export function uploadMediaFile(file) {
  const formData = new FormData()
  formData.append('file', file)
  return request.post('/v1/media-files/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300000
  })
}

export function getQuickReplies(params = {}) {
  return request.get('/v1/quick-replies', { params })
}

export function useQuickReply(id) {
  return request.post(`/v1/quick-replies/${id}/use`)
}

/**
 * 调用 RAG 推荐接口（SSE 流式）
 * POST /api/v1/messages/:msgId/suggestions
 *
 * @param {string} msgId 消息 ID
 * @param {object} options { regenerate, model, temperature, topK }
 * @param {function} onChunk  每个 text chunk 回调 (content: string)
 * @param {function} onSources 检索来源回调 (sources: array)
 * @param {function} onDone   完成回调 (fullText: string, chineseText: string|null, lang: string)
 * @param {function} onError  错误回调 (err: Error)
 * @returns {function} abort 函数
 */
/**
 * 获取 AI 推荐可用的模型列表
 * GET /api/v1/conversations/ai-suggest-models
 * @returns {Promise<string[]>} 模型名称数组
 */
export function fetchAiSuggestModels() {
  return request.get('/v1/conversations/ai-suggest-models')
}

export function submitSuggestionFeedback(msgId, data) {
  return request.post(`/v1/messages/${msgId}/suggestion-feedback`, data)
}

export function fetchSuggestions(msgId, options = {}, { onChunk, onSources, onDone, onError } = {}) {
  const controller = new AbortController()

  const token = localStorage.getItem('platform_token')

  fetch(resolveApiUrl(`/v1/messages/${encodeURIComponent(msgId)}/suggestions`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(options),
    signal: controller.signal
  })
    .then(async (response) => {
      if (response.status === 401) {
        redirectToLogin()
        throw new Error('登录已过期，请重新登录')
      }
      if (response.status === 409) {
        // 去重：正在生成中
        throw new Error('DUPLICATE_REQUEST')
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `请求失败 (${response.status})`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // 按 SSE 事件解析（以 \n\n 分隔）
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          let eventName = 'message'
          let dataStr = ''
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim()
            }
          }
          if (!dataStr) continue

          let data
          try { data = JSON.parse(dataStr) } catch { continue }

          if (eventName === 'sources' && onSources) {
            onSources(data.sources || [])
          } else if (eventName === 'message' && data.type === 'text' && onChunk) {
            onChunk(data.content || '')
          } else if (eventName === 'message' && data.type === 'cn_version') {
            // 中文版本通过 message 事件传入（单次调用生成双语的 cn 部分）
            if (onDone) onDone.__cnVersion = data.content || ''
          } else if (eventName === 'message' && data.type === 'error') {
            // 生成器内部错误（兜底）
            throw new Error(data.message || data.content || '生成推荐失败')
          } else if (eventName === 'done' && onDone) {
            onDone(data.suggestion || '', data.suggestionCn || null, data.customerLang || 'zh')
          } else if (eventName === 'error') {
            throw new Error(data.error || '生成推荐失败')
          }
        }
      }
    })
    .catch((err) => {
      if (err.name === 'AbortError') return
      if (err.message === 'DUPLICATE_REQUEST') {
        if (onError) onError(new Error('正在生成中，请稍候再试'))
        return
      }
      if (onError) onError(err)
    })

  return () => controller.abort()
}
