const test = require('node:test')
const assert = require('node:assert/strict')

const DouyinCommerceAdapter = require('./douyinAdapter')
const { createEventSignature } = require('./douyinSignature')
const { createDouyinWebhookHandler } = require('./douyinWebhook')

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

test('acknowledges a verified webhook before scheduling idempotent event storage', async () => {
  const appKey = 'douyin-app'
  const appSecret = 'douyin-secret'
  const payload = [{ tag: '100', msg_id: 'event-100', data: JSON.stringify({ p_id: 'order-1', shop_id: 'shop-A' }) }]
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = createEventSignature({ appId: appKey, appSecret, rawBody })
  const scheduled = []
  const stored = []
  const handler = createDouyinWebhookHandler({
    loadAccount: async () => ({ id: 9, channel: 'douyin', status: 'active', config: { appKey, appSecret, shopId: 'shop-A' } }),
    adapter: new DouyinCommerceAdapter(),
    eventInbox: { store: async event => { stored.push(event); return { stored: true, duplicate: false } } },
    schedule: task => scheduled.push(task),
    logger: { info() {}, warn() {}, error() {} }
  })
  const res = responseStub()

  await handler({
    query: { account_id: '9' }, headers: { 'app-id': appKey, 'event-sign': signature },
    rawBody, body: payload
  }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { code: 0, msg: 'success' })
  assert.equal(scheduled.length, 1)
  assert.equal(stored.length, 0)
  await scheduled[0]()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].externalEventId, 'event-100')
})

test('rejects an invalid signature without scheduling event storage', async () => {
  const scheduled = []
  const handler = createDouyinWebhookHandler({
    loadAccount: async () => ({ id: 9, channel: 'douyin', status: 'active', config: { appKey: 'app', appSecret: 'secret' } }),
    adapter: new DouyinCommerceAdapter(),
    eventInbox: { store: async () => assert.fail('must not store an invalid callback') },
    schedule: task => scheduled.push(task),
    logger: { info() {}, warn() {}, error() {} }
  })
  const res = responseStub()

  await handler({
    query: { account_id: '9' }, headers: { 'app-id': 'app', 'event-sign': 'bad-signature' },
    rawBody: Buffer.from('[]'), body: []
  }, res)

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { code: 401, msg: 'invalid signature' })
  assert.equal(scheduled.length, 0)
})

test('rejects a validly signed event scoped to another shop without leaking credentials', async t => {
  for (const field of ['shop_id', 'shopId']) {
    await t.test(field, async () => {
      const appKey = 'sensitive-app-key'
      const appSecret = 'sensitive-app-secret'
      const payload = [{
        tag: '100',
        msg_id: `event-mismatch-${field}`,
        data: JSON.stringify({ p_id: 'order-other-shop', [field]: 'shop-B' })
      }]
      const rawBody = Buffer.from(JSON.stringify(payload))
      const signature = createEventSignature({ appId: appKey, appSecret, rawBody })
      const scheduled = []
      const logs = []
      const handler = createDouyinWebhookHandler({
        loadAccount: async () => ({
          id: 9,
          channel: 'douyin',
          status: 'active',
          config: { appKey, appSecret, shopId: 'shop-A' }
        }),
        adapter: new DouyinCommerceAdapter(),
        eventInbox: { store: async () => assert.fail('must not store another shop event') },
        schedule: task => scheduled.push(task),
        logger: {
          info(...args) { logs.push(args) },
          warn(...args) { logs.push(args) },
          error(...args) { logs.push(args) }
        }
      })
      const res = responseStub()

      await handler({
        query: { account_id: '9' },
        headers: { 'app-id': appKey, 'event-sign': signature },
        rawBody,
        body: payload
      }, res)

      assert.equal(res.statusCode, 409)
      assert.deepEqual(res.body, {
        code: 'douyin_shop_id_mismatch',
        msg: 'event does not match account'
      })
      assert.equal(scheduled.length, 0)
      const serializedLogs = JSON.stringify(logs)
      assert.equal(serializedLogs.includes(appKey), false)
      assert.equal(serializedLogs.includes(appSecret), false)
    })
  }
})

test('accepts a non-probe event that does not explicitly carry a shop id', async () => {
  const appKey = 'douyin-app'
  const appSecret = 'douyin-secret'
  const payload = [{ tag: '101', msg_id: 'event-no-shop', data: JSON.stringify({ product_id: 'product-1' }) }]
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = createEventSignature({ appId: appKey, appSecret, rawBody })
  const scheduled = []
  const stored = []
  const handler = createDouyinWebhookHandler({
    loadAccount: async () => ({
      id: 9,
      channel: 'douyin',
      status: 'active',
      config: { appKey, appSecret, shopId: 'shop-A' }
    }),
    adapter: new DouyinCommerceAdapter(),
    eventInbox: { store: async event => { stored.push(event); return { stored: true, duplicate: false } } },
    schedule: task => scheduled.push(task),
    logger: { info() {}, warn() {}, error() {} }
  })
  const res = responseStub()

  await handler({
    query: { account_id: '9' }, headers: { 'app-id': appKey, 'event-sign': signature },
    rawBody, body: payload
  }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { code: 0, msg: 'success' })
  assert.equal(scheduled.length, 1)
  await scheduled[0]()
  assert.equal(stored.length, 1)
})

test('accepts a tag zero probe without a shop id', async () => {
  const appKey = 'douyin-app'
  const appSecret = 'douyin-secret'
  const payload = [{ tag: '0', msg_id: 'probe-1', data: 'probe' }]
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = createEventSignature({ appId: appKey, appSecret, rawBody })
  const scheduled = []
  const handler = createDouyinWebhookHandler({
    loadAccount: async () => ({
      id: 9,
      channel: 'douyin',
      status: 'active',
      config: { appKey, appSecret, shopId: 'shop-A' }
    }),
    adapter: new DouyinCommerceAdapter(),
    eventInbox: { store: async () => assert.fail('must not store a probe') },
    schedule: task => scheduled.push(task),
    logger: { info() {}, warn() {}, error() {} }
  })
  const res = responseStub()

  await handler({
    query: { account_id: '9' }, headers: { 'app-id': appKey, 'event-sign': signature },
    rawBody, body: payload
  }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { code: 0, msg: 'success' })
  assert.equal(scheduled.length, 1)
  await scheduled[0]()
})
