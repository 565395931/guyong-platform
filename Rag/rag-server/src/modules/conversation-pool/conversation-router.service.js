/**
 * 会话入口路由服务
 *
 * 核心前提：AI 自助回复不会告知客户其是 AI，客户全程无感知。
 * 所有"转人工"决策由系统自动完成，不依赖客户主动触发。
 *
 * 路由决策顺序（优先级从高到低）：
 *   1. 客户历史检测 — 有历史会话记录的老客户，直接进入待人工池
 *   2. 系统复杂度判断 — LLM 判断新客户问题是否复杂/紧急，复杂则进入待人工池
 *   3. 非文本检测 — 含图片/文件/语音等 AI 无法处理的内容，进入待人工池
 *   4. 以上都不满足 — 进入 AI 自助池，AI 自动回复
 *
 * 调用入口：messaging.service.findOrCreateConversation → 本服务
 */

const { sequelize } = require('../../config/database')
const poolService = require('./pool.service')
const { POOL_TYPE, CONV_STATUS } = require('./constants')
const { SystemMessage, HumanMessage } = require('@langchain/core/messages')
const {
  matchCustomerHandoffKeyword,
  buildCustomerHandoffReason
} = require('./handoff-keyword.service')

// 延迟加载 langchainService 和 createChatModel，用于复杂度判断
let langchainService = null
let createChatModelFn = null
function getLangchainService() {
  if (!langchainService) {
    const svc = require('../rag/langchainService')
    langchainService = svc
    createChatModelFn = svc.createChatModel
  }
  return langchainService
}

const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus'

/**
 * 判断新会话应进入哪个池
 *
 * @param {Object} message - 标准化的消息对象（含 channel, accountId, channelUserId, content, messageType 等）
 * @returns {Promise<{ poolType: string, convStatus: string, reason: string }>}
 */
async function routeNewConversation(message) {
  try {
    // 读取池配置
    const config = await poolService.getPoolConfig()

    // 如果 AI 自助池总开关关闭，所有新会话进入待人工池
    if (config.ai_self_pool_enabled === false) {
      return {
        poolType: POOL_TYPE.PENDING_HUMAN,
        convStatus: CONV_STATUS.PENDING_CLAIM,
        reason: 'AI自助池已关闭，转待人工池'
      }
    }

    const channelUserId = message.channelUserId || message.userId || null
    const channel = message.channel
    const accountId = message.accountId || null

    // ========== 第1步：客户历史检测（最高优先级） ==========
    if (channelUserId) {
      const hasHistory = await checkUserHistory(channel, accountId, channelUserId)
      if (hasHistory) {
        return {
          poolType: POOL_TYPE.PENDING_HUMAN,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          reason: '老客户直通人工（有历史会话记录）'
        }
      }
    }

    // ========== 第2步：非文本检测 ==========
    // 先做快速判断（不依赖 LLM），含非文本内容直接转人工
    const messageType = message.messageType || 'text'
    if (messageType !== 'text') {
      return {
        poolType: POOL_TYPE.PENDING_HUMAN,
        convStatus: CONV_STATUS.PENDING_CLAIM,
        reason: `消息类型为${messageType}，AI无法处理非文本内容`
      }
    }

    // 检查消息内容中是否包含媒体引用
    const messageText = extractMessageText(message)
    if (hasNonTextContent(message)) {
      return {
        poolType: POOL_TYPE.PENDING_HUMAN,
        convStatus: CONV_STATUS.PENDING_CLAIM,
        reason: '消息包含非文本内容，AI无法处理'
      }
    }

    // ========== 第3步：客户主动转人工关键词 ==========
    // 后台只维护中文关键词；matcher 会用原文、中文译文和多语言语义判断统一匹配。
    if (messageText) {
      const handoffMatch = await matchCustomerHandoffKeyword({
        messageText,
        message,
        config
      })
      if (handoffMatch.matched) {
        return {
          poolType: POOL_TYPE.PENDING_HUMAN,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          reason: buildCustomerHandoffReason(handoffMatch)
        }
      }
    }

    // ========== 第4步：系统复杂度判断（LLM） ==========
    // 仅对纯文本的新客户消息进行 LLM 复杂度判断
    const complexityEnabled = config.complexity_check_enabled !== false
    if (complexityEnabled && messageText) {
      const isComplex = await checkComplexity(messageText, config)
      if (isComplex.needHuman) {
        return {
          poolType: POOL_TYPE.PENDING_HUMAN,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          reason: `系统判断需人工：${isComplex.reason}`
        }
      }
    }

    // ========== 以上都不满足 → AI 自助池 ==========
    return {
      poolType: POOL_TYPE.AI_SELF,
      convStatus: CONV_STATUS.AI_SERVING,
      reason: '新客户简单问题，进入AI自助池'
    }
  } catch (err) {
    console.error('[Router] 路由判断失败，安全降级到待人工池:', err.message)
    return {
      poolType: POOL_TYPE.PENDING_HUMAN,
      convStatus: CONV_STATUS.PENDING_CLAIM,
      reason: '路由判断异常，安全降级到待人工池'
    }
  }
}

