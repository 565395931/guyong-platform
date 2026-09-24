const RISK_LEVELS = new Set(['low', 'medium', 'high'])
const RECOMMENDED_ACTIONS = new Set(['allow', 'review', 'no_reply'])
const REASON_CODES = new Set([
  'prompt_injection',
  'suspicious_link',
  'abusive',
  'ambiguous',
  'low_confidence',
  'other'
])

function parseClassifierOutput(input) {
  let value = input

  if (typeof value === 'string') {
    const json = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      value = JSON.parse(json)
    } catch {
      throw new Error('classifier output must be valid JSON')
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('classifier output must be a JSON object')
  }

  if (!RISK_LEVELS.has(value.riskLevel)) {
    throw new Error('riskLevel must be low, medium, or high')
  }
  if (!RECOMMENDED_ACTIONS.has(value.recommendedAction)) {
    throw new Error('recommendedAction must be allow, review, or no_reply')
  }
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('confidence must be a finite number between 0 and 1')
  }
  if (!REASON_CODES.has(value.reasonCode)) {
    throw new Error('reasonCode is not supported')
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.reason.length > 500) {
    throw new Error('reason must be a non-empty string no longer than 500 characters')
  }

  return {
    riskLevel: value.riskLevel,
    confidence: value.confidence,
    recommendedAction: value.recommendedAction,
    reasonCode: value.reasonCode,
    reason: value.reason.trim()
  }
}

function matchHardRules(text) {
  if (typeof text !== 'string' || text.length === 0) return []

  const hits = []
  const promptInjectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions?/i,
    /reveal\s+(the\s+)?system\s+prompt/i,
    /system\s+prompt/i,
    /忽略.{0,12}(之前|以上|前面).{0,8}(指令|提示|要求)/i,
    /(泄露|显示|输出).{0,8}(系统提示词|系统指令)/i
  ]
  const suspiciousLinkPatterns = [
    /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?=[:/\s]|$)/i,
    /https?:\/\/[^\s/]*xn--[^\s/]*/i,
    /https?:\/\/(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd)(?=\/|\s|$)/i
  ]

  if (promptInjectionPatterns.some((pattern) => pattern.test(text))) {
    hits.push('prompt_injection')
  }
  if (suspiciousLinkPatterns.some((pattern) => pattern.test(text))) {
    hits.push('suspicious_link')
  }

  return hits
}

function decideReview({ ruleHits = [], classifier, classifierError, allowThreshold = 0.85 } = {}) {
  if (ruleHits.length > 0) {
    return {
      action: 'review',
      riskLevel: 'high',
      reasonCode: ruleHits[0]
    }
  }

  if (classifierError || !classifier) {
    return {
      action: 'review',
      riskLevel: 'medium',
      reasonCode: 'classifier_failed'
    }
  }

  if (classifier.recommendedAction === 'no_reply' || classifier.recommendedAction === 'review') {
    return {
      action: 'review',
      riskLevel: classifier.riskLevel,
      reasonCode: classifier.reasonCode
    }
  }

  if (classifier.confidence < allowThreshold) {
    return {
      action: 'review',
      riskLevel: classifier.riskLevel,
      reasonCode: 'low_confidence'
    }
  }

  return {
    action: 'allow',
    riskLevel: classifier.riskLevel,
    reasonCode: classifier.reasonCode
  }
}

module.exports = {
  decideReview,
  matchHardRules,
  parseClassifierOutput
}
