/**
 * LanguageGuard — 全局语言兜底检查模块
 *
 * 核心职责：确保所有最终输出给客户的文本消息都匹配客户当前使用的语言。
 * 这是一层"安全网"，无论上游如何生成消息（AI回复/系统通知/坐席发送/未来新增功能），
 * 只要最终发给客户，语言就必须正确。
 *
 * 设计原则：
 * 1. 最终输出层的兜底保护 — 不是替代上游的语言控制，而是在上游可能遗漏时兜底
 * 2. 客户语言来源优先级：传入的准确语言 > DB最近客户消息的originalLang > 启发式检测
 * 3. 零侵入式 — 只检查并修正文本，不影响消息结构和其他字段
 * 4. 可配置 — 语言兜底检查开关和策略可通过 configService 管理
 *
 * 使用方式：
 *   const { ensureOutputLanguage } = require('../../services/languageGuard')
 *   const correctedText = await ensureOutputLanguage(replyText, conversationId, customerLanguage)
 *
 * 调用时机：在任何文本消息即将通过渠道适配器发送给客户之前。
 */

const { sequelize } = require('../config/database')

const INTERNAL_REPLY_MARKER_PATTERN = '(?:AI\\s*(?:回复|回覆|答复|reply|response|answer)|人工\\s*(?:回复|回覆|答复)|客服\\s*(?:回复|回覆|答复)|坐席\\s*(?:回复|回覆|答复)|human\\s*(?:reply|response)|agent\\s*(?:reply|response)|manual\\s*(?:reply|response))'
const INTERNAL_REPLY_MARKER_REGEX = new RegExp(
  `(^|\\n)\\s*(?:[\\[【(（]\\s*${INTERNAL_REPLY_MARKER_PATTERN}\\s*[\\]】)）]\\s*[:：\\-–—]?|${INTERNAL_REPLY_MARKER_PATTERN}\\s*[:：\\-–—])\\s*`,
  'gi'
)

/**
 * 检测是否包含不应透传给客户的内部来源标记。
 */
function hasInternalReplyMarker(text) {
  if (!text || typeof text !== 'string') return false
  INTERNAL_REPLY_MARKER_REGEX.lastIndex = 0
  return INTERNAL_REPLY_MARKER_REGEX.test(text)
}

/**
 * 清理最终发给客户的文本安全问题。
 *
 * 当前主要处理历史上下文来源标记泄漏，例如 [AI回复] / [人工回复]。
 * 这些标记只允许出现在 LLM 内部上下文中，不能出现在客户侧消息里。
 */
function sanitizeCustomerOutputText(text) {
  if (!text || typeof text !== 'string') return text
  INTERNAL_REPLY_MARKER_REGEX.lastIndex = 0
  const sanitized = text.replace(INTERNAL_REPLY_MARKER_REGEX, '$1').trim()
  return sanitized
}

// ========== 语言检测工具 ==========

/**
 * 判断文本是否主要使用中文
 * CJK字符占比 >= 0.3 判定为中文
 */
function looksChinese(text) {
  if (!text) return false
  const compactText = text.replace(/\s/g, '')
  if (!compactText) return false
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return cjkCount / compactText.length >= 0.3
}

/**
 * 判断文本是否主要使用非中文语言（英语/西班牙语等拉丁字母语言）
 * 拉丁字母占比 >= 0.3 且 CJK < 0.3 判定为非中文
 */
function looksNonChinese(text) {
  if (!text) return false
  const compactText = text.replace(/\s/g, '')
  if (!compactText) return false
  const latinCount = (compactText.match(/[a-zA-Z]/g) || []).length
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return latinCount / compactText.length >= 0.3 && cjkCount / compactText.length < 0.3
}

/**
 * 从 ISO 639-1 语言代码获取人类可读的语言名称
 */
function languageLabelFromCode(code) {
  const labels = {
    zh: '中文', en: 'English', es: 'Spanish', fr: 'French',
    de: 'German', ja: 'Japanese', ko: 'Korean', ar: 'Arabic',
    ru: 'Russian', pt: 'Portuguese', th: 'Thai', vi: 'Vietnamese',
    id: 'Indonesian', tr: 'Turkish', it: 'Italian', hi: 'Hindi',
    ur: 'Urdu', fa: 'Persian', ms: 'Malay', tl: 'Filipino'
  }
  return labels[code] || code || '客户消息的原语言'
}

