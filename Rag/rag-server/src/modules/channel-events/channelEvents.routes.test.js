const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const jwt = require('jsonwebtoken')

const routeModule = require('./channelEvents.routes')
let jwtConfig = {}
try { jwtConfig = require('../../config/jwt') } catch { jwtConfig = {} }

const {
  createChannelEventsRouter,
  createJwtAuth,
  requireEventReader,
  resolveEventAccessScope
} = routeModule

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function routeHandler(router, path) {
  return router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle
}

test('auth signing and event verification require one configured secret without a fallback', () => {
  assert.equal(typeof jwtConfig.resolveJwtSecret, 'function')
  assert.throws(() => jwtConfig.resolveJwtSecret({}), /JWT_SECRET/)
  assert.equal(jwtConfig.resolveJwtSecret({ JWT_SECRET: 'configured' }), 'configured')

  const authSource = readFileSync(require.resolve('../../routes/auth'), 'utf8')
  const accountSource = readFileSync(require.resolve('../../routes/channelAccounts'), 'utf8')
  const eventSource = readFileSync(require.resolve('./channelEvents.routes'), 'utf8')
  assert.match(authSource, /require\('\.\.\/config\/jwt'\)/)
  assert.match(accountSource, /require\('\.\.\/middleware\/authenticate'\)/)
  assert.match(accountSource, /createAuthenticate\(\)/)
  assert.doesNotMatch(accountSource, /dev_only/)
  assert.match(eventSource, /createAuthenticate/)
  assert.doesNotMatch(eventSource, /dev_only/)
})

test('JWT middleware rejects missing, invalid, wrong-contract and disabled-user tokens', async () => {
  const environment = { JWT_SECRET: 'test-secret' }
  const activeToken = jwt.sign(
    { id: 1, role: 'admin' },
    environment.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web' }
  )
  const noContractToken = jwt.sign({ id: 1, role: 'admin' }, environment.JWT_SECRET)
  let disabled = false
  const auth = createJwtAuth({
    environment,
    findUser: async () => ({ id: 1, username: 'seat', role: 'agent', status: disabled ? 'disabled' : 'active' })
  })
  for (const headers of [{}, { authorization: 'Bearer bad' }]) {
    const response = responseDouble()
    await auth({ headers }, response, () => assert.fail('request must not continue'))
    assert.equal(response.statusCode, 401)
  }

  const wrongContract = responseDouble()
  await auth({ headers: { authorization: `Bearer ${noContractToken}` } }, wrongContract, () => assert.fail('request must not continue'))
  assert.equal(wrongContract.statusCode, 401)

  const request = { headers: { authorization: `Bearer ${activeToken}` } }
  await auth(request, responseDouble(), () => {})
  assert.equal(request.user.role, 'agent', 'database role must replace the token role')

  disabled = true
  const disabledResponse = responseDouble()
  await auth(request, disabledResponse, () => assert.fail('disabled request must not continue'))
  assert.equal(disabledResponse.statusCode, 401)
})

test('only agent supervisor and admin roles can read events', () => {
  assert.equal(typeof requireEventReader, 'function')
  for (const role of ['agent', 'supervisor', 'admin']) {
    const request = { user: { id: 9, role } }
    let continued = false
    requireEventReader(request, responseDouble(), () => { continued = true })
    assert.equal(continued, true)
    assert.deepEqual(request.eventAccessScope, role === 'agent'
      ? { mode: 'bound', seatId: 9 }
      : { mode: 'all' })
  }

  const response = responseDouble()
  requireEventReader({ user: { id: 9, role: 'auditor' } }, response, () => assert.fail('role must be rejected'))
  assert.equal(response.statusCode, 403)
})

test('access scope helper fails closed for malformed agents', () => {
  assert.deepEqual(resolveEventAccessScope({ id: 5, role: 'agent' }), { mode: 'bound', seatId: 5 })
  assert.equal(resolveEventAccessScope({ id: 'invalid', role: 'agent' }), null)
  assert.equal(resolveEventAccessScope({ id: 5, role: 'viewer' }), null)
})

test('router exposes summary, credential-free account options and detail endpoints', () => {
  const repository = {
    list: async () => [], count: async () => 0,
    listAccountOptions: async () => [], projectionSummary: async () => ({}), detail: async () => null
  }
  const router = createChannelEventsRouter({
    repository,
    authenticate: (req, res, next) => next()
  })
  const routes = router.stack.filter(layer => layer.route).map(layer => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods)
  }))
  assert.deepEqual(routes, [
    { path: '/accounts', methods: ['get'] },
    { path: '/projection-summary', methods: ['get'] },
    { path: '/:id', methods: ['get'] },
    { path: '/', methods: ['get'] }
  ])
})

