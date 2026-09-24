/**
 * TranslationService — 大模型语言检测 + 翻译服务
 *
 * 职责：
 * 1. 检测文本语言类型（中文/英文/其他）
 * 2. 将非中文文本翻译为中文
 *
 * 使用 LangChain ChatOpenAI + 阿里云百炼兼容模式
 */

const { ChatOpenAI } = require('@langchain/openai')
const { HumanMessage, SystemMessage } = require('@langchain/core/messages')

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

// ========== 语言检测 ==========

/**
 * 使用大模型检测文本语言类型
 * @param {string} text - 待检测文本
 * @param {string} model - 使用的模型
 * @returns {Promise<{ lang: string, label: string }>} 如 { lang: 'en', label: 'English' }
 */
async function detectLanguage(text, model = 'qwen3.6-flash') {
  if (!text || !text.trim()) {
    return { lang: 'zh', label: '中文' }
  }

  const langModel = new ChatOpenAI({
    model,
    temperature: 0,
    maxTokens: 50,
    apiKey: process.env.DASHSCOPE_API_KEY,
    configuration: { baseURL: DASHSCOPE_BASE_URL }
  })

  const messages = [
    new SystemMessage('你是一个语言检测助手。你只回复一个JSON对象，格式为 {"lang":"<语言代码>","label":"<语言中文名>"}。语言代码使用 ISO 639-1（如 zh/en/ja/ko/fr/de/es/ar/th/vi）。不要回复任何其他内容。'),
    new HumanMessage(text)
  ]

  try {
    const response = await langModel.invoke(messages)
    const content = typeof response.content === 'string'
      ? response.content.trim()
      : JSON.stringify(response.content)

    // 尝试解析 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      return {
        lang: result.lang || 'unknown',
        label: result.label || '未知语言'
      }
    }
  } catch (err) {
    console.error('[Translation] 语言检测失败:', err.message)
  }

  // 降级：简单字符检测
  if (/[\u4e00-\u9fff]/.test(text)) {
    return { lang: 'zh', label: '中文' }
  }
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
    return { lang: 'ja', label: '日语' }
  }
  if (/[\uac00-\ud7af]/.test(text)) {
    return { lang: 'ko', label: '韩语' }
  }
  if (/[a-zA-Z]{3,}/.test(text)) {
    return { lang: 'en', label: 'English' }
  }
  return { lang: 'unknown', label: '未知语言' }
}

// ========== 文本翻译 ==========

/**
 * 将文本翻译为中文
 * @param {string} text - 待翻译文本
 * @param {string} sourceLang - 源语言标签
 * @param {string} model - 使用的模型
 * @returns {Promise<string>} 翻译后的中文文本
 */
function buildContextSection(contextMessages = []) {
  if (!Array.isArray(contextMessages) || contextMessages.length === 0) {
    return ''
  }

  return contextMessages
    .map((msg, index) => {
      const role = msg.role === 'assistant' ? '客服/系统' : '客户'
      const content = String(msg.content || '').trim()
      if (!content) return null
      return `${index + 1}. ${role}: ${content}`
    })
    .filter(Boolean)
    .join('\n')
}

async function translateText(text, targetLang, sourceLang = 'auto-detected source language', model = 'qwen3.7-plus', options = {}) {
  if (!text || !text.trim()) return text

  const timeoutMs = Number(options.timeoutMs)
  const translateModel = new ChatOpenAI({
    model,
    temperature: 0.3,
    maxTokens: 4000,
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    apiKey: process.env.DASHSCOPE_API_KEY,
    configuration: { baseURL: DASHSCOPE_BASE_URL }
  })

  const contextSection = buildContextSection(options.contextMessages || [])
  const humanPrompt = contextSection
    ? `最近上下文（按时间顺序，仅供理解代词、省略和语气，不要翻译这些上下文）：\n${contextSection}\n\n当前待翻译文本：\n${text}`
    : text

  const messages = [
    new SystemMessage(`你是一个专业翻译助手。请将以下${sourceLang}文本翻译成简洁、准确的${targetLang}。如果提供了最近上下文，只能将其作为消歧参考，绝不能把上下文内容混入译文，也不要补充原文没有出现的新信息。只回复翻译后的${targetLang}文本，不要添加任何解释、注释或引号。保持原文的语气和风格。`),
    new HumanMessage(humanPrompt)
  ]

  try {
    const response = await translateModel.invoke(messages)
    const translated = typeof response.content === 'string'
      ? response.content.trim()
      : JSON.stringify(response.content)
    return translated
  } catch (err) {
    console.error('[Translation] 翻译失败:', err.message)
    if (options.throwOnError) {
      throw err
    }
    // 翻译失败返回原文
    return text
  }
}

async function translateToChinese(text, sourceLang = 'English', model = 'qwen3.7-plus', options = {}) {
  return translateText(text, '中文', sourceLang, model, options)
}

async function translateFromChinese(text, targetLang = 'English', model = 'qwen3.7-plus', options = {}) {
  return translateText(text, targetLang, '中文', model, options)
}

/**
 * 完整的翻译处理流程：检测语言 → 如需翻译则翻译
 * @param {string} text - 原文
 * @param {string} translateModel - 翻译使用的模型
 * @param {string} detectModel - 语言检测使用的模型
 * @param {Object} options - { contextMessages?: Array<{role:string, content:string}> }
 * @returns {Promise<Object>} { text, originalText, originalLang, translated, langLabel }
 */
async function processTranslation(text, translateModel = 'qwen3.7-plus', detectModel = 'qwen3.6-flash', options = {}) {
  if (!text || !text.trim()) {
    return { text, translated: false }
  }

  try {
    // 1. 检测语言
    const { lang, label } = await detectLanguage(text, detectModel)

    // 2. 中文直接返回
    if (lang === 'zh') {
      return {
        text,
        translated: false
      }
    }

    // 3. 翻译为中文
    console.log(`[Translation] 检测到 ${label}，开始翻译... 上下文条数=${Array.isArray(options.contextMessages) ? options.contextMessages.length : 0}`)
    const translatedText = await translateToChinese(text, label, translateModel, options)

    return {
      text: translatedText,
      originalText: text,
      originalLang: lang,
      langLabel: label,
      translated: true
    }
  } catch (err) {
    console.error('[Translation] processTranslation 失败:', err.message)
    console.error('[Translation] 错误详情:', err.stack?.substring(0, 300))
    // 失败时返回原文 + 标记，前端可据此展示
    return {
      text,
      originalText: text,
      originalLang: 'unknown',
      langLabel: '未知语言',
      translated: false,
      translateFailed: true
    }
  }
}

module.exports = {
  detectLanguage,
  translateText,
  translateToChinese,
  translateFromChinese,
  processTranslation
}