/**
 * 规范化客户语言信息
 * 支持字符串 ('zh'|'en'|...) 和对象 ({ group, code, label }) 两种输入
 */
function normalizeLanguageInfo(customerLanguage) {
  if (!customerLanguage) {
    return { group: 'zh', code: 'zh', label: '中文' }
  }
  if (typeof customerLanguage === 'string') {
    if (customerLanguage === 'zh') {
      return { group: 'zh', code: 'zh', label: '中文' }
    }
    return { group: 'other', code: customerLanguage, label: languageLabelFromCode(customerLanguage) }
  }
  const group = customerLanguage.group === 'other' ? 'other' : 'zh'
  const code = customerLanguage.code || (group === 'other' ? 'other' : 'zh')
  return {
    group,
    code,
    label: customerLanguage.label || languageLabelFromCode(code)
  }
}

// ========== 客户语言查询 ==========

/**
 * 从数据库获取会话最近一条客户消息的语言信息
 *
 * 优先读取 content.originalLang（入库时由 translationService.detectLanguage 检测），
 * 缺失/unknown 时对文本做 CJK 启发式检测
 *
 * @param {string} conversationId
 * @returns {Promise<{ group: 'zh'|'other', code: string, label: string }>}
 */
async function resolveCustomerLanguageFromDb(conversationId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT content FROM plat_messages
       WHERE conversation_id = :conversationId
         AND direction = 'inbound'
         AND sender_type = 'customer'
         AND message_type = 'text'
       ORDER BY created_at DESC
       LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      // 没有客户消息记录，默认中文
      return { group: 'zh', code: 'zh', label: '中文' }
    }

    let content = rows[0].content
    try {
      content = typeof content === 'string' ? JSON.parse(content) : content
    } catch {
      content = {}
    }

    // 优先使用入库时翻译服务检测的语言
    if (content.originalLang && content.originalLang !== 'unknown') {
      return {
        group: content.originalLang === 'zh' ? 'zh' : 'other',
        code: content.originalLang,
        label: content.langLabel || languageLabelFromCode(content.originalLang)
      }
    }

    // 兜底：CJK 启发式检测
    const text = content.text || content.content || ''
    return detectLanguageHeuristically(text)
  } catch (err) {
    console.error('[LanguageGuard] 从DB获取客户语言失败，回退中文:', err.message)
    return { group: 'zh', code: 'zh', label: '中文' }
  }
}

/**
 * CJK 占比启发式语言检测（不调用LLM，零成本）
 */
function detectLanguageHeuristically(text) {
  if (!text || !text.trim()) {
    return { group: 'zh', code: 'zh', label: '中文' }
  }
  const compactText = text.replace(/\s/g, '')
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  const totalChars = compactText.length

  if (totalChars > 0 && cjkCount / totalChars < 0.3) {
    // 含拉丁字母 → 英语，否则标记为 'other'
    const code = /[a-zA-Z]{3,}/.test(text) ? 'en' : 'other'
    return { group: 'other', code, label: languageLabelFromCode(code) }
  }
  return { group: 'zh', code: 'zh', label: '中文' }
}

/**
 * 获取客户语言（合并所有来源）
 *
 * 优先级：传入的准确语言 > DB最近客户消息的originalLang > 启发式检测
 *
 * @param {string} conversationId
 * @param {Object|string|null} customerLanguage - 已知的客户语言信息（可选）
 * @returns {Promise<{ group: 'zh'|'other', code: string, label: string }>}
 */
async function resolveCustomerLanguage(conversationId, customerLanguage = null) {
  // 优先使用传入的准确语言（来自 ai-auto-reply 的检测）
  if (customerLanguage) {
    return normalizeLanguageInfo(customerLanguage)
  }

  // 回退到 DB 查询
  return resolveCustomerLanguageFromDb(conversationId)
}

// ========== 核心兜底检查 ==========

