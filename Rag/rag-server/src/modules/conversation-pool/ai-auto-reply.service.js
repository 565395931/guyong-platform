/**
 * AI 自动回复 + 系统主动转人工判断服务
 *
 * 核心前提：AI 自助回复不会告知客户其是 AI，客户全程无感知。
 * 所有"转人工"决策由系统自动完成，不依赖客户主动触发。
 *
 * 当会话处于 AI 自助池时，新消息到达后执行：
 *   1. 检查非文本内容 → 转待人工池
 *   2. 检查 AI 回复轮数（连续追问）→ 转待人工池
 *   3. RAG 资料交给模型判断：正常回答、追问或结构化转人工
 *   4. 结构化 reply / clarify 继续回复，handoff 才转待人工
 *   5. 以上都不满足 → 生成 AI 回复并发送
 *
 * 调用入口：渠道 Webhook / Cloud Gateway → messagingService → inboundMessage.service → AI Worker → 本服务
 */

const crypto = require('crypto')
const { isAiReplyEligible } = require('./aiReplyPolicy')
const { sequelize } = require('../../config/database')
const { isLatestAiReplyJob } = require('../../queues')
const messagingService = require('../messaging/messaging.service')
const poolService = require('./pool.service')
const { getDispatcher } = require('../cloud-gateway/runtime')
const { POOL_TYPE, CONV_STATUS } = require('./constants')
const {
  matchCustomerHandoffKeyword,
  buildCustomerHandoffReason
} = require('./handoff-keyword.service')

// 延迟加载 ragService，避免循环依赖
let ragService = null
let langchainService = null

function getRagService() {
  if (!ragService) {
    ragService = require('../rag/ragService')
  }
  return ragService
}

function getLangchainService() {
  if (!langchainService) {
    langchainService = require('../rag/langchainService')
  }
  return langchainService
}

// 延迟加载适配器
let wahaAdapter = null
function getWahaAdapter() {
  if (!wahaAdapter) {
    const { getAdapterByChannel } = require('../channel-adapters')
    wahaAdapter = getAdapterByChannel('whatsapp')
  }
  return wahaAdapter
}

const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus'

