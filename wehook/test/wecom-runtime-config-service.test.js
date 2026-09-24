const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')

const { createGateway } = require('../src')
const RuntimeConfigStore = require('../src/wecom/runtimeConfigStore')
const { createRuntimeConfigCipher } = require('../src/wecom/runtimeConfigCipher')
const { createRuntimeConfigService } = require('../src/wecom/runtimeConfigService')
const { createEnvelope, createRuntimeConfigApply } = require('../src/protocol')

const KEY = Buffer.alloc(32, 13).toString('base64')

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-runtime-config-'))
  const storePath = path.join(directory, 'runtime-configs.json')
  const store = new RuntimeConfigStore(storePath)
  const cipher = createRuntimeConfigCipher({ key: KEY })
  const service = createRuntimeConfigService({ store, cipher })
  const snapshot = {
    connectionId: 8,
    configVersion: 3,
    callbackKey: 'callback-key-8',
    corpId: 'ww-test',
    secret: 'secret-value',
    callbackToken: 'callback-token',
    encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    accounts: [{ accountId: 12, openKfId: 'wk-test', status: 'active' }]
  }
  return { storePath, store, cipher, service, snapshot }
}

test('persists ciphertext only and resolves an active snapshot by callback key', async () => {
  const fixture = createFixture()
  const ciphertext = fixture.cipher.encrypt(fixture.snapshot)

  const result = await fixture.service.apply({
    connectionId: 8,
    configVersion: 3,
    status: 'active',
    ciphertext
  })

  assert.deepEqual(result, {
    connectionId: 8,
    configVersion: 3,
    status: 'applied',
    duplicate: false
  })
  const persisted = fs.readFileSync(fixture.storePath, 'utf8')
  assert.equal(persisted.includes(fixture.snapshot.secret), false)
  assert.equal(persisted.includes(fixture.snapshot.callbackToken), false)
  assert.equal((await fixture.service.getActiveByCallbackKey('callback-key-8')).corpId, 'ww-test')
})

test('rejects stale versions and same-version conflicts while accepting exact replay', async () => {
  const fixture = createFixture()
  const ciphertext = fixture.cipher.encrypt(fixture.snapshot)
  await fixture.service.apply({ connectionId: 8, configVersion: 3, status: 'active', ciphertext })

  const replay = await fixture.service.apply({ connectionId: 8, configVersion: 3, status: 'active', ciphertext })
  assert.equal(replay.duplicate, true)
  const staleCiphertext = fixture.cipher.encrypt({ ...fixture.snapshot, configVersion: 2 })
  await assert.rejects(
    fixture.service.apply({ connectionId: 8, configVersion: 2, status: 'active', ciphertext: staleCiphertext }),
    error => error.code === 'stale_config_version'
  )
  await assert.rejects(
    fixture.service.apply({
      connectionId: 8,
      configVersion: 3,
      status: 'active',
      ciphertext: fixture.cipher.encrypt({ ...fixture.snapshot, secret: 'changed' })
    }),
    error => error.code === 'config_version_conflict'
  )
})

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

test('authenticated gateway applies config and returns a sanitized applied envelope', async () => {
  const fixture = createFixture()
  const gateway = createGateway({
    config: {
      authToken: 'test-token',
      maxRetries: 2,
      ackTimeoutMs: 1000,
      storePath: path.join(path.dirname(fixture.storePath), 'events.json')
    },
    runtimeConfigService: fixture.service,
    accountResolver: () => true
  })
  const socket = new FakeSocket()
  const client = gateway.server.attachSocket(socket)
  await gateway.server.handleMessage(client, createEnvelope('connection.hello', {
    authToken: 'test-token',
    clientId: 'rag-test'
  }))
  await gateway.server.handleMessage(client, createRuntimeConfigApply({
    requestId: 'cfg-8-3',
    connectionId: 8,
    configVersion: 3,
    channel: 'wecom_kf',
    status: 'active',
    ciphertext: fixture.cipher.encrypt(fixture.snapshot)
  }))

  const applied = socket.sent.find(item => item.type === 'gateway.config.applied')
  assert.equal(applied.payload.status, 'applied')
  assert.equal(applied.payload.connectionId, 8)
  assert.equal(JSON.stringify(applied).includes(fixture.snapshot.secret), false)
})
