const SUPPORTED_OPERATIONS = Object.freeze(['mock.inbound'])
const SUPPORTED_MESSAGE_TYPES = Object.freeze(['text', 'image', 'video', 'audio', 'file'])

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalId(value, fieldName) {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).trim()
  if (!normalized || normalized.length > 191) throw new Error(`${fieldName} 不能为空且不能超过 191 个字符`)
  return normalized
}

function normalizeCloudGatewayTestRequest(body = {}) {
  const operation = String(body.operation || 'mock.inbound').trim()
  if (!SUPPORTED_OPERATIONS.includes(operation)) throw new Error('暂不支持该测试操作')

  const accountId = Number(body.accountId)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('请选择有效的测试账号')

  const target = isObject(body.target) ? body.target : {}
  const channelUserId = String(target.channelUserId || body.channelUserId || '').trim()
  if (!channelUserId || channelUserId.length > 191) throw new Error('客户 ID 不能为空且不能超过 191 个字符')

  const message = isObject(body.message) ? body.message : {}
  const messageType = String(message.type || body.messageType || 'text').trim().toLowerCase()
  if (!SUPPORTED_MESSAGE_TYPES.includes(messageType)) throw new Error('消息类型仅支持 text / image / video / audio / file')

  let content = message.content ?? body.content
  if (content === undefined) content = body.text === undefined ? {} : { text: String(body.text) }
  if (!isObject(content)) throw new Error('消息 content 必须是 JSON 对象')
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 50 * 1024) throw new Error('消息 content 不能超过 50KB')

  if (messageType === 'text') {
    const text = String(content.text || '').trim()
    if (!text || text.length > 10000) throw new Error('文本消息不能为空且不能超过 10000 个字符')
    content = { ...content, text }
  } else if (Object.keys(content).length === 0) {
    throw new Error('非文本消息必须填写 content 参数')
  }

  const overrides = isObject(body.overrides) ? body.overrides : {}
  const eventId = optionalId(overrides.eventId ?? body.eventId, 'eventId')
  const channelMessageId = optionalId(overrides.channelMessageId ?? body.channelMessageId, 'channelMessageId')
  const clientTimestamp = overrides.clientTimestamp === undefined || overrides.clientTimestamp === null || overrides.clientTimestamp === ''
    ? Date.now()
    : Number(overrides.clientTimestamp)
  if (!Number.isSafeInteger(clientTimestamp) || clientTimestamp <= 0) throw new Error('clientTimestamp 必须是正整数毫秒时间戳')

  return {
    operation,
    accountId,
    target: { channelUserId },
    message: { type: messageType, content },
    overrides: { eventId, channelMessageId, clientTimestamp }
  }
}

module.exports = {
  SUPPORTED_OPERATIONS,
  SUPPORTED_MESSAGE_TYPES,
  normalizeCloudGatewayTestRequest
}