const SALES_CTA_PATTERNS = [
  /\b(?:let me know|tell me)\s+if\s+(?:you(?:'d| would)?\s+like|you\s+want|you\s+need)\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b/i,
  /\bwould\s+you\s+like\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b/i,
  /\bdo\s+you\s+want\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b/i
]

const TRAILING_SALES_CTA_PATTERNS = [
  /(?:^|[\s\n])(?:let me know|tell me)\s+if\s+(?:you(?:'d| would)?\s+like|you\s+want|you\s+need)\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b[^.!?\n]*[.!?]?\s*$/i,
  /(?:^|[\s\n])would\s+you\s+like\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b[^.!?\n]*[.!?]?\s*$/i,
  /(?:^|[\s\n])do\s+you\s+want\s+(?:to\s+)?(?:place\s+an?\s+order|order|(?:a\s+)?(?:full\s+)?quote)\b[^.!?\n]*[.!?]?\s*$/i
]

function hasSalesCta(text = '') {
  return SALES_CTA_PATTERNS.some(pattern => pattern.test(text))
}

function stripTrailingSalesCta(text = '') {
  let cleaned = text
  for (const pattern of TRAILING_SALES_CTA_PATTERNS) {
    cleaned = cleaned.replace(pattern, '').trim()
  }
  return cleaned || text
}

function dedupeRepeatedSalesCta(replyText, history = []) {
  if (!replyText || !hasSalesCta(replyText)) return replyText

  const recentAssistantMessages = history
    .filter(msg => msg.role === 'assistant')
    .slice(-4)

  const hasRecentSalesCta = recentAssistantMessages.some(msg => hasSalesCta(msg.content || ''))
  if (!hasRecentSalesCta) return replyText

  return stripTrailingSalesCta(replyText)
}

const HUMAN_HANDOFF_REPLY_RULES = [
  {
    reason: '回复承认手头没有资料',
    pattern: /(?:手头|目前|暂时|现在|这里).{0,8}(?:没有|没|暂无|缺少).{0,12}(?:相关)?(?:资料|信息|数据|内容|答案)/i
  },
  {
    reason: '回复承认资料或手册未覆盖',
    pattern: /(?:资料|信息|知识库|手册|文档).{0,12}(?:没有|没|未找到|找不到|查不到|暂无|未覆盖|不包含|没有提到)/i
  },
  {
    reason: '回复承诺稍后由人工或同事处理',
    pattern: /(?:稍后|晚点|等会|稍等|尽快|很快|马上|稍候).{0,24}(?:同事|人工|客服|专员|业务|工作人员|负责人).{0,24}(?:回复|答复|联系|跟进|处理)/i
  },
  {
    reason: '回复承诺人工或同事稍后联系',
    pattern: /(?:同事|人工|客服|专员|业务|工作人员|负责人).{0,24}(?:稍后|晚点|等会|稍等|尽快|很快|马上|稍候|会).{0,24}(?:回复|答复|联系|跟进|处理)/i
  },
  {
    reason: '回复仅承诺延期答复',
    pattern: /(?:稍后|晚点|等会|稍等|稍候|尽快|很快|马上).{0,18}(?:回复|答复|联系|跟进)(?:您|你|客户)?/i
  },
  {
    reason: '回复表示无法回答后转人工或延期',
    pattern: /(?:不太清楚|无法确认|不能确认|不能确定|无法回答|不知道|不确定).{0,32}(?:同事|人工|客服|稍后|晚点|尽快|回复|答复|联系|跟进)/i
  },
  {
    reason: '回复输出手册未找到兜底语',
    pattern: /手册中未找到相关条款/i
  },
  {
    reason: 'reply says available materials are missing',
    pattern: /\b(?:I|we)\s+(?:do\s+not|don't|cannot|can't|currently\s+do\s+not|currently\s+don't)\s+(?:have|find|see)\s+(?:the\s+)?(?:relevant\s+)?(?:materials?|information|info|details?|data|documents?|resources?|answer)\b/i
  },
  {
    reason: 'reply says no relevant information is available',
    pattern: /\b(?:no|not\s+enough|without)\s+(?:relevant\s+)?(?:materials?|information|info|details?|data|documents?|resources?)\b/i
  },
  {
    reason: 'reply promises a colleague or agent will follow up',
    pattern: /\b(?:colleague|coworker|co-worker|teammate|team|specialist|sales(?:\s+team)?|staff|representative|human\s+agent|agent)\b.{0,80}\b(?:reply|respond|get\s+back|contact|follow\s+up|handle)\b/i
  },
  {
    reason: 'reply promises a delayed response',
    pattern: /\b(?:reply|respond|get\s+back\s+to\s+you|contact\s+you|follow\s+up\s+with\s+you)\b.{0,80}\b(?:soon|shortly|later|as\s+soon\s+as\s+possible|asap)\b/i
  },
  {
    reason: 'reply says it will check then reply later',
    pattern: /\b(?:let\s+me|allow\s+me|I(?:'ll| will)|we(?:'ll| will))\b.{0,80}\b(?:check|confirm|verify)\b.{0,80}\b(?:and|then)\b.{0,40}\b(?:reply|respond|get\s+back|update|follow\s+up)\b/i
  },
  {
    reason: 'reply says the manual does not cover the answer',
    pattern: /\b(?:manual|documentation|documents?|knowledge\s+base)\b.{0,60}\b(?:does\s+not|doesn't|do\s+not|don't|cannot|can't)\b.{0,40}\b(?:include|contain|cover|have|mention|provide)\b/i
  }
]

function getReplyHumanHandoffReason(replyText = '') {
  const normalized = String(replyText || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return null

  const matchedRule = HUMAN_HANDOFF_REPLY_RULES.find(rule => rule.pattern.test(normalized))
  return matchedRule ? matchedRule.reason : null
}

function truncateText(text = '', maxLength = 200) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.substring(0, maxLength) + '...'
}

function buildRetrievalDiagnostics({
  queryText,
  retrieveQuery,
  mergedMessageCount,
  contextDocs = [],
  topScore = 0,
  confidenceThreshold,
  cautiousMin
}) {
  return {
    type: 'rag_retrieval',
    maxScore: Number(topScore || 0),
    confidenceThreshold: Number(confidenceThreshold),
    cautiousMin: Number(cautiousMin),
    mode: topScore < confidenceThreshold ? 'cautious' : 'normal',
    mergedMessageCount: mergedMessageCount || 1,
    queryLength: String(queryText || '').length,
    retrieveQueryLength: String(retrieveQuery || queryText || '').length,
    queryHash: crypto.createHash('sha256').update(String(queryText || '')).digest('hex'),
    retrieveQueryHash: crypto.createHash('sha256').update(String(retrieveQuery || queryText || '')).digest('hex'),
    topNodes: (contextDocs || []).slice(0, 5).map(node => ({
      score: Number(node.score || 0),
      docName: truncateText(node.docName || '', 80),
      title: truncateText(node.title || '', 80),
      textLength: String(node.text || node.content || '').length
    }))
  }
}

function buildAiLogExtra(extra = {}) {
  return Object.fromEntries(
    Object.entries(extra).filter(([, value]) => value !== undefined && value !== null)
  )
}

/**
 * 获取 AI 自助回复使用的模型（从配置中心读取，默认 deepseek-v4-flash）
 */
/**
 * 桌面桥接账号（抖店本地客户端）——**必须按账号优先判定**。
 *
 * 与手动发送（routes/conversations.js）一致：
 * 只看渠道会落到官方抖音适配器，它固定返回"开放平台未提供客服消息 API"，
 * AI 回复就永远发不出去（实测：审核通过的回复也发不出去，同一个坑）。
 */
async function getDesktopBridgeAdapter(message) {
  const accountId = Number(message.accountId)
  if (!Number.isInteger(accountId) || accountId <= 0) return null
  try {
    const { sequelize } = require('../../config/database')
    const { QueryTypes } = require('sequelize')
    const rows = await sequelize.query(
      'SELECT adapter_type FROM channel_accounts WHERE id = :accountId',
      { replacements: { accountId }, type: QueryTypes.SELECT }
    )
    if (!rows[0] || rows[0].adapter_type !== 'desktop_bridge') return null
    const { getAdapter } = require('../channel-adapters')
    return getAdapter('desktop_bridge') || null
  } catch (err) {
    console.error('[AiAutoReply] 判定桌面桥接账号失败:', err.message)
    return null
  }
}

async function getAiSelfReplyModel() {
  try {
    const configService = require('../../services/configService')
    return await configService.getConfig('ai_self_reply_model') || 'deepseek-v4-flash'
  } catch {
    return 'deepseek-v4-flash'
  }
}

/**
 * 处理 AI 自助池的新消息
 *
 * 系统主动判断退出条件（客户全程无感知）：
 *   - 非文本内容 → 转待人工池
 *   - AI 回复轮数超限（连续追问未解决）→ 转待人工池
 *   - RAG 置信度低于阈值 → 转待人工池
 *   - 客户情绪负面/愤怒 → 转待人工池
 *
 * @param {string} conversationId
 * @param {Object} message - 入站消息对象
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<Object>}
 */
async function handleAiSelfPoolMessage(conversationId, message, eventEmitter, options = {}) {
  try {
    if (await require('../../services/configService').getConfig('ai_model_service_enabled') === false) return {replied:false,transferredToHuman:false,skipped:true,reason:'model_service_disabled'};
    // 0. 幂等保护：任务真正执行时，会话必须仍处于 AI 自助池。
    // 连续消息场景下，前面的任务可能已触发转人工/流转，后续残留任务不能再回复。
    // 如果入队后又收到更新的客户消息，旧任务也不应回复。
    const initialState = await getConversationAiState(conversationId, options.enqueuedAt, options.jobMarker, options.aiEpoch ?? 0)
    if (!initialState.canAiReply) {
      return { replied: false, transferredToHuman: false, skipped: true, reason: initialState.reason }
    }

    options = { ...options, aiEpoch: initialState.aiEpoch }

    // 1. 获取池配置
    const config = await poolService.getPoolConfig()
    const currentMessageText = extractMessageText(message)

    // 2. 非文本内容检测 — AI 无法处理图片/文件/语音
    const messageType = message.messageType || 'text'
    if (messageType !== 'text' || hasNonTextContent(message)) {
      // 非文本场景也要检测语言，确保非工作时间提示用客户语言
      const earlyLanguage = detectCustomerLanguage(currentMessageText, message)
      const reason = messageType !== 'text'
        ? `客户发送${messageType}消息，AI无法处理`
        : '消息包含非文本内容，AI无法处理'
      await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, earlyLanguage, { expectedEpoch: options.aiEpoch })
      return { replied: false, transferredToHuman: true, reason }
    }

    // 2.5 客户主动转人工关键词检测
    // 后台只配置中文关键词；matcher 会使用原文、中文译文和多语言语义兜底匹配。
    if (currentMessageText) {
      if (require('../ai-provider/replyProtocol').explicitHumanRequest(currentMessageText)) {
        const reason = '客户消息包含人工，客户主动请求转人工';
        await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, detectCustomerLanguage(currentMessageText, message));
        return { replied:false,transferredToHuman:true,reason,extra:buildAiLogExtra({transferTrigger:'customer_handoff_keyword',handoffKeyword:'人工'}) };
      }
      const handoffMatch = await matchCustomerHandoffKeyword({
        messageText: currentMessageText,
        message,
        config
      })
      if (handoffMatch.matched) {
        const reason = buildCustomerHandoffReason(handoffMatch)
        const customerLanguage = handoffMatch.customerLanguage || detectCustomerLanguage(currentMessageText, message)
        await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, customerLanguage, { expectedEpoch: options.aiEpoch })
        return {
          replied: false,
          transferredToHuman: true,
          reason,
          extra: buildAiLogExtra({
            transferTrigger: 'customer_handoff_keyword',
            handoffKeyword: handoffMatch.keyword,
            handoffMatchType: handoffMatch.matchType
          })
        }
      }
    }

    // 3. AI 回复轮数检测 — 连续追问说明问题未解决（0=不限制）
    const maxRounds = config.ai_max_rounds !== undefined ? parseInt(config.ai_max_rounds, 10) : 0
    if (maxRounds > 0) {
      const [msgCount] = await sequelize.query(
        `SELECT COUNT(*) AS cnt FROM plat_messages
         WHERE conversation_id = :conversationId AND direction = 'outbound' AND sender_type = 'ai' AND send_status = 'sent'`,
        { replacements: { conversationId } }
      )
      const aiReplyCount = msgCount[0]?.cnt || 0

      if (aiReplyCount >= maxRounds) {
        const earlyLanguage = detectCustomerLanguage(currentMessageText, message)
        const reason = `AI已回复${aiReplyCount}轮，客户仍在追问，判断需人工介入`
        await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, earlyLanguage, { expectedEpoch: options.aiEpoch })
        return { replied: false, transferredToHuman: true, reason }
      }
    }

    // 4. 合并连续客户消息：旧任务直接跳过，最新任务把最近一批连续客户文本一起回复。
    const mergedInput = await buildLatestCustomerInput(conversationId, message)
    const messageText = mergedInput.text
    if (mergedInput.count > 1) {
      console.log(`[AiAutoReply] 合并连续客户消息 ${mergedInput.count} 条后统一回复，会话 ${conversationId}`)
    }

    // 语言检测：优先用最新消息里的 originalLang，没有则对合并文本做 CJK 兜底
    const customerLanguage = detectCustomerLanguage(messageText, message)
    const customerLang = customerLanguage.group
    console.log('[AiAutoReply] 客户语言:', customerLang, customerLanguage.code || '', customerLanguage.label || '', '文本长度:', messageText.length)
    // 转人工统一由客户关键词和结构化 action 决定，避免独立情绪判断互相覆盖。


    // 5. 寒暄/打招呼检测（正则快速匹配 + LLM 兜底）
    //    这类消息不需要 RAG 知识库检索，AI 可以直接生成友好回复
    const isGreeting = isGreetingMessage(messageText)
    const isGreetingByLLM = !isGreeting && messageText && messageText.length <= 50
      ? await detectGreetingByLLM(messageText)
      : false

    if (isGreeting || isGreetingByLLM) {
      // 打招呼类消息，不需要 RAG，直接让 AI 生成友好回复
      console.log(`[AiAutoReply] 消息识别为寒暄/问候(${isGreeting ? '正则' : 'LLM'})，跳过RAG检索直接回复`)
      let greetingDecision = null
      const replyText = await generateAiReplyFromContext(conversationId, messageText, [], customerLanguage, { channel: message.channel, onDecision: value => { greetingDecision = value } })
      if (greetingDecision?.action === 'handoff') {
        const reason = `模型结构化决策要求转人工：${greetingDecision.reason}`
        await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, customerLanguage, { expectedEpoch: options.aiEpoch })
        return { replied:false,transferredToHuman:true,reason }
      }

      if (!replyText) {
        return { replied: false, transferredToHuman: false, error: '模型回复失败、为空或JSON格式不正确，等待重试' }
      }

      // 7. 发送前再次校验池状态，防止生成过程中其他任务已触发转人工/流转后仍误发。
      const sendState = await getConversationAiState(conversationId, options.enqueuedAt, options.jobMarker, options.aiEpoch ?? 0)
      if (!sendState.canAiReply) {
        return { replied: false, transferredToHuman: false, skipped: true, reason: sendState.reason }
      }

      // 8. 通过 WAHA 发送回复
      // 语言兜底检查：即使上游 ensureReplyLanguage 已控制，发送前再做一次安全网检查
      const { ensureOutputLanguage } = require('../../services/languageGuard')
      const guardedReplyText = await ensureOutputLanguage(replyText, conversationId, customerLanguage)
    const finalState = await getConversationAiState(conversationId, options.enqueuedAt, options.jobMarker, options.aiEpoch ?? 0)
    if (!finalState.canAiReply) return { replied: false, transferredToHuman: false, skipped: true, reason: finalState.reason }

      const delivery = await sendAiTextWithFallback({conversationId,message,text:guardedReplyText,eventEmitter,aiEpoch:options.aiEpoch})
      return {replied:!delivery.skipped,transferredToHuman:Boolean(delivery.transferredToHuman),reply:guardedReplyText,...delivery,confidence:1,greeting:true}

    }

    // 非寒暄消息，走 RAG 检索流程（messageText 就是客户原文）
    const retrieveResult = await retrieveWithContext(messageText, conversationId, extractMessageRetrievalText(message) || extractMessageText(message), message.channel, message.accountId)
    const confidenceThreshold = config.ai_confidence_threshold || 0.7
    const cautiousMin = config.ai_confidence_cautious_min || 0.4
    const topScore = retrieveResult.maxScore || 0
    const retrievalDiagnostics = buildRetrievalDiagnostics({
      queryText: messageText,
      retrieveQuery: retrieveResult.retrieveQuery,
      mergedMessageCount: mergedInput.count,
      contextDocs: retrieveResult.contextDocs,
      topScore,
      confidenceThreshold,
      cautiousMin
    })

    // Retrieval scores control caution; the validated reply protocol decides whether to clarify or hand off.
    // Missing retrieval evidence alone is not a handoff decision: the model may ask for missing information.

    // 6. 生成 RAG 回复（messageText 就是原文，传 customerLang + native_only 确保用原语言回复）
    let replyDecision = null
    const replyText = await generateAiReplyFromContext(conversationId, messageText, retrieveResult.contextDocs, customerLanguage, { channel: message.channel, onDecision:value => { replyDecision = value } })
    if (replyDecision?.action === 'handoff') {
      const reason = `模型结构化决策要求转人工：${replyDecision.reason}`
      await poolService.aiTransferToHuman(conversationId, reason, eventEmitter, customerLanguage, { expectedEpoch: options.aiEpoch })
      return { replied:false,transferredToHuman:true,reason,extra:buildAiLogExtra({retrieval:retrievalDiagnostics,transferTrigger:'model_json_handoff',handoffReason:replyDecision.reason}) }
    }
    if (!replyText) {
      return { replied: false, transferredToHuman: false, error: '模型回复失败、为空或JSON格式不正确，等待重试', extra: buildAiLogExtra({ retrieval: retrievalDiagnostics, transferTrigger: 'invalid_model_response' }) }
    }

    // 7. 发送前再次校验池状态，防止生成过程中其他任务已触发转人工/流转后仍误发。
    const sendState = await getConversationAiState(conversationId, options.enqueuedAt, options.jobMarker, options.aiEpoch ?? 0)
    if (!sendState.canAiReply) {
      return { replied: false, transferredToHuman: false, skipped: true, reason: sendState.reason }
    }

    // 8. 通过 WAHA 发送回复
    // 语言兜底检查：即使上游 ensureReplyLanguage 已控制，发送前再做一次安全网检查
    const { ensureOutputLanguage } = require('../../services/languageGuard')
    const guardedReplyText = await ensureOutputLanguage(replyText, conversationId, customerLanguage)
    const finalState = await getConversationAiState(conversationId, options.enqueuedAt, options.jobMarker, options.aiEpoch ?? 0)
    if (!finalState.canAiReply) return { replied: false, transferredToHuman: false, skipped: true, reason: finalState.reason }

    const delivery = await sendAiTextWithFallback({conversationId,message,text:guardedReplyText,eventEmitter,aiEpoch:options.aiEpoch})
    return {replied:!delivery.skipped,transferredToHuman:Boolean(delivery.transferredToHuman),reply:guardedReplyText,...delivery,confidence:topScore,extra:buildAiLogExtra({retrieval:retrievalDiagnostics})}

  } catch (err) {
    console.error('[AiAutoReply] 处理失败:', err.message)
    return { replied: false, transferredToHuman: false, error: err.message }
  }
}

/**
 * RAG 检索并返回置信度
 *
 * @param {string} queryText
 * @returns {Promise<{ contextDocs: Array, maxScore: number }>}
 */
async function getAccountKnowledgeMetadata(accountId) {
  if (!accountId) return {}
  try {
    const [rows] = await sequelize.query(
      `SELECT knowledge_scope, knowledge_channels FROM channel_accounts WHERE id = :accountId LIMIT 1`,
      { replacements: { accountId } }
    )
    const row = rows[0] || {}
    return {
      knowledgeScope: row.knowledge_scope,
      knowledgeChannels: row.knowledge_channels
    }
  } catch (err) {
    console.warn('[AiAutoReply] 获取账号知识归类失败:', err.message)
    return {}
  }
}

async function retrieveWithContext(queryText, conversationId = null, retrievalText = null, channel = null, accountId = null) {
  if (!queryText) return { contextDocs: [], maxScore: 0, retrieveQuery: '' }

  try {
    // The configured Bailian index is the knowledge boundary for this local service.
    // Chat history is supplied to the answer model, never to knowledge retrieval.
    const retrieveQuery = require('../ai-provider/replyContext').buildKnowledgeQuery(retrievalText || queryText)
    const retrieveResult = await getRagService().retrieve({
      query: retrieveQuery,
      denseSimilarityTopK: 5,
      sparseSimilarityTopK: 5,
      enableReranking: true,
      rerankTopN: 5
    })

    const contextDocs = retrieveResult.nodes || []
    const maxScore = contextDocs.length > 0
      ? Math.max(...contextDocs.map(n => n.score || 0))
      : 0

    return { contextDocs, maxScore, retrieveQuery }
  } catch (err) {
    console.error('[AiAutoReply] RAG检索失败:', err.message)
    return { contextDocs: [], maxScore: 0, retrieveQuery: retrievalText || queryText || '' }
  }
}

/**
 * 使用 RAG 上下文生成 AI 回复
 *
 * @param {string} conversationId
 * @param {string} queryText - 客户原文（非翻译后的中文）
 * @param {Array} contextDocs
 * @param {Object|string} customerLanguage - 客户语言信息，{ group, code, label }
 * @returns {Promise<string>}
 */
async function generateAiReplyFromContext(conversationId, queryText, contextDocs, customerLanguage = { group: 'zh' }, extraOptions = {}) {
  try {
    if (!queryText) return ''

    const langInfo = normalizeCustomerLanguage(customerLanguage)
    const { systemPromptOverride = null, systemPromptAppend = null } = extraOptions

    // 1. 获取会话上下文
    const configService = require('../../services/configService')
    const rawLlmContextCount = (await require('../ai-provider/providerService').getProviderService().getReplySettings()).contextMessageCount
    const parsedLlmContextCount = parseInt(rawLlmContextCount, 10)
    const llmContextCount = Number.isFinite(parsedLlmContextCount)
      ? Math.max(0, Math.min(parsedLlmContextCount, 100))
      : 20
    const history = await messagingService.getConversationContext(conversationId, llmContextCount)

    // 2. 流式生成回复
    // AI 自助回复直接发给客户，用 native_only 模式：非中文客户只追加"用原语言回复"指令，不生成中文翻译
    const langchainSvc = getLangchainService()
    const aiModel = await getAiSelfReplyModel()
    const generator = langchainSvc.generateRecommendationStream(
      queryText,
      history,
      contextDocs,
      {
        model: aiModel,
        temperature: 0.7,
        maxContextTokens: 4000,
        customerLang: langInfo.group,
        customerLangCode: langInfo.code,
        customerLangLabel: langInfo.label,
        langMode: 'native_only',
        trackReplyHealth: true,
        structuredReply: true,
        channel: extraOptions.channel,
        historyIncludesCurrent: true,
        systemPromptOverride,
        systemPromptAppend
      }
    )

    let fullResponse = ''
    for await (const chunk of generator) {
      if (chunk.type === 'decision') extraOptions.onDecision?.(chunk)
      if (chunk.type === 'error') throw new Error('客服模型生成失败')
      if (chunk.type === 'text') {
        fullResponse += chunk.content
      }
    }

    const replyText = fullResponse.trim()
    const dedupedReplyText = dedupeRepeatedSalesCta(replyText, history)
    if (dedupedReplyText !== replyText) {
      console.log('[AiAutoReply] Removed repeated sales CTA from generated reply')
    }
    const { sanitizeCustomerOutputText } = require('../../services/languageGuard')
    const sanitizedReplyText = sanitizeCustomerOutputText(dedupedReplyText)
    if (sanitizedReplyText !== dedupedReplyText) {
      console.warn('[AiAutoReply] 生成回复包含内部来源标记，已在生成阶段清理')
    }
    return await ensureReplyLanguage(sanitizedReplyText, langInfo)
  } catch (err) {
    console.error('[AiAutoReply] 生成回复失败:', err.message)
    return ''
  }
}

/**
 * 客户情绪分析
 *
 * 使用 LLM 判断客户消息的情绪状态，负面/愤怒情绪触发转人工
 *
 * @param {string} messageText
 * @param {Object} config
 * @returns {Promise<{ isNegative: boolean, label: string }>}
 */
async function analyzeSentiment(messageText, config) {
  try {
    const langchainSvc = getLangchainService()
    const model = config.sentiment_check_model || DASHSCOPE_MODEL

    const systemPrompt = `你是一个情绪分析助手。请判断以下客户消息的情绪状态。

只回复 JSON 格式：{"is_negative": true/false, "label": "情绪标签"}
情绪标签可选：正常、中性、不满、愤怒、焦虑、急切

判断标准：
- is_negative = true：仅当消息明确包含愤怒、辱骂、威胁投诉、强烈不满等情绪时才为 true。催促、着急、询问进度等不算负面情绪。
- is_negative = false：正常咨询、中性语气、友好交流、催促进度、着急但不带攻击性

重要：客户表达"急切""快点""很急""什么时候能回复"等催促用语时，is_negative = false。这些只是客户表达紧迫感，并非对服务不满。

不要回复其他任何内容。`

    const userMessage = `客户消息：${messageText}`

    const generator = langchainSvc.generateRecommendationStream(
      userMessage,
      [],
      [],
      { model, temperature: 0.1, maxContextTokens: 300, systemPromptOverride: systemPrompt }
    )

    let fullResponse = ''
    for await (const chunk of generator) {
      if (chunk.type === 'text') {
        fullResponse += chunk.content
      }
    }

    // 解析 JSON
    const jsonMatch = fullResponse.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        isNegative: !!parsed.is_negative,
        label: parsed.label || '未知'
      }
    }

    return { isNegative: false, label: '解析失败' }
  } catch (err) {
    console.error('[AiAutoReply] 情绪分析失败:', err.message)
    return { isNegative: false, label: '分析异常' }
  }
}