test('projection summary passes the validated channel and current access scope', async () => {
  const scope = { mode: 'bound', seatId: 7 }
  let received
  const repository = {
    async list() { return [] }, async count() { return 0 }, async detail() { return null },
    async listAccountOptions() { return [] },
    async projectionSummary(channel, accessScope) {
      received = { channel, accessScope }
      return { total: 12, ready: 5, rawOnly: 7 }
    }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })
  const response = responseDouble()

  await routeHandler(router, '/projection-summary')({
    query: { channel: 'PINDUODUO' }, eventAccessScope: scope
  }, response)

  assert.deepEqual(received, { channel: 'pinduoduo', accessScope: scope })
  assert.deepEqual(response.body, {
    success: true,
    data: { total: 12, ready: 5, rawOnly: 7 }
  })
})

test('projection summary rejects malformed channels and hides repository failures', async () => {
  const repository = {
    async projectionSummary() { throw new Error('database detail') },
    async list() { return [] }, async count() { return 0 }, async detail() { return null },
    async listAccountOptions() { return [] }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })

  const invalid = responseDouble()
  await routeHandler(router, '/projection-summary')({ query: { channel: "x' OR 1=1" }, eventAccessScope: { mode: 'all' } }, invalid)
  assert.equal(invalid.statusCode, 400)

  const failed = responseDouble()
  await routeHandler(router, '/projection-summary')({ query: { channel: 'taobao' }, eventAccessScope: { mode: 'all' } }, failed)
  assert.equal(failed.statusCode, 500)
  assert.equal(failed.body.message, 'Projection summary query failed')
  assert.doesNotMatch(JSON.stringify(failed.body), /database detail/)
})

test('GET passes the access scope and returns summaries without payload', async () => {
  const scope = { mode: 'bound', seatId: 7 }
  const calls = []
  const repository = {
    async list(filters, accessScope) {
      calls.push({ method: 'list', filters, accessScope })
      return [{ id: 4, payload_json: '{"secret":"must-not-leak"}' }]
    },
    async count(filters, accessScope) { calls.push({ method: 'count', filters, accessScope }); return 1 },
    async listAccountOptions() { return [] }, async detail() { return null }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })
  const response = responseDouble()

  await routeHandler(router, '/')({
    query: { channel: 'DOUYIN', limit: '5', offset: '10' }, eventAccessScope: scope
  }, response)

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].accessScope, scope)
  assert.deepEqual(calls[1].accessScope, scope)
  assert.equal(Object.hasOwn(response.body.data.items[0], 'payload'), false)
  assert.deepEqual(response.body.data, {
    items: [{
      id: 4, channel: undefined, accountId: undefined, accountName: null,
      externalEventId: undefined, eventType: undefined, category: undefined,
      businessKey: null, status: undefined, occurredAt: null, receivedAt: undefined,
      projectionState: 'not_applicable'
    }],
    total: 1, limit: 5, offset: 10
  })
})

test('account options pass channel and the same access scope', async () => {
  const scope = { mode: 'bound', seatId: 7 }
  let received
  const repository = {
    async list() { return [] }, async count() { return 0 }, async detail() { return null },
    async listAccountOptions(channel, accessScope) {
      received = { channel, accessScope }
      return [{ id: 7, name: '旗舰店' }]
    }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })
  const response = responseDouble()

  await routeHandler(router, '/accounts')({ query: { channel: 'DOUYIN' }, eventAccessScope: scope }, response)

  assert.deepEqual(received, { channel: 'douyin', accessScope: scope })
  assert.deepEqual(response.body, { success: true, data: [{ id: 7, name: '旗舰店' }] })
})

test('detail returns a redacted payload and hides missing or unauthorized events behind 404', async () => {
  const scope = { mode: 'bound', seatId: 7 }
  let received
  let row = {
    id: 4, channel: 'douyin', account_id: 7, payload_json: '{"token":"secret","safe":true}'
  }
  const repository = {
    async list() { return [] }, async count() { return 0 }, async listAccountOptions() { return [] },
    async detail(eventId, accessScope) { received = { eventId, accessScope }; return row }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })
  const handler = routeHandler(router, '/:id')
  const response = responseDouble()

  await handler({ params: { id: '4' }, eventAccessScope: scope }, response)
  assert.deepEqual(received, { eventId: 4, accessScope: scope })
  assert.deepEqual(response.body.data.payload, { token: '[REDACTED]', safe: true })

  row = null
  const hidden = responseDouble()
  await handler({ params: { id: '4' }, eventAccessScope: scope }, hidden)
  assert.equal(hidden.statusCode, 404)
  assert.deepEqual(hidden.body, { success: false, message: '事件不存在' })
})

test('route rejects malformed pagination with 400', async () => {
  const repository = {
    async list() { assert.fail('invalid query must not reach repository') },
    async count() { assert.fail('invalid query must not reach repository') },
    async listAccountOptions() { return [] }, async detail() { return null }
  }
  const router = createChannelEventsRouter({ repository, authenticate: (req, res, next) => next() })
  const response = responseDouble()

  await routeHandler(router, '/')({
    query: { limit: '20junk' }, eventAccessScope: { mode: 'all' }
  }, response)

  assert.equal(response.statusCode, 400)
  assert.match(response.body.message, /limit/i)
})
