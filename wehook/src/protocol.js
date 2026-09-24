const PROTOCOL_VERSION = '0.1'

const TYPES = Object.freeze([
  'connection.hello', 'connection.ready', 'connection.ping', 'connection.pong', 'connection.close',
  'channel.message.inbound', 'gateway.event.ack', 'channel.message.send', 'channel.message.accepted',
  'channel.message.status', 'gateway.error', 'gateway.replay.request', 'gateway.replay.completed',
  'gateway.dead_letter', 'gateway.config.apply', 'gateway.config.applied'
])

const ACK_STATUSES = Object.freeze(['processed', 'duplicate', 'rejected', 'retryable_error'])

function now() { return new Date().toISOString() }

function createEnvelope(type, payload = {}, ids = {}) {
  if (!TYPES.includes(type)) throw new Error(`unknown protocol type: ${type}`)
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    type,
    occurredAt: ids.occurredAt || now(),
    sentAt: ids.sentAt || now(),
    payload
  }
  if (ids.eventId) envelope.eventId = ids.eventId
  if (ids.commandId) envelope.commandId = ids.commandId
  if (ids.ackForEventId) envelope.ackForEventId = ids.ackForEventId
  return envelope
}

function validateEnvelope(value, options = {}) {
  const errors = []
  if (!value || typeof value !== 'object') return { valid: false, errors: ['envelope must be an object'] }
  if (value.protocolVersion !== PROTOCOL_VERSION) errors.push('unsupported protocolVersion')
  if (!TYPES.includes(value.type)) errors.push('unknown type')
  if (!value.payload || typeof value.payload !== 'object') errors.push('payload must be an object')
  if (options.requireEventId && !value.eventId) errors.push('eventId is required')
  if (options.requireCommandId && !value.commandId) errors.push('commandId is required')
  if (value.type === 'gateway.event.ack') {
    if (options.requireEventId && !value.eventId) errors.push('eventId is required')
    if (!value.ackForEventId) errors.push('ackForEventId is required')
    if (!ACK_STATUSES.includes(value.status || value.payload?.status)) errors.push('invalid ACK status')
  }
  if (value.type === 'channel.message.send') {
    for (const field of ['conversationId', 'localMessageId', 'channel', 'accountId', 'targetUserId', 'messageType', 'content']) {
      if (value.payload[field] === undefined || value.payload[field] === null || value.payload[field] === '') {
        errors.push(`${field} is required`)
      }
    }
    if (value.payload.content && typeof value.payload.content !== 'object') errors.push('content must be an object')
  }
  if (value.type === 'gateway.config.apply') {
    const payload = value.payload || {}
    if (!payload.requestId) errors.push('requestId is required')
    if (!Number.isInteger(Number(payload.connectionId)) || Number(payload.connectionId) <= 0) errors.push('connectionId is invalid')
    if (!Number.isInteger(Number(payload.configVersion)) || Number(payload.configVersion) <= 0) errors.push('configVersion is invalid')
    if (payload.channel !== 'wecom_kf') errors.push('channel is invalid')
    if (!['active', 'disabled'].includes(payload.status)) errors.push('status is invalid')
    if (!payload.ciphertext) errors.push('ciphertext is required')
  }
  if (value.type === 'gateway.config.applied') {
    const payload = value.payload || {}
    if (!payload.requestId) errors.push('requestId is required')
    if (!Number.isInteger(Number(payload.connectionId)) || Number(payload.connectionId) <= 0) errors.push('connectionId is invalid')
    if (!Number.isInteger(Number(payload.configVersion)) || Number(payload.configVersion) <= 0) errors.push('configVersion is invalid')
    if (!['applied', 'rejected'].includes(payload.status)) errors.push('status is invalid')
  }
  return { valid: errors.length === 0, errors }
}

function createRuntimeConfigApply(payload) {
  return createEnvelope('gateway.config.apply', payload, { eventId: payload.requestId })
}

function createRuntimeConfigApplied(payload) {
  return createEnvelope('gateway.config.applied', payload, {
    eventId: `config-applied-${payload.requestId}`
  })
}

module.exports = {
  PROTOCOL_VERSION,
  TYPES,
  ACK_STATUSES,
  createEnvelope,
  createRuntimeConfigApply,
  createRuntimeConfigApplied,
  validateEnvelope
}
