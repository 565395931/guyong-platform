const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MAX_FRAME_BYTES,
  TYPES,
  createAck,
  createCommand,
  createEvent,
  parseEnvelope
} = require('./bridgeProtocol')

const eventPayloads = {
  'node.hello': { pairingCode: 'ABCDEFGH', machineFingerprint: 'machine-a', version: '1.0.0' },
  'node.ready': { serverTime: '2026-07-31T10:00:00.000Z', configuration: {} },
  'node.heartbeat': { leases: [] },
  'account.snapshot': { accounts: [] },
  'account.state.changed': { accountId: 7, state: 'online' },
  'message.inbound': {
    accountId: 7,
    channel: 'taobao',
    platformConversationId: 'conv-1',
    platformCustomerId: 'customer-1',
    channelMessageId: 'message-1',
    content: 'hello'
  },
  'message.command.status': { commandId: crypto.randomUUID(), status: 'accepted' },
  'event.ack': { ackForEventId: crypto.randomUUID(), status: 'processed' },
  'server.error': { code: 'INVALID_EVENT', message: 'invalid event' }
}

test('accepts every supported protocol envelope type', () => {
  assert.deepEqual(TYPES, [
    'node.hello', 'node.ready', 'node.heartbeat',
    'account.snapshot', 'account.state.changed',
    'message.inbound', 'message.send', 'message.command.status',
    'event.ack', 'server.error'
  ])

  for (const type of TYPES) {
    const envelope = type === 'message.send'
      ? createCommand({
          nodeId: crypto.randomUUID(),
          payload: { accountId: 7, platformConversationId: 'conv-1', content: 'reply' }
        })
      : createEvent({
          type,
          nodeId: type === 'node.hello' ? undefined : crypto.randomUUID(),
          payload: eventPayloads[type]
        })
    assert.equal(parseEnvelope(envelope).type, type)
  }
})

test('rejects unsupported versions, unknown types, missing ids and invalid timestamps', () => {
  const valid = createEvent({
    type: 'node.heartbeat',
    nodeId: crypto.randomUUID(),
    payload: { leases: [] }
  })

  assert.throws(() => parseEnvelope({ ...valid, protocolVersion: '0.1' }))
  assert.throws(() => parseEnvelope({ ...valid, type: 'unknown.event' }))
  const { eventId, ...withoutId } = valid
  assert.throws(() => parseEnvelope(withoutId))
  assert.throws(() => parseEnvelope({ ...valid, sentAt: 'not-a-timestamp' }))
})

test('rejects oversized frames before parsing payload data', () => {
  const frame = JSON.stringify({ padding: 'x'.repeat(MAX_FRAME_BYTES) })
  assert.ok(Buffer.byteLength(frame) > MAX_FRAME_BYTES)
  assert.throws(() => parseEnvelope(frame), error => error.code === 'FRAME_TOO_LARGE')
})

test('requires node identity after pairing hello', () => {
  const hello = createEvent({ type: 'node.hello', payload: eventPayloads['node.hello'] })
  assert.equal(parseEnvelope(hello).nodeId, undefined)

  assert.throws(() => parseEnvelope(createEvent({
    type: 'node.heartbeat',
    payload: { leases: [] }
  })))
})

test('requires an account, platform conversation and text or media for inbound messages', () => {
  const nodeId = crypto.randomUUID()
  const base = createEvent({
    type: 'message.inbound',
    nodeId,
    payload: eventPayloads['message.inbound']
  })
  assert.equal(parseEnvelope(base).payload.content, 'hello')

  for (const payload of [
    { ...base.payload, accountId: undefined },
    { ...base.payload, platformConversationId: undefined },
    { ...base.payload, content: '', media: [] }
  ]) {
    assert.throws(() => parseEnvelope({ ...base, payload }))
  }

  assert.doesNotThrow(() => parseEnvelope({
    ...base,
    payload: { ...base.payload, content: '', media: [{ type: 'image', url: 'https://example.test/a.png' }] }
  }))
})

test('creates commands and acknowledgements with the canonical id fields', () => {
  const nodeId = crypto.randomUUID()
  const command = createCommand({
    nodeId,
    payload: { accountId: 7, platformConversationId: 'conv-1', content: 'reply' }
  })
  assert.equal(command.type, 'message.send')
  assert.match(command.commandId, /^[0-9a-f-]{36}$/)
  assert.equal('eventId' in command, false)

  const ackForEventId = crypto.randomUUID()
  const ack = createAck({ nodeId, ackForEventId, status: 'duplicate' })
  assert.equal(ack.payload.ackForEventId, ackForEventId)
  assert.equal(ack.payload.status, 'duplicate')
})
