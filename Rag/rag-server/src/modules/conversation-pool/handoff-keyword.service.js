/**
 * Customer handoff keyword matcher.
 *
 * Operators maintain Chinese keywords in the admin panel. This matcher applies
 * them to customer messages in any language by checking original text,
 * translated Chinese text, and a semantic LLM fallback for non-Chinese input.
 */

const { SystemMessage, HumanMessage } = require('@langchain/core/messages')

const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus'
const MAX_SEMANTIC_TEXT_LENGTH = 500

let langchainService = null

function getLangchainService() {
  if (!langchainService) {
    langchainService = require('../rag/langchainService')
  }
  return langchainService
}

function parseConfiguredKeywords(value) {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = raw.split(/[,，\n]/)
    }
  }

  if (!Array.isArray(raw)) return []

  const seen = new Set()
  return raw
    .map(keyword => String(keyword || '').trim())
    .filter(Boolean)
    .filter(keyword => {
      const key = keyword.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function normalizeForDirectMatch(text = '') {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\ufeff]/g, '')
}

function extractMessageText(message) {
  try {
    const content = message?.content || {}
    if (typeof content === 'string') return content
    return content.text || content.content || ''
  } catch {
    return ''
  }
}

function extractTranslatedText(message) {
  try {
    const content = message?.content || {}
    if (typeof content === 'string') return ''
    return content.translatedText || ''
  } catch {
    return ''
  }
}

function looksChinese(text) {
  const compactText = String(text || '').replace(/\s/g, '')
  if (!compactText) return false
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return cjkCount / compactText.length >= 0.3
}

function languageLabelFromCode(code) {
  const labels = {
    zh: '中文',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
    ar: 'Arabic',
    ru: 'Russian',
    pt: 'Portuguese',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    tr: 'Turkish',
    it: 'Italian'
  }
  return labels[code] || code || '客户消息的原语言'
}

function detectCustomerLanguageFromMessage(text, message) {
  try {
    const content = message?.content || {}
    if (typeof content !== 'string' && content.originalLang && content.originalLang !== 'unknown') {
      return {
        group: content.originalLang === 'zh' ? 'zh' : 'other',
        code: content.originalLang,
        label: content.langLabel || languageLabelFromCode(content.originalLang)
      }
    }
  } catch {
    // ignore malformed content
  }

  if (!text) return { group: 'zh', code: 'zh', label: '中文' }
  if (!looksChinese(text)) {
    const code = /[a-zA-Z]{3,}/.test(text) ? 'en' : 'other'
    return { group: 'other', code, label: languageLabelFromCode(code) }
  }
  return { group: 'zh', code: 'zh', label: '中文' }
}

function findDirectKeywordMatch(text, keywords) {
  const normalizedText = normalizeForDirectMatch(text)
  if (!normalizedText) return null

  return keywords.find(keyword => {
    const normalizedKeyword = normalizeForDirectMatch(keyword)
    return normalizedKeyword && normalizedText.includes(normalizedKeyword)
  }) || null
}

function buildMatchedResult({ keyword, reason, matchType, customerLanguage }) {
  return {
    matched: true,
    keyword,
    reason,
    matchType,
    customerLanguage
  }
}

function buildUnmatchedResult(customerLanguage = null) {
  return {
    matched: false,
    keyword: null,
    reason: '',
    matchType: 'none',
    customerLanguage
  }
}

