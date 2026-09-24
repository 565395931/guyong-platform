const { randomUUID } = require('node:crypto')
const { z } = require('zod')

const PROTOCOL_VERSION = '1.0'
const MAX_FRAME_BYTES = 1024 * 1024
const TYPES = Object.freeze([
  'node.hello', 'node.ready', 'node.heartbeat',
  'account.snapshot', 'account.state.changed',
  'message.inbound', 'message.send', 'message.command.status',
  'event.ack', 'server.error'
])

class BridgeProtocolError extends Error {
  constructor(code, message, cause) {
    super(message, { cause })
    this.name = 'BridgeProtocolError'
    this.code = code
  }
}

const timestamp = z.string().datetime({ offset: true })
const nodeId = z.string().uuid()
const accountId = z.number().int().positive()
const nonEmptyId = z.string().trim().min(1).max(255)

const mediaSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file']),
  url: z.string().url().optional(),
  name: z.string().max(255).optional(),
  mimeType: z.string().max(120).optional()
}).passthrough()

const payloadSchemas = {
  'node.hello': z.object({
    pairingCode: z.string().regex(/^[A-Z2-7]{8}$/).optional(),
    enrollmentToken: z.string().min(16).optional(),
    machineFingerprint: z.string().min(3).max(512),
    displayName: z.string().trim().min(1).max(120).optional(),
    version: z.string().trim().min(1).max(50),
    adapterIds: z.array(z.string().min(1)).optional(),
    capabilities: z.record(z.unknown()).optional()
  }).strict().refine(value => value.pairingCode || value.enrollmentToken, {
    message: 'pairingCode or enrollmentToken is required'
  }),
  'node.ready': z.object({
    serverTime: timestamp,
    configuration: z.record(z.unknown())
  }).strict(),
  'node.heartbeat': z.object({
    leases: z.array(z.record(z.unknown())).optional().default([]),
    health: z.record(z.unknown()).optional()
  }).strict(),
  'account.snapshot': z.object({ accounts: z.array(z.record(z.unknown())) }).strict(),
  'account.state.changed': z.object({
    accountId,
    state: z.enum(['online', 'offline', 'degraded', 'error']),
    reason: z.string().max(500).optional()
  }).strict(),
  'message.inbound': z.object({
    accountId,
    channel: z.string().trim().min(1).max(50),
    platformConversationId: nonEmptyId,
    platformCustomerId: nonEmptyId,
    channelMessageId: nonEmptyId,
    userName: z.string().max(255).optional(),
    content: z.string().max(200000).optional(),
    messageType: z.string().max(30).optional().default('text'),
    clientTimestamp: timestamp.optional(),
    media: z.array(mediaSchema).optional().default([]),
    platformPayload: z.unknown().optional()
  }).strict().refine(value => Boolean(value.content?.trim()) || value.media.length > 0, {
    message: 'message.inbound requires text or media'
  }),
  'message.send': z.object({
    accountId,
    platformConversationId: nonEmptyId,
    targetUserId: z.string().max(255).optional(),
    content: z.string().min(1).max(200000),
    messageType: z.string().max(30).optional().default('text'),
    replyToChannelMessageId: z.string().max(255).optional()
  }).strict(),
  'message.command.status': z.object({
    commandId: z.string().uuid(),
    status: z.enum(['accepted', 'succeeded', 'failed']),
    platformMessageId: z.string().max(255).optional(),
    errorCode: z.string().max(80).optional(),
    errorMessage: z.string().max(500).optional()
  }).strict(),
  'event.ack': z.object({
    ackForEventId: z.string().uuid(),
    status: z.enum(['processed', 'duplicate', 'rejected', 'retryable_error']),
    errorCode: z.string().max(80).optional(),
    message: z.string().max(500).optional()
  }).strict(),
  'server.error': z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    retryable: z.boolean().optional()
  }).strict()
}

const baseFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  occurredAt: timestamp,
  sentAt: timestamp
}

function eventEnvelope(type, options = {}) {
  const nodeField = options.nodeOptional ? nodeId.optional() : nodeId
  return z.object({
    ...baseFields,
    type: z.literal(type),
    eventId: z.string().uuid(),
    nodeId: nodeField,
    payload: payloadSchemas[type]
  }).strict()
}

const envelopeSchema = z.discriminatedUnion('type', [
  eventEnvelope('node.hello', { nodeOptional: true }),
  eventEnvelope('node.ready'),
  eventEnvelope('node.heartbeat'),
  eventEnvelope('account.snapshot'),
  eventEnvelope('account.state.changed'),
  eventEnvelope('message.inbound'),
  z.object({
    ...baseFields,
    type: z.literal('message.send'),
    commandId: z.string().uuid(),
    nodeId,
    payload: payloadSchemas['message.send']
  }).strict(),
  eventEnvelope('message.command.status'),
  eventEnvelope('event.ack'),
  eventEnvelope('server.error')
])

function serializedSize(input) {
  if (Buffer.isBuffer(input)) return input.byteLength
  if (typeof input === 'string') return Buffer.byteLength(input, 'utf8')
  try {
    return Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch (error) {
    throw new BridgeProtocolError('INVALID_JSON', 'Envelope is not serializable', error)
  }
}

function parseEnvelope(input) {
  if (serializedSize(input) > MAX_FRAME_BYTES) {
    throw new BridgeProtocolError('FRAME_TOO_LARGE', `Frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }

  let value = input
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try {
      value = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input)
    } catch (error) {
      throw new BridgeProtocolError('INVALID_JSON', 'Envelope is not valid JSON', error)
    }
  }

  const result = envelopeSchema.safeParse(value)
  if (!result.success) {
    throw new BridgeProtocolError('INVALID_ENVELOPE', 'Envelope validation failed', result.error)
  }
  return result.data
}

function createEvent({ type, nodeId: envelopeNodeId, payload, eventId = randomUUID(), occurredAt, sentAt }) {
  if (type === 'message.send') {
    throw new BridgeProtocolError('INVALID_CREATOR', 'Use createCommand for message.send')
  }
  const now = new Date().toISOString()
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    type,
    eventId,
    occurredAt: occurredAt || now,
    sentAt: sentAt || now,
    payload
  }
  if (envelopeNodeId) envelope.nodeId = envelopeNodeId
  return parseEnvelope(envelope)
}

function createCommand({ nodeId: envelopeNodeId, payload, commandId = randomUUID(), occurredAt, sentAt }) {
  const now = new Date().toISOString()
  return parseEnvelope({
    protocolVersion: PROTOCOL_VERSION,
    type: 'message.send',
    commandId,
    nodeId: envelopeNodeId,
    occurredAt: occurredAt || now,
    sentAt: sentAt || now,
    payload
  })
}

function createAck({ nodeId: envelopeNodeId, ackForEventId, status, errorCode, message }) {
  return createEvent({
    type: 'event.ack',
    nodeId: envelopeNodeId,
    payload: { ackForEventId, status, errorCode, message }
  })
}

module.exports = {
  BridgeProtocolError,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  TYPES,
  createAck,
  createCommand,
  createEvent,
  parseEnvelope
}
