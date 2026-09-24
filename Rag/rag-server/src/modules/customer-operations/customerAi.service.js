const { z } = require('zod')

const CUSTOMER_AI_SYSTEM_PROMPT = [
  '你是客户运营复联分析助手，只输出合法 JSON，不要输出 Markdown。',
  '结合账号信息、历史沟通、订单和已有画像，运用非临床行为心理学分析客户的决策阻力、价格敏感、信任需求、时机偏好和复联意愿。',
  '每个行为信号必须引用输入中的可观察证据，不得凭空添加事实。',
  '不要推断敏感身份、心理疾病、人格障碍或其他与销售沟通无关的敏感属性，也不要给客户贴临床标签。',
  '输出字段必须为 summary、signals、nextFollowupAt、followupType、confidence、recommendedTone；nextFollowupAt 使用带时区的 ISO 8601 时间。'
].join('')

const decisionSchema = z.object({
  summary: z.string().max(2000).default(''),
  signals: z.array(z.object({
    code: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    evidence: z.string().max(500).default('')
  })).max(12).default([]),
  nextFollowupAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
  followupType: z.enum(['won_first', 'won_second', 'manual']).nullable().optional().default(null),
  confidence: z.number().min(0).max(1).default(0),
  recommendedTone: z.string().max(300).default('')
})

function addDays(value, days) {
  const date = new Date(value)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date.toISOString()
}

function fallbackDecision(input, now, errorMessage = null, existingTask = null) {
  const followupType = ['won_first', 'won_second', 'manual'].includes(input?.followupType)
    ? input.followupType
    : 'won_first'
  const defaultDays = followupType === 'won_second' ? 15 : 10
  const humanLocked = Boolean(existingTask?.overriddenBy || existingTask?.overridden_by)
  return {
    source: 'fallback',
    summary: 'AI 暂不可用，已使用默认复联规则',
    signals: [],
    nextFollowupAt: humanLocked ? (existingTask.dueAt || existingTask.due_at) : addDays(now(), defaultDays),
    followupType,
    confidence: 0,
    recommendedTone: '',
    humanLocked,
    errorMessage
  }
}

async function createDefaultCustomerAiProvider(input) {
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) throw new Error('AI provider API key is not configured')

  const { ChatOpenAI } = require('@langchain/openai')
  const { HumanMessage, SystemMessage } = require('@langchain/core/messages')
  const configService = require('../../services/configService')
  const model = await configService.getConfig('customer_profile_model') ||
    await configService.getConfig('ai_suggest_model') || 'deepseek-v4-flash'
  const chatModel = new ChatOpenAI({
    model,
    temperature: 0.2,
    maxTokens: 800,
    apiKey,
    configuration: { baseURL: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
  })
  const response = await chatModel.invoke([
    new SystemMessage(CUSTOMER_AI_SYSTEM_PROMPT),
    new HumanMessage(JSON.stringify(input))
  ])
  return typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content)
}

function createCustomerAiService({ provider = null, now = () => new Date() } = {}) {
  async function decide(input = {}, existingTask = null) {
    if (existingTask?.overriddenBy || existingTask?.overridden_by) {
      try {
        const raw = provider ? await provider(input) : null
        const parsed = decisionSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
        return {
          source: 'ai',
          ...parsed,
          nextFollowupAt: existingTask.dueAt || existingTask.due_at,
          humanLocked: true
        }
      } catch (error) {
        return fallbackDecision(input, now, error.message, existingTask)
      }
    }

    try {
      if (typeof provider !== 'function') throw new Error('customer AI provider is not configured')
      const raw = await provider(input)
      const parsed = decisionSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
      return { source: 'ai', ...parsed, humanLocked: false, errorMessage: null }
    } catch (error) {
      return fallbackDecision(input, now, error.message, existingTask)
    }
  }

  return { decide, decisionSchema }
}

module.exports = {
  createCustomerAiService,
  createDefaultCustomerAiProvider,
  decisionSchema,
  fallbackDecision,
  CUSTOMER_AI_SYSTEM_PROMPT
}
