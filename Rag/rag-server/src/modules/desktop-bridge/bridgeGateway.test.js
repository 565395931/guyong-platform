const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const WebSocket = require('ws')
const { createEvent, MAX_FRAME_BYTES } = require('./bridgeProtocol')
const { createBridgeGateway } = require('./bridgeGateway')

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', data => resolve(JSON.parse(data.toString())))
    socket.once('error', reject)
  })
}

async function connect(url) {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  return socket
}

async function createHarness(overrides = {}) {
  const httpServer = http.createServer((request, response) => {
    response.writeHead(404)
    response.end()
  })
  const nodeKey = crypto.randomUUID()
  const calls = { consumed: [], authenticated: [], heartbeat: [] }
  const repository = {
    authenticateNode: async input => {
      calls.authenticated.push(input)
      if (input.enrollmentToken.startsWith('disabled-token')) return null
      return { id: 11, node_key: nodeKey, display_name: '客服电脑 A', status: 'offline' }
    },
    touchNode: async () => {}
  }
  const pairingService = {
    consume: async input => {
      calls.consumed.push(input)
      if (input.code === 'ZZZZZZZZ') {
        const error = new Error('expired')
        error.code = 'PAIRING_INVALID_OR_EXPIRED'
        throw error
      }
      return { nodeId: 11, nodeKey, enrollmentToken: 'enrollment-token-with-32-characters' }
    }
  }
  const leaseService = {
    renew: async input => { calls.heartbeat.push(input); return { generation: input.generation, expiresAt: new Date() } }
  }
  const gateway = createBridgeGateway({
    httpServer,
    repository,
    pairingService,
    leaseService,
    allowInsecureLan: true,
    ...overrides
  })
  gateway.start()
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  return {
    calls,
    gateway,
    httpServer,
    nodeKey,
    url: `ws://127.0.0.1:${address.port}/bridge/v1`,
    async close() {
      await gateway.stop()
      await new Promise(resolve => httpServer.close(resolve))
    }
  }
}

function hello(payload, nodeId) {
  return createEvent({ type: 'node.hello', nodeId, payload })
}

test('pairs a new node and returns enrollment configuration in node.ready', async () => {
  const harness = await createHarness()
  const socket = await connect(harness.url)
  try {
    socket.send(JSON.stringify(hello({
      pairingCode: 'ABCDEFGH',
      machineFingerprint: 'machine-a',
      displayName: '客服电脑 A',
      version: '1.0.0'
    })))
    const ready = await nextMessage(socket)
    assert.equal(ready.type, 'node.ready')
    assert.equal(ready.nodeId, harness.nodeKey)
    assert.equal(ready.payload.configuration.enrollmentToken, 'enrollment-token-with-32-characters')
    assert.equal(harness.gateway.getConnection(harness.nodeKey).databaseNodeId, 11)
  } finally {
    socket.close()
    await harness.close()
  }
})

test('authenticates an enrolled node reconnect without a pairing code', async () => {
  const harness = await createHarness()
  const socket = await connect(harness.url)
  try {
    socket.send(JSON.stringify(hello({
      enrollmentToken: 'enrollment-token-with-32-characters',
      machineFingerprint: 'machine-a',
      version: '1.0.1'
    }, harness.nodeKey)))
    assert.equal((await nextMessage(socket)).type, 'node.ready')
    assert.equal(harness.calls.authenticated.length, 1)
  } finally {
    socket.close()
    await harness.close()
  }
})

test('rejects expired pairing and disabled enrollment', async () => {
  const harness = await createHarness()
  try {
    const expired = await connect(harness.url)
    const expiredClosed = once(expired, 'close')
    expired.send(JSON.stringify(hello({
      pairingCode: 'ZZZZZZZZ', machineFingerprint: 'machine-a', version: '1.0.0'
    })))
    const [expiredCode] = await expiredClosed
    assert.equal(expiredCode, 1008)

    const disabled = await connect(harness.url)
    const disabledClosed = once(disabled, 'close')
    disabled.send(JSON.stringify(hello({
      enrollmentToken: 'disabled-token-0000000000', machineFingerprint: 'machine-a', version: '1.0.0'
    }, harness.nodeKey)))
    const [disabledCode] = await disabledClosed
    assert.equal(disabledCode, 1008)
  } finally {
    await harness.close()
  }
})

test('rejects invalid JSON and closes oversized frames with 1009', async () => {
  const harness = await createHarness()
  try {
    const invalid = await connect(harness.url)
    invalid.send('{not json')
    const [invalidCode] = await once(invalid, 'close')
    assert.equal(invalidCode, 1008)

    const oversized = await connect(harness.url)
    oversized.send('x'.repeat(MAX_FRAME_BYTES + 1))
    const [oversizedCode] = await once(oversized, 'close')
    assert.equal(oversizedCode, 1009)
  } finally {
    await harness.close()
  }
})

test('renews account leases on heartbeat and acknowledges durable handling', async () => {
  const harness = await createHarness()
  const socket = await connect(harness.url)
  try {
    socket.send(JSON.stringify(hello({
      enrollmentToken: 'enrollment-token-with-32-characters', machineFingerprint: 'machine-a', version: '1.0.0'
    }, harness.nodeKey)))
    await nextMessage(socket)

    const heartbeat = createEvent({
      type: 'node.heartbeat',
      nodeId: harness.nodeKey,
      payload: { leases: [{ accountId: 7, leaseToken: 'lease-token', generation: 3 }] }
    })
    socket.send(JSON.stringify(heartbeat))
    const ack = await nextMessage(socket)
    assert.equal(ack.type, 'event.ack')
    assert.equal(ack.payload.ackForEventId, heartbeat.eventId)
    assert.equal(ack.payload.status, 'processed')
    assert.equal(harness.calls.heartbeat.length, 1)
  } finally {
    socket.close()
    await harness.close()
  }
})

test('a duplicate live node connection replaces the older socket', async () => {
  const harness = await createHarness()
  const first = await connect(harness.url)
  try {
    first.send(JSON.stringify(hello({
      enrollmentToken: 'enrollment-token-with-32-characters', machineFingerprint: 'machine-a', version: '1.0.0'
    }, harness.nodeKey)))
    await nextMessage(first)

    const firstClosed = once(first, 'close')
    const second = await connect(harness.url)
    second.send(JSON.stringify(hello({
      enrollmentToken: 'enrollment-token-with-32-characters', machineFingerprint: 'machine-a', version: '1.0.1'
    }, harness.nodeKey)))
    await nextMessage(second)
    const [code] = await firstClosed
    assert.equal(code, 4001)
    assert.equal(harness.gateway.getConnection(harness.nodeKey).databaseNodeId, 11)
    second.close()
  } finally {
    first.close()
    await harness.close()
  }
})

test('production bridge refuses plaintext transport without an explicit LAN override', () => {
  const httpServer = http.createServer()
  const gateway = createBridgeGateway({
    httpServer,
    repository: {},
    pairingService: {},
    leaseService: {},
    environment: 'production',
    allowInsecureLan: false,
    tlsEnabled: false
  })
  assert.throws(() => gateway.start(), error => error.code === 'BRIDGE_TLS_REQUIRED')
})
