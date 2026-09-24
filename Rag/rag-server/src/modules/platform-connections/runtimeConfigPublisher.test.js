const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')

const { createRuntimeConfigCipher } = require('./runtimeConfigCipher')
const { createRuntimeConfigPublisher } = require('./runtimeConfigPublisher')
const GatewayLink = require('../cloud-gateway/gatewayLink')

const KEY = Buffer.alloc(32, 19).toString('base64')

class FakeLink extends EventEmitter {
  constructor() {
    super()
    this.ready = true
    this.sent = []
  }

  send(envelope) {
    this.sent.push(envelope)
  }
}

test('publishes ciphertext only and waits for the matching gateway confirmation', async () => {
  const link = new FakeLink()
  const publisher = createRuntimeConfigPublisher({
    getLink: () => link,
    cipher: createRuntimeConfigCipher({ key: KEY }),
    randomUUID: () => 'request-1',
    timeoutMs: 100
  })
  const snapshot = {
    connectionId: 8,
    configVersion: 3,
    corpId: 'ww-test',
    secret: 'secret-value'
  }

  const resultPromise = publisher.publish(snapshot)
  assert.equal(link.sent.length, 1)
  assert.equal(link.sent[0].type, 'gateway.config.apply')
  assert.equal(JSON.stringify(link.sent[0]).includes(snapshot.secret), false)
  link.emit('config_applied', {
    payload: {
      requestId: 'request-1',
      connectionId: 8,
      configVersion: 3,
      status: 'applied'
    }
  })

  assert.deepEqual(await resultPromise, {
    connectionId: 8,
    configVersion: 3,
    status: 'applied'
  })
})

test('fails closed when the gateway is disconnected or rejects the snapshot', async () => {
  const disconnected = createRuntimeConfigPublisher({
    getLink: () => ({ ready: false }),
    cipher: createRuntimeConfigCipher({ key: KEY })
  })
  await assert.rejects(() => disconnected.publish({ connectionId: 8, configVersion: 3 }), /not connected/)

  const link = new FakeLink()
  const publisher = createRuntimeConfigPublisher({
    getLink: () => link,
    cipher: createRuntimeConfigCipher({ key: KEY }),
    randomUUID: () => 'request-2',
    timeoutMs: 100
  })
  const resultPromise = publisher.publish({ connectionId: 8, configVersion: 4 })
  link.emit('config_applied', {
    payload: {
      requestId: 'request-2', connectionId: 8, configVersion: 4,
      status: 'rejected', errorCode: 'stale_config_version'
    }
  })
  await assert.rejects(resultPromise, error => error.code === 'stale_config_version')
})

test('publishes an encrypted disabled snapshot and waits for confirmation', async () => {
  const link = new FakeLink()
  const publisher = createRuntimeConfigPublisher({
    getLink: () => link,
    cipher: createRuntimeConfigCipher({ key: KEY }),
    randomUUID: () => 'request-disabled',
    timeoutMs: 100
  })
  const snapshot = { connectionId: 8, configVersion: 6, secret: 'still-encrypted' }

  const resultPromise = publisher.publish(snapshot, { status: 'disabled' })
  assert.equal(link.sent[0].payload.status, 'disabled')
  assert.equal(JSON.stringify(link.sent[0]).includes(snapshot.secret), false)
  link.emit('config_applied', {
    payload: {
      requestId: 'request-disabled', connectionId: 8, configVersion: 6, status: 'applied'
    }
  })

  assert.deepEqual(await resultPromise, {
    connectionId: 8, configVersion: 6, status: 'applied'
  })
})

test('GatewayLink emits config_applied for a valid confirmation envelope', () => {
  const link = new GatewayLink()
  let received = null
  link.on('config_applied', envelope => { received = envelope })

  link.handleMessage(JSON.stringify({
    protocolVersion: '0.1',
    type: 'gateway.config.applied',
    eventId: 'applied-1',
    occurredAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    payload: {
      requestId: 'request-3', connectionId: 8, configVersion: 5, status: 'applied'
    }
  }))

  assert.equal(received.payload.requestId, 'request-3')
})
