const REVIEW_DEFAULTS = Object.freeze({
  message_review_enabled: true,
  message_review_model: 'deepseek-v4-flash',
  message_review_allow_threshold: 0.85,
  message_review_context_count: 6,
  message_review_timeout_ms: 12000,
  message_review_merge_window_seconds: 30,
  message_review_assignment_timeout_seconds: 300
})

function booleanValue(key, value) {
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function stringValue(key, value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
    throw new Error(`${key} must be a non-empty string no longer than 100 characters`)
  }
  return value.trim()
}

// 可选字符串：允许清空（百炼的 app 标识、自定义接口地址等不是必填，
// 留空表示"回退到 .env 或内置默认值"）
function optionalStringValue(key, value) {
  if (typeof value !== 'string' || value.length > 300) {
    throw new Error(`${key} must be a string no longer than 300 characters`)
  }
  return value.trim()
}

function numberValue(key, value, min, max, integer = false) {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    const kind = integer ? 'integer' : 'number'
    throw new Error(`${key} must be a ${kind} between ${min} and ${max}`)
  }
  return value
}

const REVIEW_SCHEMA = Object.freeze({
  message_review_enabled: (value) => booleanValue('message_review_enabled', value),
  message_review_model: (value) => stringValue('message_review_model', value),
  message_review_allow_threshold: (value) => numberValue('message_review_allow_threshold', value, 0, 1),
  message_review_context_count: (value) => numberValue('message_review_context_count', value, 0, 20, true),
  message_review_timeout_ms: (value) => numberValue('message_review_timeout_ms', value, 1000, 60000, true),
  message_review_merge_window_seconds: (value) => numberValue('message_review_merge_window_seconds', value, 0, 300, true),
  message_review_assignment_timeout_seconds: (value) => numberValue('message_review_assignment_timeout_seconds', value, 30, 3600, true)
})

const PUBLIC_AI_SCHEMA = Object.freeze({
  ai_self_pool_enabled: (value) => booleanValue('ai_self_pool_enabled', value),
  ai_self_reply_model: (value) => stringValue('ai_self_reply_model', value),
  ai_suggest_model: (value) => stringValue('ai_suggest_model', value),
  ai_reply_validation_enabled: (value) => booleanValue('ai_reply_validation_enabled', value),
  ai_reply_validation_model: (value) => stringValue('ai_reply_validation_model', value),
  llm_translate_model: (value) => stringValue('llm_translate_model', value),
  ai_timeout_ms: (value) => numberValue('ai_timeout_ms', value, 1000, 60000, true),
  ai_queue_concurrency: (value) => numberValue('ai_queue_concurrency', value, 1, 20, true),
  ai_suggest_concurrency: (value) => numberValue('ai_suggest_concurrency', value, 1, 20, true),
  llm_context_message_count: (value) => numberValue('llm_context_message_count', value, 0, 100, true),
  rag_context_message_count: (value) => numberValue('rag_context_message_count', value, 0, 20, true),
  translation_context_message_count: (value) => numberValue('translation_context_message_count', value, 0, 10, true),
  // ===== 接口与默认模型（原先只能改 .env，且代码在模块加载时读死，不重启不生效） =====
  ai_chat_base_url: (value) => optionalStringValue('ai_chat_base_url', value),
  ai_chat_model: (value) => optionalStringValue('ai_chat_model', value),
  ai_suggestion_enabled: (value) => booleanValue('ai_suggestion_enabled', value),
  // ===== 百炼（阿里云 DashScope）应用标识：知识库上传/解析要用 =====
  bailian_workspace_id: (value) => optionalStringValue('bailian_workspace_id', value),
  bailian_index_id: (value) => optionalStringValue('bailian_index_id', value),
  bailian_category_id: (value) => optionalStringValue('bailian_category_id', value),
  ...REVIEW_SCHEMA
})

function validateWithSchema(schema, key, value) {
  const validator = schema[key]
  if (!validator) throw new Error(`${key} is not editable`)
  return validator(value)
}

function validateReviewConfig(key, value) {
  return validateWithSchema(REVIEW_SCHEMA, key, value)
}

function validatePublicAiConfig(key, value) {
  return validateWithSchema(PUBLIC_AI_SCHEMA, key, value)
}

function getPublicAiConfigKeys() {
  return Object.keys(PUBLIC_AI_SCHEMA)
}

module.exports = {
  REVIEW_DEFAULTS,
  getPublicAiConfigKeys,
  validatePublicAiConfig,
  validateReviewConfig
}
