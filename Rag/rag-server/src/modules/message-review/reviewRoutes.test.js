const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const { createReviewRouter } = require('./reviewRoutes')

async function request(router, { path = '/', method = 'GET', body, role = 'agent' } = {}) {
  const app = express()
  app.use(express.json())
  app.use(router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function createHarness(overrides = {}, routerOptions = {}) {
  const calls = []
  const service = {
    list: async (filters) => { calls.push(['list', filters]); return { items: [], total: 0 } },
    stats: async (actor) => { calls.push(['stats', actor]); return { mine: 1, public: 2, high: 1 } },
    detail: async (id) => { calls.push(['detail', id]); return { id, status: 'pending' } },
    claim: async (id, actor) => { calls.push(['claim', id, actor]); return { id, status: 'claimed' } },
    takeover: async (id, actor) => { calls.push(['takeover', id, actor]); return { id, status: 'claimed', claimed_by: actor.id } },
    release: async (id, actor) => { calls.push(['release', id, actor]); return { id, status: 'pending' } },
    reply: async (id, actor, text) => { calls.push(['reply', id, actor, text]); return { id, status: 'replied' } },
    dismiss: async (id, actor, input) => { calls.push(['dismiss', id, actor, input]); return { id, status: 'dismissed' } },
    ...overrides
  }
  const authenticate = (req, _res, next) => {
    req.user = { id: 7, role: req.headers['x-test-role'] || 'agent' }
    next()
  }
  return { calls, router: createReviewRouter({ service, authenticate, ...routerOptions }) }
}

test('agent cannot request all scope but can request mine and public', async () => {
  const { router, calls } = createHarness()
  assert.equal((await request(router, { path: '/?scope=all' })).status, 403)
  assert.equal((await request(router, { path: '/?scope=mine' })).status, 200)
  assert.equal((await request(router, { path: '/?scope=public' })).status, 200)
  assert.equal(calls.filter(([name]) => name === 'list').length, 2)
})

test('supervisor can list all review items', async () => {
  const { router, calls } = createHarness()
  const result = await request(router, { path: '/?scope=all&limit=500', role: 'supervisor' })
  assert.equal(result.status, 200)
  assert.equal(calls[0][1].limit, 100)
  assert.equal(calls[0][1].role, 'supervisor')
})

test('claim conflict maps to HTTP 409', async () => {
  const error = new Error('already claimed')
  error.code = 'REVIEW_CONFLICT'
  const { router } = createHarness({ claim: async () => { throw error } })
  const result = await request(router, { path: '/r1/claim', method: 'POST', body: {} })
  assert.equal(result.status, 409)
})

test('takeover route delegates the acting supervisor to the service', async () => {
  const { router, calls } = createHarness()
  const result = await request(router, { path: '/r1/takeover', method: 'POST', body: {}, role: 'supervisor' })
  assert.equal(result.status, 200)
  assert.equal(calls.find(([name]) => name === 'takeover')[2].role, 'supervisor')
})

test('dismiss requires a reason code before calling the service', async () => {
  const { router, calls } = createHarness()
  const result = await request(router, { path: '/r1/dismiss', method: 'POST', body: {} })
  assert.equal(result.status, 400)
  assert.equal(calls.some(([name]) => name === 'dismiss'), false)
})

test('reply send failure maps to HTTP 502 and missing item maps to 404', async () => {
  const sendError = new Error('channel unavailable')
  sendError.code = 'REVIEW_SEND_FAILED'
  const notFound = new Error('missing')
  notFound.code = 'REVIEW_NOT_FOUND'
  const { router } = createHarness({
    reply: async () => { throw sendError },
    detail: async () => { throw notFound }
  })

  assert.equal((await request(router, {
    path: '/r1/reply', method: 'POST', body: { text: 'answer' }
  })).status, 502)
  assert.equal((await request(router, { path: '/missing' })).status, 404)
})

test('internal route failures are logged without exposing the error to clients', async () => {
  const logged = []
  const error = new Error('database detail that must remain private')
  const { router } = createHarness(
    { stats: async () => { throw error } },
    { logger: { error: (event, data) => logged.push([event, data]) } }
  )

  const result = await request(router, { path: '/stats' })
  assert.equal(result.status, 500)
  assert.equal(result.body.message, 'Message review operation failed')
  assert.equal(JSON.stringify(result.body).includes(error.message), false)
  assert.equal(logged[0][0], 'review_route_failed')
  assert.equal(logged[0][1].errorMessage, error.message)
})