/**
 * 检查用户是否有历史会话记录（不含当前正在创建的会话）
 *
 * 查找条件：同一渠道 + 同一账号 + 同一用户ID + 已归档的会话
 * 如果有归档的历史会话，说明是老客户
 *
 * @param {string} channel
 * @param {number|null} accountId
 * @param {string} channelUserId
 * @returns {Promise<boolean>}
 */
async function checkUserHistory(channel, accountId, channelUserId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM conversations
       WHERE channel = :channel
         AND account_id <=> :accountId
         AND user_id = :channelUserId`,
      { replacements: { channel, accountId, channelUserId } }
    )
    return (rows[0]?.cnt || 0) > 0
  } catch (err) {
    console.error('[Router] 检查用户历史失败:', err.message)
    // 查询失败时保守处理，当作无历史（避免老客户被误判）
    return false
  }
}

/**
 * 使用 LLM 判断消息复杂度
 *
 * 简单问题示例：价格查询、营业时间、地址、常见 FAQ
 * 复杂问题示例：投诉、退款、技术故障、个性化问题、紧急情况
 *
 * @param {string} messageText
 * @param {Object} config - 池配置
 * @returns {Promise<{ needHuman: boolean, reason: string }>}
 */
async function checkComplexity(messageText, config) {
  try {
    // 确保 createChatModel 已加载
    getLangchainService()
    const model = config.complexity_check_model || DASHSCOPE_MODEL

    // 构建分类专用 system prompt
    const systemPrompt = `你是一个客服消息分类助手。请判断以下客户消息是属于"简单/标准化问题"还是"复杂/紧急/需人工问题"。

简单/标准化问题的特征：
- 价格查询、产品信息、营业时间、地址等
- 常见 FAQ 类问题
- 简单的问候、咨询
- 可以用标准话术回答的问题

复杂/紧急/需人工问题的特征：
- 投诉、不满、纠纷
- 退款、赔偿、售后问题
- 技术故障、报错、异常
- 涉及个人账号、订单的具体操作
- 紧急情况、情绪激动
- 需要人工判断和灵活处理的问题
- 问题描述模糊但语气急切

请只回复 JSON 格式：{"need_human": true/false, "reason": "简短原因"}
不要回复其他任何内容。`

    const userMessage = `客户消息：${messageText}`

    // 使用独立的 ChatOpenAI 调用（非流式），确保分类 prompt 被正确传递
    const chatModel = createChatModelFn({
      model,
      temperature: 0.1,
      maxTokens: 200,
      streaming: false
    })

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage)
    ]

    const response = await chatModel.invoke(messages)
    const fullResponse = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    console.log('[Router] LLM复杂度判断响应:', fullResponse?.substring(0, 200))

    // 解析 JSON 结果
    const result = parseComplexityResult(fullResponse)
    return result
  } catch (err) {
    console.error('[Router] 复杂度判断失败，安全降级到待人工:', err.message)
    // 判断失败时安全降级 → 转人工（不自动让 AI 处理不确定的问题）
    return { needHuman: true, reason: '复杂度判断异常，安全降级转人工' }
  }
}

/**
 * 解析 LLM 复杂度判断结果
 */
function parseComplexityResult(response) {
  try {
    // 尝试提取 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        needHuman: !!parsed.need_human,
        reason: parsed.reason || 'LLM判断'
      }
    }
    // 无法解析 → 安全降级转人工
    console.warn('[Router] LLM返回无法解析，安全降级转人工。原始响应:', response?.substring(0, 100))
    return { needHuman: true, reason: 'LLM结果解析失败，安全降级转人工' }
  } catch {
    return { needHuman: true, reason: 'LLM结果解析异常，安全降级转人工' }
  }
}

/**
 * 检查消息是否包含非文本内容
 *
 * 如果消息有可读文本内容(text非空)，即使同时附带 emoji/贴纸，
 * 也不应判定为"非文本"——AI 可以处理带 emoji 的纯文本对话。
 */
function hasNonTextContent(message) {
  try {
    const content = message.content || {}
    if (typeof content === 'string') return false

    // 如果有可读文本，不判定为非文本
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

module.exports = {
  routeNewConversation,
  checkUserHistory,
  checkComplexity
}