/**
 * 全局语言兜底检查 — 确保输出文本匹配客户语言
 *
 * 检查逻辑：
 * 1. 客户语言为中文(group='zh') → 输出看起来是中文 → PASS
 * 2. 客户语言为中文(group='zh') → 输出看起来是非中文 → 翻译为中文
 * 3. 客户语言为非中文(group='other') → 输出看起来匹配客户语言 → PASS
 * 4. 客户语言为非中文(group='other') → 输出看起来是中文 → 翻译为客户语言
 *
 * 注意：这是兜底检查，不是替代上游的语言控制。
 * 上游（LLM native_only模式、寒暄提示词、非工作时间翻译等）已经做了语言控制，
 * 这里只是在上游可能遗漏时的安全网。
 *
 * @param {string} text - 待检查的输出文本
 * @param {string} conversationId - 会话ID（用于查询客户语言）
 * @param {Object|string|null} customerLanguage - 已知的客户语言信息（可选，可避免额外DB查询）
 * @returns {Promise<string>} 修正后的文本（如果需要翻译则自动翻译）
 */
async function ensureOutputLanguage(text, conversationId, customerLanguage = null) {
  // 1. 非文本或空内容 → 不需要检查
  if (!text || typeof text !== 'string' || !text.trim()) {
    return text
  }

  // 1.5 输出安全清洗不受语言兜底开关影响，必须始终执行。
  const sanitizedText = sanitizeCustomerOutputText(text)
  if (sanitizedText !== text.trim()) {
    console.warn('[LanguageGuard] 检测到客户输出包含内部回复标记，已自动清理')
  }
  text = sanitizedText

  // 2. 获取语言配置开关
  try {
    const configService = require('./configService')
    const enabled = await configService.getConfig('language_guard_enabled')
    if (enabled === false || enabled === 'false' || enabled === 0) {
      // 语言兜底检查被关闭 → 直接返回原文
      return text
    }
  } catch {
    // 配置读取失败 → 默认开启兜底检查
  }

  // 3. 解析客户语言
  const langInfo = await resolveCustomerLanguage(conversationId, customerLanguage)
  console.log(`[LanguageGuard] 兜底检查: 客户语言=${langInfo.group}/${langInfo.code}/${langInfo.label}, 输出文本长度=${text.length}, 中文=${looksChinese(text)}, 非中文=${looksNonChinese(text)}`)

  // 4. 语言匹配检查
  const outputIsChinese = looksChinese(text)
  const outputIsNonChinese = looksNonChinese(text)

  // 客户中文 + 输出非中文 → 翻译为中文
  if (langInfo.group === 'zh' && outputIsNonChinese) {
    try {
      const configService = require('./configService')
      const translateModel = await configService.getConfig('llm_translate_model')
      const { translateToChinese } = require('./translationService')
      console.warn(`[LanguageGuard] 检测到中文客户收到非中文输出，自动翻译为中文`)
      const translated = await translateToChinese(text, langInfo.label || 'English', translateModel)
      return translated || text
    } catch (err) {
      console.error('[LanguageGuard] 中文翻译兜底失败，使用原输出:', err.message)
      return text
    }
  }

  // 客户非中文 + 输出中文 → 翻译为客户语言
  if (langInfo.group === 'other' && outputIsChinese) {
    try {
      const targetLang = langInfo.label || languageLabelFromCode(langInfo.code)
      const configService = require('./configService')
      const translateModel = await configService.getConfig('llm_translate_model')
      const { translateFromChinese } = require('./translationService')
      console.warn(`[LanguageGuard] 检测到非中文客户(${targetLang})收到中文输出，自动翻译为${targetLang}`)
      const translated = await translateFromChinese(text, targetLang, translateModel)
      return translated || text
    } catch (err) {
      console.error('[LanguageGuard] 非中文翻译兜底失败，使用原输出:', err.message)
      return text
    }
  }

  // 5. 语言匹配 → 直接返回
  return text
}

module.exports = {
  ensureOutputLanguage,
  resolveCustomerLanguage,
  resolveCustomerLanguageFromDb,
  normalizeLanguageInfo,
  sanitizeCustomerOutputText,
  hasInternalReplyMarker,
  looksChinese,
  looksNonChinese,
  languageLabelFromCode,
  detectLanguageHeuristically
}
