const crypto = require('crypto')
const PROTOCOL_VERSION = '0.1'
const TYPES = new Set([
  'connection.hello', 'connection.ready', 'connection.ping', 'connection.pong', 'connection.close',
  'channel.message.inbound', 'gateway.event.ack', 'channel.message.send', 'channel.message.accepted',
  'channel.message.status', 'gateway.error', 'gateway.replay.request', 'gateway.replay.completed', 'gateway.dead_letter',
  'gateway.config.apply', 'gateway.config.applied'
])

function createEnvelope(type, payload = {}, ids = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown protocol type: ${type}`)
  const now = new Date().toISOString()
  const envelope = { protocolVersion: PROTOCOL_VERSION, type, occurredAt: ids.occurredAt || now, sentAt: ids.sentAt || now, payload }
  if (ids.eventId) envelope.eventId = ids.eventId
  if (ids.commandId) envelope.commandId = ids.commandId
  if (ids.ackForEventId) envelope.ackForEventId = ids.ackForEventId
  return envelope
}

function validateEnvelope(value) {
  const errors = []
  if (!value || typeof value !== 'object') return { valid: false, errors: ['envelope must be an object'] }
  if (value.protocolVersion !== PROTOCOL_VERSION) errors.push('unsupported protocolVersion')
  if (!TYPES.has(value.type)) errors.push('unknown type')
  if (!value.payload || typeof value.payload !== 'object') errors.push('payload must be an object')
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

function createHello({ authToken, clientId = 'rag-server', lastCursor = 0 }) {
  return createEnvelope('connection.hello', { clientId, authToken, lastCursor }, { eventId: crypto.randomUUID() })
}

function createAck(eventId, status, result = null) {
  return {
    ...createEnvelope('gateway.event.ack', { result }, { eventId: crypto.randomUUID(), ackForEventId: eventId }),
    ackForEventId: eventId,
    status,
    processedAt: new Date().toISOString()
  }
}

function createSendCommand(payload) {
  return createEnvelope('channel.message.send', payload, { commandId: payload.commandId || crypto.randomUUID() })
}

function createRuntimeConfigApply(payload) {
  return createEnvelope('gateway.config.apply', payload, {
    eventId: payload.requestId || crypto.randomUUID()
  })
}

function createRuntimeConfigApplied(payload) {
  return createEnvelope('gateway.config.applied', payload, {
    eventId: `config-applied-${payload.requestId || crypto.randomUUID()}`
  })
}

module.exports = {
  PROTOCOL_VERSION,
  createHello,
  createAck,
  createSendCommand,
  createRuntimeConfigApply,
  createRuntimeConfigApplied,
  validateEnvelope
}
