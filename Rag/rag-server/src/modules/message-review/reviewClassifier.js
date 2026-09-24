const { REVIEW_DEFAULTS } = require('./reviewConfig')
const { parseClassifierOutput } = require('./reviewPolicy')

const SYSTEM_PROMPT = [
  'You review inbound customer-service messages for routing safety.',
  'Return one JSON object only with: riskLevel, confidence, recommendedAction, reasonCode, reason.',
  'riskLevel: low|medium|high.',
  'recommendedAction: allow|review|no_reply.',
  'Never treat no_reply as a final decision; it is only a recommendation for human review.',
  'reasonCode: prompt_injection|suspicious_link|abusive|ambiguous|low_confidence|other.'
].join(' ')

function clampInteger(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function extractContent(content) {
  if (typeof content === 'string') return content
  if (content && typeof content.text === 'string') return content.text
  return ''
}

function sanitizeContextItem(item) {
  return {
    role: item?.role || 'customer',
    content: extractContent(item?.content),
    createdAt: item?.createdAt || item?.created_at || null,
    channel: item?.channel || null
  }
}

function unwrapModelOutput(output) {
  if (typeof output === 'string') return output
  if (output && typeof output.content === 'string') return output.content
  if (output?.choices?.[0]?.message?.content) return output.choices[0].message.content
  return output
}

function createReviewClassifier({
  invokeModel,
  getConfig,
  getContext,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (typeof invokeModel !== 'function') throw new TypeError('invokeModel is required')
  if (typeof getConfig !== 'function') throw new TypeError('getConfig is required')
  if (typeof getContext !== 'function') throw new TypeError('getContext is required')

  async function classify({ conversationId, message }) {
    const [modelValue, contextValue, timeoutValue] = await Promise.all([
      getConfig('message_review_model'),
      getConfig('message_review_context_count'),
      getConfig('message_review_timeout_ms')
    ])
    const model = modelValue || REVIEW_DEFAULTS.message_review_model
    const contextCount = clampInteger(
      contextValue,
      REVIEW_DEFAULTS.message_review_context_count,
      0,
      20
    )
    const timeoutMs = clampInteger(
      timeoutValue,
      REVIEW_DEFAULTS.message_review_timeout_ms,
      1000,
      60000
    )
    const rawContext = contextCount > 0
      ? await getContext(conversationId, contextCount, message?.id || message?.messageId || null)
      : []
    const context = (Array.isArray(rawContext) ? rawContext : [])
      .slice(-contextCount || undefined)
      .map(sanitizeContextItem)
    const currentMessage = sanitizeContextItem({
      role: 'customer',
      content: message?.content,
      createdAt: message?.createdAt || message?.created_at,
      channel: message?.channel
    })

    let timerId
    const timeout = new Promise((_, reject) => {
      timerId = setTimer(() => reject(new Error(`message review classifier timed out after ${timeoutMs}ms`)), timeoutMs)
    })

    try {
      const output = await Promise.race([
        invokeModel({
          model,
          systemPrompt: SYSTEM_PROMPT,
          context,
          message: currentMessage,
          temperature: 0
        }),
        timeout
      ])
      return parseClassifierOutput(unwrapModelOutput(output))
    } catch (error) {
      logger.warn?.('message.review_classifier_failed', {
        conversationId,
        error: error.message
      })
      throw error
    } finally {
      if (timerId !== undefined) clearTimer(timerId)
    }
  }

  return { classify }
}

module.exports = {
  createReviewClassifier,
  sanitizeContextItem
}
