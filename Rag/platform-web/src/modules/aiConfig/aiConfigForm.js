export const AI_CONFIG_FIELDS = Object.freeze([
  { key: 'message_review_enabled', group: 'review', label: '启用入站消息审核', type: 'boolean' },
  { key: 'message_review_model', group: 'review', label: '审核模型', type: 'model' },
  { key: 'message_review_allow_threshold', group: 'review', label: '自动放行置信度', type: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'message_review_context_count', group: 'review', label: '审核上下文条数', type: 'number', min: 0, max: 20, step: 1 },
  { key: 'message_review_timeout_ms', group: 'review', label: '审核超时（毫秒）', type: 'number', min: 1000, max: 60000, step: 1000 },
  { key: 'message_review_merge_window_seconds', group: 'review', label: '连续消息合并窗口（秒）', type: 'number', min: 0, max: 300, step: 1 },
  { key: 'message_review_assignment_timeout_seconds', group: 'review', label: '负责人分配超时（秒）', type: 'number', min: 30, max: 3600, step: 30 },
  { key: 'ai_self_pool_enabled', group: 'reply', label: '启用 AI 自助回复', type: 'boolean' },
  { key: 'ai_self_reply_model', group: 'reply', label: 'AI 自助回复模型', type: 'model' },
  { key: 'ai_suggest_model', group: 'reply', label: '坐席建议模型', type: 'model' },
  { key: 'ai_reply_validation_enabled', group: 'reply', label: '启用回复有效性校验', type: 'boolean' },
  { key: 'ai_reply_validation_model', group: 'reply', label: '回复校验模型', type: 'model' },
  { key: 'llm_translate_model', group: 'reply', label: '翻译模型', type: 'model' },
  { key: 'ai_timeout_ms', group: 'runtime', label: 'AI 调用超时（毫秒）', type: 'number', min: 1000, max: 60000, step: 1000 },
  { key: 'ai_queue_concurrency', group: 'runtime', label: '自动回复并发数', type: 'number', min: 1, max: 20, step: 1 },
  { key: 'ai_suggest_concurrency', group: 'runtime', label: '建议生成并发数', type: 'number', min: 1, max: 20, step: 1 },
  { key: 'llm_context_message_count', group: 'runtime', label: '回复上下文条数', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'rag_context_message_count', group: 'runtime', label: 'RAG 上下文条数', type: 'number', min: 0, max: 20, step: 1 },
  { key: 'translation_context_message_count', group: 'runtime', label: '翻译上下文条数', type: 'number', min: 0, max: 10, step: 1 }
])

export function normalizeAiConfig(config = {}) {
  return Object.fromEntries(
    Object.entries(config).map(([key, entry]) => [
      key,
      entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')
        ? entry.value
        : entry
    ])
  )
}

export function normalizeFieldValue(field, value) {
  if (field.type === 'number') return value === '' || value == null ? null : Number(value)
  if (field.type === 'boolean') return value === true || value === 'true'
  return typeof value === 'string' ? value.trim() : value
}

export function validateAiConfig(values = {}) {
  const errors = {}
  for (const field of AI_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue
    const value = normalizeFieldValue(field, values[field.key])
    if (field.type === 'boolean' && typeof values[field.key] !== 'boolean') {
      errors[field.key] = `${field.label}必须是开关值`
    } else if ((field.type === 'string' || field.type === 'model') && (typeof value !== 'string' || !value)) {
      errors[field.key] = `${field.label}不能为空`
    } else if (field.type === 'number' && (!Number.isFinite(value) || value < field.min || value > field.max)) {
      errors[field.key] = `${field.label}必须在 ${field.min} 到 ${field.max} 之间`
    }
  }
  return errors
}
