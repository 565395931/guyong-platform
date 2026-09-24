const OpenAI = require('openai')
const { sequelize } = require('../../config/database')
const configService = require('../../services/configService')
const systemLogger = require('../../utils/systemLogger')
const messagingService = require('../messaging/messaging.service')
const { getAdapterByChannel } = require('../channel-adapters')
const { createReviewClassifier } = require('./reviewClassifier')
const { createReviewRepository } = require('./reviewRepository')
const { createReviewRouter } = require('./reviewRoutes')
const { createReviewService } = require('./reviewService')

let openAiClient = null
let openAiClientKey = null
let eventEmitterRef = null

function getOpenAiClient() {
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!openAiClient || openAiClientKey !== apiKey) {
    if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured')
    openAiClient = new OpenAI({
      apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    })
    openAiClientKey = apiKey
  }
  return openAiClient
}

async function invokeReviewModel(request) {
  const messages = [
    { role: 'system', content: request.systemPrompt },
    ...request.context.map((item) => ({
      role: item.role === 'user' || item.role === 'customer' ? 'user' : 'assistant',
      content: item.content
    })),
    { role: 'user', content: request.message.content }
  ]
  const response = await getOpenAiClient().chat.completions.create({
    model: request.model,
    messages,
    temperature: request.temperature,
    response_format: { type: 'json_object' }
  })
  return response.choices?.[0]?.message?.content
}

function parseMessageContent(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value || '{}') } catch { return { text: String(value || '') } }
}

async function getReviewContext(conversationId, limit, excludeMessageId = null) {
  const safeLimit = Math.min(20, Math.max(0, Number(limit) || 0))
  if (safeLimit === 0) return []
  const [rows] = await sequelize.query(
    `SELECT id,direction,sender_type,content,created_at,channel
     FROM plat_messages WHERE conversation_id=:conversationId
       AND (:excludeMessageId IS NULL OR id<>:excludeMessageId)
     ORDER BY created_at DESC LIMIT :limit`,
    { replacements: { conversationId, excludeMessageId, limit: safeLimit } }
  )
  return rows.reverse().map((row) => ({
    id: row.id,
    role: row.direction === 'inbound' ? 'customer' : (row.sender_type || 'agent'),
    content: parseMessageContent(row.content).text || parseMessageContent(row.content).content || '',
    createdAt: row.created_at,
    channel: row.channel
  }))
}

async function getConversation(conversationId) {
  const [rows] = await sequelize.query(
    `SELECT id,channel,account_id,user_id,agent_id,claimed_by
     FROM conversations WHERE id=:conversationId LIMIT 1`,
    { replacements: { conversationId } }
  )
  return rows[0] || null
}

async function isSeatOnline(operatorId) {
  const [rows] = await sequelize.query(
    `SELECT user_id FROM seat_status
     WHERE user_id=:operatorId AND status='online' LIMIT 1`,
    { replacements: { operatorId } }
  )
  return Boolean(rows[0])
}

async function sendHumanReviewReply({ conversationId, operatorId, text }) {
  const conversation = await getConversation(conversationId)
  if (!conversation) return { success: false, message: 'Conversation not found' }
  const adapter = getAdapterByChannel(conversation.channel)
  if (!adapter) return { success: false, message: `No outbound adapter for ${conversation.channel}` }
  if (!conversation.account_id || !conversation.user_id) {
    return { success: false, message: 'Conversation has no outbound account or recipient' }
  }

  const stored = await messagingService.sendOutboundMessage({
    conversationId,
    content: { text },
    messageType: 'text',
    agentId: operatorId,
    accountId: conversation.account_id,
    sendStatus: 'received'
  }, eventEmitterRef)

  let sendResult
  try {
    sendResult = await adapter.sendMessage(
      conversation.account_id,
      conversation.user_id,
      { content: { text }, messageType: 'text' }
    )
  } catch (error) {
    sendResult = { success: false, error: error.message }
  }
  const sendStatus = sendResult?.success ? 'sent' : 'failed'
  await sequelize.query(
    `UPDATE plat_messages SET send_status=:sendStatus,
       channel_message_id=:channelMessageId,updated_at=NOW() WHERE id=:messageId`,
    {
      replacements: {
        sendStatus,
        channelMessageId: sendResult?.channelMsgId ? String(sendResult.channelMsgId) : null,
        messageId: stored.messageId
      }
    }
  )
  if (!sendResult?.success) {
    return { success: false, message: sendResult?.error || 'Channel send failed' }
  }
  return { success: true, messageId: stored.messageId }
}

const repository = createReviewRepository(sequelize)
const classifier = createReviewClassifier({
  invokeModel: invokeReviewModel,
  getConfig: configService.getConfig,
  getContext: getReviewContext,
  logger: systemLogger
})
const reviewService = createReviewService({
  repository,
  classifier,
  getConfig: configService.getConfig,
  getConversation,
  isSeatOnline,
  getContext: getReviewContext,
  sendReply: sendHumanReviewReply,
  logger: systemLogger
})
const reviewRoutes = createReviewRouter({ service: reviewService, logger: systemLogger })

function setEventEmitter(eventEmitter) {
  eventEmitterRef = eventEmitter
}

module.exports = reviewRoutes
module.exports.reviewRoutes = reviewRoutes
module.exports.reviewService = reviewService
module.exports.setEventEmitter = setEventEmitter