/**
 * 检查消息是否包含非文本内容
 *
 * 关键逻辑：如果消息有可读文本内容(text字段非空)，即使同时附带 emoji/贴纸等，
 * 也不应判定为"非文本"——AI 可以处理带 emoji 的纯文本对话。
 * 只有当 text 为空且存在真正的媒体内容时才返回 true。
 */
async function getConversationAiState(conversationId, enqueuedAt = null, jobMarker = null, expectedEpoch = null) {
  try {
    if (await require('../../services/configService').getConfig('ai_model_service_enabled') === false) return {canAiReply:false,reason:'model_service_disabled'};
    const [rows] = await sequelize.query(
      `SELECT pool_type, conv_status, conversations.status, conversations.ai_epoch, conversations.claimed_by, a.adapter_type FROM conversations LEFT JOIN channel_accounts a ON a.id = conversations.account_id WHERE conversations.id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { canAiReply: false, reason: '会话不存在' }
    }

    const conv = rows[0]
    if (expectedEpoch != null && Number(conv.ai_epoch || 0) !== Number(expectedEpoch)) return { canAiReply:false,reason:'人工接管后旧AI任务已作废' }
    if (!isAiReplyEligible(conv)) {
      return {
        canAiReply: false,
        reason: `会话当前为 ${conv.pool_type}/${conv.conv_status}，不是 ${POOL_TYPE.AI_SELF}/${CONV_STATUS.AI_SERVING}`
      }
    }

    if (jobMarker) {
      const isLatest = await isLatestAiReplyJob(conversationId, jobMarker)
      if (!isLatest) {
        return { canAiReply: false, reason: '当前任务不是该会话最新的 AI 回复任务' }
      }
    }

    if (enqueuedAt) {
      const [newerRows] = await sequelize.query(
        `SELECT COUNT(*) AS cnt
         FROM plat_messages
         WHERE conversation_id = :conversationId
           AND direction = 'inbound'
           AND sender_type = 'customer'
           AND created_at > FROM_UNIXTIME(:enqueuedAtMs / 1000)`,
        { replacements: { conversationId, enqueuedAtMs: enqueuedAt } }
      )
      const newerCount = newerRows[0]?.cnt || 0
      if (newerCount > 0) {
        return { canAiReply: false, reason: `任务入队后又收到 ${newerCount} 条新客户消息，跳过旧任务` }
      }
    }

    return { canAiReply: true, aiEpoch: Number(conv.ai_epoch || 0) }
  } catch (err) {
    console.error('[AiAutoReply] 查询会话AI状态失败:', err.message)
    // 状态不明时保守跳过，避免误发客户消息。
    return { canAiReply: false, reason: '查询会话AI状态失败: ' + err.message }
  }
}

function hasNonTextContent(message) {
  try {
    const content = message.content || {}
    if (typeof content === 'string') return false

    // 如果有可读文本，不判定为非文本（即使同时有 emoji/贴纸等）
    const text = content.text || content.content || ''
    if (text && typeof text === 'string' && text.trim().length > 0) {
      return false
    }

    // 无文本内容，检查是否有真正的媒体字段
    const mediaKeys = ['image', 'file', 'audio', 'video', 'media', 'attachment', 'document']
    for (const key of mediaKeys) {
      if (content[key] || content[key + '_url'] || content[key + 'Url']) {
        return true
      }
    }
    if (content.messageType && content.messageType !== 'text') {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 从消息对象中提取文本
 * 重构后 content.text 就是客户原文（入库时不再被译文覆盖）
 */
function extractMessageText(message) {
  try {
    const content = message.content || {}
    if (typeof content === 'string') return content
    return content.text || content.content || ''
  } catch {
    return ''
  }
}

function extractMessageRetrievalText(message) {
  try {
    const content = message.content || {}
    if (typeof content === 'string') return content
    return buildRetrievalText(content.text || content.content || '', content.translatedText || '')
  } catch {
    return ''
  }
}

function buildRetrievalText(originalText, translatedText) {
  const original = String(originalText || '').trim()
  const translated = String(translatedText || '').trim()

  if (translated && translated !== original) {
    return [translated, original].filter(Boolean).join('\n')
  }
  return original || translated
}

async function getRecentCustomerRetrievalTexts(conversationId, limit = 3) {
  if (!conversationId || limit <= 0) return []

  try {
    const [rows] = await sequelize.query(
      `SELECT content
       FROM plat_messages
       WHERE conversation_id = :conversationId
         AND direction = 'inbound'
         AND sender_type = 'customer'
         AND message_type = 'text'
       ORDER BY created_at DESC
       LIMIT :limit`,
      { replacements: { conversationId, limit } }
    )

    return rows
      .reverse()
      .map(row => extractStoredContentRetrievalText(row.content))
      .filter(Boolean)
  } catch (err) {
    console.error('[AiAutoReply] 获取RAG检索历史失败:', err.message)
    return []
  }
}

async function buildLatestCustomerInput(conversationId, fallbackMessage) {
  const fallbackText = extractMessageText(fallbackMessage)
  const fallbackRetrievalText = extractMessageRetrievalText(fallbackMessage) || fallbackText
  if (!conversationId) {
    return { text: fallbackText, retrievalText: fallbackRetrievalText, count: fallbackText ? 1 : 0, messages: fallbackText ? [fallbackText] : [] }
  }

  let mergeWindowSeconds = 120
  let mergeMaxMessages = 5
  try {
    const configService = require('../../services/configService')
    mergeWindowSeconds = await configService.getConfig('ai_merge_window_seconds')
    mergeMaxMessages = await configService.getConfig('ai_merge_max_messages')
  } catch {
    // 配置读取失败时使用默认值
  }

  try {
    const [rows] = await sequelize.query(
      `SELECT direction, sender_type, message_type, content, created_at
       FROM plat_messages
       WHERE conversation_id = :conversationId
       ORDER BY created_at DESC
       LIMIT 20`,
      { replacements: { conversationId } }
    )

    if (!rows.length) {
      return { text: fallbackText, retrievalText: fallbackRetrievalText, count: fallbackText ? 1 : 0, messages: fallbackText ? [fallbackText] : [] }
    }

    const newestTimestamp = rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : Date.now()
    const mergedMessages = []
    const mergedRetrievalMessages = []

    for (const row of rows) {
      const rowTime = row?.created_at ? new Date(row.created_at).getTime() : newestTimestamp
      if (newestTimestamp - rowTime > mergeWindowSeconds * 1000) {
        break
      }

      if (row.direction !== 'inbound' || row.sender_type !== 'customer') {
        break
      }

      if (row.message_type !== 'text') {
        break
      }

      const text = extractStoredContentText(row.content)
      if (!text) {
        continue
      }

      mergedMessages.push(text)
      mergedRetrievalMessages.push(extractStoredContentRetrievalText(row.content) || text)
      if (mergedMessages.length >= mergeMaxMessages) {
        break
      }
    }

    if (mergedMessages.length === 0) {
      return { text: fallbackText, retrievalText: fallbackRetrievalText, count: fallbackText ? 1 : 0, messages: fallbackText ? [fallbackText] : [] }
    }

    const orderedMessages = mergedMessages.reverse()
    const orderedRetrievalMessages = mergedRetrievalMessages.reverse()
    return {
      text: formatMergedCustomerMessages(orderedMessages),
      retrievalText: formatMergedCustomerMessages(orderedRetrievalMessages),
      count: orderedMessages.length,
      messages: orderedMessages
    }
  } catch (err) {
    console.error('[AiAutoReply] 合并连续客户消息失败，回退到当前消息:', err.message)
    return { text: fallbackText, retrievalText: fallbackRetrievalText, count: fallbackText ? 1 : 0, messages: fallbackText ? [fallbackText] : [] }
  }
}

function extractStoredContentText(content) {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content || {}
    if (typeof parsed === 'string') return parsed
    return parsed.text || parsed.content || ''
  } catch {
    return typeof content === 'string' ? content : ''
  }
}

function extractStoredContentRetrievalText(content) {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content || {}
    if (typeof parsed === 'string') return parsed
    return buildRetrievalText(parsed.text || parsed.content || '', parsed.translatedText || '')
  } catch {
    return typeof content === 'string' ? content : ''
  }
}

function formatMergedCustomerMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  if (messages.length === 1) return messages[0]

  return [
    '客户连续发送了以下几条消息，请结合全部内容统一回复：',
    ...messages.map((text, index) => `${index + 1}. ${text}`)
  ].join('\n')
}

/**
 * 检测客户语言：优先用入库时存的 originalLang，没有则用 CJK 占比兜底
 * @param {string} text - 消息文本（原文）
 * @param {Object} message - 消息对象（可选，用于读 originalLang 字段）
 * @returns {'zh'|'other'}
 */
function detectCustomerLang(text, message) {
  return detectCustomerLanguage(text, message).group
}

function detectCustomerLanguage(text, message) {
  // 优先用入库时翻译服务检测的语言
  if (message) {
    try {
      const content = message.content || {}
      if (typeof content !== 'string') {
        const lang = content.originalLang
        if (lang && lang !== 'unknown') {
          return {
            group: lang === 'zh' ? 'zh' : 'other',
            code: lang,
            label: content.langLabel || languageLabelFromCode(lang)
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 兜底：CJK 占比 < 0.3 判为非中文；含明显拉丁字母时按英文处理
  if (!text) return { group: 'zh', code: 'zh', label: '中文' }
  const compactText = text.replace(/\s/g, '')
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  const totalChars = compactText.length
  if (totalChars > 0 && cjkCount / totalChars < 0.3) {
    const code = /[a-zA-Z]{3,}/.test(text) ? 'en' : 'other'
    return { group: 'other', code, label: languageLabelFromCode(code) }
  }
  return { group: 'zh', code: 'zh', label: '中文' }
}

function normalizeCustomerLanguage(customerLanguage) {
  if (typeof customerLanguage === 'string') {
    return {
      group: customerLanguage === 'other' ? 'other' : 'zh',
      code: customerLanguage === 'other' ? 'other' : 'zh',
      label: customerLanguage === 'other' ? '客户消息的原语言' : '中文'
    }
  }
  const group = customerLanguage?.group === 'other' ? 'other' : 'zh'
  const code = customerLanguage?.code || (group === 'other' ? 'other' : 'zh')
  return {
    group,
    code,
    label: customerLanguage?.label || languageLabelFromCode(code)
  }
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

async function ensureReplyLanguage(replyText, langInfo) {
  if (!replyText || langInfo.group !== 'other' || !looksChinese(replyText)) {
    return replyText
  }

  try {
    const targetLang = langInfo.label || languageLabelFromCode(langInfo.code)
    console.warn(`[AiAutoReply] 检测到 native_only 回复含中文，自动翻译回客户语言: ${targetLang}`)
    const configService = require('../../services/configService')
    const translateModel = await configService.getConfig('llm_translate_model')
    const { translateFromChinese } = require('../../services/translationService')
    return await translateFromChinese(replyText, targetLang, translateModel)
  } catch (err) {
    console.error('[AiAutoReply] 回复语言兜底转换失败，使用原回复:', err.message)
    return replyText
  }
}

function looksChinese(text) {
  if (!text) return false
  const compactText = text.replace(/\s/g, '')
  if (!compactText) return false
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return cjkCount / compactText.length >= 0.3
}

/**
 * 判断消息是否为寒暄/打招呼/简单问候类
 *
 * 这类消息不需要 RAG 知识库检索，AI 可以直接生成友好回复。
 * 匹配规则：
 *  - 多语言常见打招呼词汇（中/英/阿/西/法/德/日/韩/俄/葡/土耳其/波斯/印尼/印地/乌尔都）
 *  - 消息短（≤30字符）且不含具体业务问题
 *
 * @param {string} text
 * @returns {boolean}
 */
function isGreetingMessage(text) {
  if (!text) return false
  const trimmed = text.trim().toLowerCase()
  if (!trimmed || trimmed.length > 30) return false

  // 多语言常见寒暄/打招呼词汇
  const greetingPatterns = [
    // ===== 英语 =====
    /^hello[!！.。~]?$/, /^hi[!！.。~]?$/, /^hey[!！~]?$/, /^heya[!！]?$/, /^heyya?[!！]?$/, /^yo[!！]?$/,
    /^good\s*(morning|afternoon|evening|day)[!！.。~]?$/,
    /^how\s*are\s*you\??$/, /^how'?s\s*it\s*going\??$/, /^howdy$/,
    /^hiya$/, /^what'?s\s*up\??$/, /^sup\??$/, /^wassup\??$/,
    /^greetings$/, /^nice\s*to\s*meet\s*you$/, /^pleased?\s*to\s*meet\s*you$/,
    /^how\s*can\s*i\s*help\s*you\??$/, /^how\s*may\s*i\s*help\??$/,
    /^are\s*you\s*there\??$/, /^anyone\s*there\??$/, /^you\s*there\??$/,
    /^is\s*anyone\s*available\??$/, /^hello\s*there$/, /^good\s*to\s*see\s*you$/,
    /^hey\s*there$/, /^long\s*time\s*no\s*see$|^lttns$/,

    // ===== 中文 =====
    /^你好[!！。.~]??$/, /^您好[!！。.]??$/, /^在吗[?？]??$/, /^在么[?？]??$/,
    /^有人吗[?？]??$/, /^哈喽[!！~]??$/, /^哈罗[!！]??$/, /^嗨[~！!]??$/,
    /^早上好[!！。]??$/, /^下午好[!！。]??$/, /^晚上好[!！。]??$/,
    /^你好呀[!！~]??$/, /^最近好吗[?？]??$/, /^在不在[?？]??$/,
    /^亲[~！!]??$/, /^老板好[!！。]??$/, /^大哥好[!！。]??$/,
    /^哈喽啊[!！]??$/, /^你好啊[!！~]??$/, /^大家?好[!！。]??$/,
    /^好久不见[!！。]??$/, /^在吗亲[?？]??$/, /^亲在吗[?？]??$/,
    /^客服好[!！]??$/, /^你好老板[!！]??$/,

    // ===== 阿拉伯语 =====
    /^مرحبا[اً]??$/,  // marhaba
    /^السلام\s*عليكم$/,  // assalamu alaykum
    /^اهلا[اً]??$/,  // ahlan
    /^اهلا?\s*وسهلا[اً]??$/,  // ahlan wa sahlan
    /^صباح\s*الخير$/,  // sabah al-khayr
    /^مساء\s*الخير$/,  // masaa' al-khayr
    /^كيف\s*حالك[؟?]??$/,  // kayf halak
    /^كيف\s*الحال[؟?]??$/,  // kayf al-hal
    /^هلا[اً]?$/,  // hala
    /^هاي[اً]?$/,  // hai (Arabic transliteration)
    /^من\s*تواصل\s*معي[؟?]??$/,  // who is contacting me
    /^هل\s*أحد\s*هنا[؟?]??$/,  // is anyone there

    // ===== 西班牙语 =====
    /^hola[!！]??$/, /^buenos?\s*d[ií]as$/, /^buenas?\s*tardes$/,
    /^buenas?\s*noches$/, /^qué\s*tal[?？]??$/, /^que\s*tal[?？]??$/,
    /^cómo\s*est[áa]s[?？]??$/, /^como\s*est[áa]s[?？]??$/,
    /^cómo\s*est[áa][?？]??$/, /^cómo\s*va\s*todo[?？]??$/,
    /^encantado\s*de\s*conocerte$/, /^mucho\s*gusto$/,
    /^alguien\s*est[áa]\s*ah[ií][?？]??$/, /^hay\s*alguien[?？]??$/,
    /^hola\s*amigo[!！]??$/, /^saludos$/,

    // ===== 法语 =====
    /^bonjour[!！]??$/, /^bonsoir[!！]??$/, /^salut[!！]??$/,
    /^coucou[!！]??$/, /^comment\s*[çca]\s*va[?？]??$/,
    /^comment\s*allez[-\s]*vous[?？]??$/, /^ça\s*va[?？]??$/,
    /^enchant[ée]$/, /^ravi\s*de\s*vous\s*rencontrer$/,
    /^quelqu'un\s*est[-\s]l[àa][?？]??$/, /^y'a\s*t?-il\s*quelqu'un[?？]??$/,

    // ===== 德语 =====
    /^hallo[!！]??$/, /^guten\s*morgen$/, /^guten\s*tag$/,
    /^guten\s*abend$/, /^hi[!！]??$/, /^servus[!！]??$/,
    /^wie\s*geht'?s\s*dir[?？]??$/, /^wie\s*geht\s*es\s* Ihnen[?？]??$/,
    /^schön\s* dich\s* kennenzulernen$/, /^ist\s*jemand\s*da[?？]??$/,
    /^ist\s*jemand\s*online[?？]??$/,

    // ===== 日语（罗马音 + 假名/汉字）=====
    /^konnichiwa[!！]??$/, /^こんにちは[!！]??$/, /^konbanwa[!！]??$/, /^こんばんは[!！]??$/,
    /^ohayou?gozaimasu$/, /^おはよう[ございます]??$/,
    /^yahallo[!！]??$/, /^やあ[!！]??$/, /^moshi[-\s]*moshi[!！]??$/, /^もしもし[!！]??$/,
    /^genki[?？]??$/, /^元気[?？]??$/,
    /^hajimemashite$/, /^初めまして$/,

    // ===== 韩语 =====
    /^안녕하세요[!！]??$/, /^안녕[!！]??$/,
    /^반갑습니다[!！.]??$/, /^처음\s*뵙겠습니다$/,
    /^누구\s*계세요[?？]??$/, /^거기\s*계세요[?？]??$/,
    /^안녕히\s*가세요$/, /^안녕히\s*계세요$/,

    // ===== 俄语 =====
    /^привет[!！]??$/, /^здравствуй(те)?[!！.]??$/,
    /^доброе\s*утро$/, /^добрый\s*день$/, /^добрый\s*вечер$/,
    /^как\s*дела[?？]??$/, /^как\s*ты[?？]??$/,
    /^кто\s*здесь[?？]??$/, /^есть\s*кто[-\s]*нибудь[?？]??$/,
    /^рад\s*познакомиться$/,

    // ===== 葡萄牙语 =====
    /^ol[áa][!！]??$/, /^bom\s*dia$/, /^boa\s*tarde$/, /^boa\s*noite$/,
    /^oi[!！]??$/, /^eai?[!！]??$/, /^e\s*a[ií][?？]??$/,
    /^como\s*vai\s*voc[êe][?？]??$/, /^como\s*est[áa]\s*voc[êe][?？]??$/,
    /^tudo\s*bem[?？]??$/, /^prazer\s*em\s*conhec[êe]-lo$/,
    /^algu[ée]m\s*est[áa]\s*a[ií][?？]??$/, /^h[áa]\s*algu[ée]m[?？]??$/,

    // ===== 土耳其语 =====
    /^merhaba[!！]??$/, /^selam[!！]??$/, /^selamlar[!！]??$/,
    /^g[üu]nayd[ıi]n$/, /^iyi?\s*g[üu]nler$/, /^iyi?\s*ak[sş]amlar$/,
    /^nas[ıi]ls[ıi]n[?？]??$/, /^naber[?？]??$/,
    /^var\s*m[ıi]\s*biri$/, /^kimse\s*var\s*m[ıi][?？]??$/,

    // ===== 波斯语 (Farsi) =====
    /^سلام[!！]??$/, /^درود[!！]??$/, /^صبح\s*بخیر$/,
    /^شب\s*بخیر$/, /^خوش\s*آمدید$/, /^چطوری[?؟]??$/,
    /^حالت\s*چطوره[?؟]??$/, /^کسی\s*هست[?؟]??$/,

    // ===== 印尼语/马来语 =====
    /^halo[!！]??$/, /^hai[!！]??$/, /^selamat\s*pagi$/,
    /^selamat\s*siang$/, /^selamat\s*sore$/, /^selamat\s*malam$/,
    /^apa\s*kabar[?？]??$/, /^bagaimana\s*kabarmu[?？]??$/,
    /^ada\s*orang\s*di\s*sini[?？]??$/, /^ada\s*siapa\s*di\s*sana[?？]??$/,

    // ===== 印地语 =====
    /^नमस्ते[!！]??$/, /^नमस्कार[!！]??$/,
    /^suprabhat$/, /^शुभ\s*संध्या$/,
    /^aap\s*kaise\s*hain[?？]??$/, /^kya\s*haal\s*hain[?？]??$/,
    /^koi\s*hai[?？]??$/, /^कोई\s*है[?？]??$/,
    /^hello\s*bhai[!！]??$/,

    // ===== 乌尔都语 =====
    /^آسلام\s*علیکم$/, /^ہیلو[!！]??$/, /^السلام\s*علیکم$/,
    /^صبح\s*بخیر$/, /^شام\s*بخیر$/,
    /^آپ\s*کیسی\s*ہیں[?？]??$/, /^کیا\s*حال\s*ہے[?؟]??$/,
    /^کوئی\s*ہے[?？]??$/,

    // ===== 泰语 =====
    /^สวัสดี[ครับค่ะ]??$/, /^หวัดดี[ครับค่ะ]??$/,
    /^อรุณสวัสดิ์[ครับค่ะ]??$/, /^สายัญค่ะ??$/, /^ราตรีสวัสดิ์[ครับค่ะ]??$/,
    /^เป็นไงบ้าง[?？]??$/, /^สบายดีไหม[?？]??$/,
    /^มีใครไหม[?？]??$/,

    // ===== 越南语 =====
    /^xin\s*ch[ào][!！.]??$/, /^ch[ào]\s*anh[!！.]??$/, /^ch[ào]\s*chị[!！.]??$/,
    /^em\s*ch[ào][!！.]??$/, /^ch[ào]\s*b[àa]n[!！.]??$/,
    /^b[ai?]\n\s*khoe?\s*khong[?？]??$/, /^b[ai?]\n\s*co\s*khong[?？]??$/,
    /^có\s*ai\s*khong[?？]??$/,

    // ===== 意大利语 =====
    /^ciao[!！]??$/, /^salve[!！]??$/,
    /^buongiorno[!！]??$/, /^buonasera[!！]??$/, /^buonanotte[!！]??$/,
    /^come\s*stai[?？]??$/, /^come\s*va[?？]??$/,
    /^piacere\s*di\s*conoscerti$/, /^c'?è?\s*qualcuno[?？]??$/,
    /^qualcuno\s*online[?？]??$/
  ]

  return greetingPatterns.some(pattern => pattern.test(trimmed))
}

/**
 * 使用 LLM 判断消息是否为寒暄/打招呼类
 *
 * 正则匹配覆盖有限，LLM 可以识别各种语言的寒暄变体、方言、俚语等。
 * 仅在正则未命中且消息较短（≤50字符）时调用，控制成本。
 *
 * @param {string} messageText
 * @returns {Promise<boolean>}
 */
async function detectGreetingByLLM(messageText) {
  try {
    const langchainSvc = getLangchainService()
    const configService = require('../../services/configService')
    const model = await configService.getConfig('ai_self_reply_model') || 'deepseek-v4-flash'

    const systemPrompt = `你是一个消息分类助手。请判断以下客户消息是否属于"寒暄/打招呼/简单问候"类。

属于寒暄/打招呼的特征：
- 各种语言的打招呼词汇（hello/hi/hola/你好/مرحبا/привет 等）
- 简单的问候（how are you / 最近好吗 / nasılsın 等）
- 礼貌用语（nice to meet you / 很高兴认识你 等）
- 确认对方在线（are you there / 在吗 / 有人吗 等）
- 时间问候（good morning / 早上好 / bonjour 等）

不属于寒暄的特征：
- 包含具体业务问题（价格、产品、订单、技术等）
- 包含具体需求描述
- 投诉或情绪表达
- 询问具体信息

只回复一个单词：YES（是寒暄） 或 NO（不是寒暄），不要添加任何其他内容。`

    const userMessage = `客户消息：${messageText}`

    const generator = langchainSvc.generateRecommendationStream(
      userMessage,
      [],
      [],
      { model, temperature: 0.1, maxContextTokens: 100, systemPromptOverride: systemPrompt }
    )

    let fullResponse = ''
    for await (const chunk of generator) {
      if (chunk.type === 'text') {
        fullResponse += chunk.content
      }
    }

    const trimmed = fullResponse.trim().toUpperCase()
    const isGreeting = trimmed.includes('YES') && !trimmed.includes('NO')

    console.log(`[AiAutoReply] LLM寒暄检测: ${isGreeting ? '是' : '否'} (消息长度: ${messageText.length})`)
    return isGreeting
  } catch (err) {
    console.error('[AiAutoReply] LLM寒暄检测异常，跳过:', err.message)
    return false
  }
}

// 兼容旧接口：保留 generateAiReply 函数名
async function generateAiReply(conversationId, queryText) {
  const { contextDocs } = await retrieveWithContext(queryText)
  return generateAiReplyFromContext(conversationId, queryText, contextDocs)
}

module.exports = {
  handleAiSelfPoolMessage,
  generateAiReply,
  retrieveWithContext,
  analyzeSentiment,
  getReplyHumanHandoffReason
}

async function sendAiTextWithFallback({conversationId,message,text,eventEmitter,aiEpoch}) {
  const bridge = await getDesktopBridgeAdapter(message)
  const dispatcher = getDispatcher(), adapter = getWahaAdapter()
  const dispatch = async payload => {
    if (bridge) return bridge.sendMessage(message.accountId,payload.targetUserId,{content:payload.content,messageType:payload.messageType,localMessageId:payload.localMessageId})
    if (dispatcher) return dispatcher.dispatch(payload)
    if (adapter && message.channel === 'whatsapp') return adapter.sendMessage(message.accountId,payload.targetUserId,{content:payload.content,messageType:payload.messageType})
    return {success:false,status:'failed',error:'发送通道未就绪'}
  }
  return require('./aiDeliveryFallback').runtime(eventEmitter).sendText({conversationId,localMessageId:crypto.randomUUID(),channel:message.channel,accountId:message.accountId,targetUserId:message.channelUserId||message.userId,messageType:'text',aiEpoch,content:{text}},dispatch)
}