async function matchBySemanticIntent({
  text,
  translatedText,
  keywords,
  config = {},
  customerLanguage
}) {
  const trimmedText = String(text || '').trim()
  if (!trimmedText || trimmedText.length > MAX_SEMANTIC_TEXT_LENGTH) {
    return null
  }

  try {
    const model = config.ai_transfer_keyword_match_model ||
      config.ai_reply_validation_model ||
      config.ai_self_reply_model ||
      DASHSCOPE_MODEL

    const systemPrompt = `你是客服会话路由助手。后台只维护中文"转人工关键词"，但客户消息可能使用任何语言。

请判断客户消息是否明确表达了这些中文关键词对应的"需要真人客服接手/转人工/找客服人员/不要AI或机器人"意图。

判断规则：
- 只有客户明确要求真人、人工客服、客服代表、工作人员、坐席、转接人工、联系人工、不要机器人/AI 时，matched=true。
- 普通产品咨询、价格咨询、问候、催促、抱怨、售后问题，不因为复杂或负面就匹配关键词；这些由其它流程判断。
- 如果中文译文和原文含义冲突，以客户原文为准。
- 只根据给定中文关键词的语义判断，不要扩展到无关业务意图。

只回复 JSON：{"matched":true/false,"keyword":"命中的中文关键词或空字符串","reason":"简短中文原因"}`

    const userPrompt = [
      `中文关键词列表：${JSON.stringify(keywords)}`,
      `客户语言：${customerLanguage?.label || customerLanguage?.code || 'unknown'}`,
      `客户原文：${trimmedText}`,
      translatedText ? `已有中文译文：${translatedText}` : ''
    ].filter(Boolean).join('\n')

    const chatModel = getLangchainService().createChatModel({
      model,
      temperature: 0,
      maxTokens: 200,
      streaming: false
    })

    const response = await chatModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt)
    ])

    const content = typeof response.content === 'string'
      ? response.content.trim()
      : JSON.stringify(response.content)
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed.matched) return null

    const matchedKeyword = keywords.includes(parsed.keyword)
      ? parsed.keyword
      : keywords[0]

    return buildMatchedResult({
      keyword: matchedKeyword,
      reason: parsed.reason || `多语言语义匹配转人工关键词：${matchedKeyword}`,
      matchType: 'semantic',
      customerLanguage
    })
  } catch (err) {
    console.error('[HandoffKeyword] 多语言关键词语义匹配失败，跳过关键词拦截:', err.message)
    return null
  }
}

async function matchCustomerHandoffKeyword({
  messageText = '',
  message = null,
  config = {}
}) {
  const keywords = parseConfiguredKeywords(config.ai_transfer_keywords)
  const text = String(messageText || extractMessageText(message) || '').trim()
  const translatedText = String(extractTranslatedText(message) || '').trim()
  const customerLanguage = detectCustomerLanguageFromMessage(text, message)

  if (!keywords.length || !text) {
    return buildUnmatchedResult(customerLanguage)
  }

  const originalMatch = findDirectKeywordMatch(text, keywords)
  if (originalMatch) {
    return buildMatchedResult({
      keyword: originalMatch,
      reason: `客户消息原文包含转人工关键词：${originalMatch}`,
      matchType: 'direct_original',
      customerLanguage
    })
  }

  const translatedMatch = findDirectKeywordMatch(translatedText, keywords)
  if (translatedMatch) {
    return buildMatchedResult({
      keyword: translatedMatch,
      reason: `客户消息中文译文包含转人工关键词：${translatedMatch}`,
      matchType: 'direct_translated',
      customerLanguage
    })
  }

  if (customerLanguage.group === 'other') {
    const semanticMatch = await matchBySemanticIntent({
      text,
      translatedText,
      keywords,
      config,
      customerLanguage
    })
    if (semanticMatch) return semanticMatch
  }

  return buildUnmatchedResult(customerLanguage)
}

function buildCustomerHandoffReason(match) {
  const keyword = match?.keyword ? `“${match.keyword}”` : '未命名关键词'
  const detail = match?.reason || '客户主动要求人工介入'
  return `客户消息命中转人工关键词${keyword}（${match?.matchType || 'unknown'}）：${detail}`
}

module.exports = {
  matchCustomerHandoffKeyword,
  buildCustomerHandoffReason,
  parseConfiguredKeywords,
  findDirectKeywordMatch,
  extractMessageText,
  detectCustomerLanguageFromMessage
}
