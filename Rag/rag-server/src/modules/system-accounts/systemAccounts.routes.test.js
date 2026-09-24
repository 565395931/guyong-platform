const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')

const { createSystemAccountsRouter } = require('./systemAccounts.routes')

async function withServer(router, callback) {
  const app = express()
  app.use(express.json())
  app.use(router)
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const { port } = server.address()
    await callback(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function serviceStub() {
  const calls = []
  return {
    calls,
    service: {
      list: async query => { calls.push(['list', query]); return [{ id: 1, username: 'admin', role: 'admin', status: 'active' }] },
      create: async body => { calls.push(['create', body]); return { id: 2, username: body.username, role: body.role, status: 'active' } },
      update: async (id, body, context) => { calls.push(['update', id, body, context]); return { id: Number(id), ...body } },
      resetPassword: async (id, body) => { calls.push(['reset', id, body]); return { id: Number(id), username: 'agent1' } },
      remove: async (id, context) => { calls.push(['remove', id, context]); return { id: Number(id) } }
    }
  }
}

test('requires a valid token and administrator role', async () => {
  const secret = 'system-account-test-secret'
  const { service } = serviceStub()
  await withServer(createSystemAccountsRouter({ service, jwtSecret: secret }), async base => {
    const missing = await fetch(base)
    assert.equal(missing.status, 401)

    const agentToken = jwt.sign({ id: 2, role: 'agent' }, secret)
    const forbidden = await fetch(base, { headers: { authorization: `Bearer ${agentToken}` } })
    assert.equal(forbidden.status, 403)
  })
})

test('routes administrator lifecycle operations and returns safe responses', async () => {
  const secret = 'system-account-test-secret'
  const { service, calls } = serviceStub()
  const token = jwt.sign({ id: 1, role: 'admin' }, secret)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await withServer(createSystemAccountsRouter({ service, jwtSecret: secret }), async base => {
    assert.equal((await fetch(base, { headers })).status, 200)
    assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify({ username: 'agent2', password: '123456', role: 'agent' }) })).status, 200)
    assert.equal((await fetch(`${base}/2`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'disabled' }) })).status, 200)
    assert.equal((await fetch(`${base}/2/reset-password`, { method: 'POST', headers, body: JSON.stringify({ password: 'abcdef' }) })).status, 200)
    assert.equal((await fetch(`${base}/2`, { method: 'DELETE', headers })).status, 200)
  })
  assert.deepEqual(calls.map(call => call[0]), ['list', 'create', 'update', 'reset', 'remove'])
  assert.equal(calls[2][3].actorId, 1)
  assert.equal(calls[4][2].actorId, 1)
})

test('maps service errors to their HTTP status', async () => {
  const secret = 'system-account-test-secret'
  const error = new Error('用户名已存在')
  error.status = 409
  const token = jwt.sign({ id: 1, role: 'admin' }, secret)
  const service = { list: async () => { throw error } }
  await withServer(createSystemAccountsRouter({ service, jwtSecret: secret }), async base => {
    const response = await fetch(base, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).message, '用户名已存在')
  })
})

test('single-owner mode blocks account administration after authentication', async () => {
  const secret = 'single-owner-test-secret'
  const { service } = serviceStub()
  const token = jwt.sign({ id: 1, role: 'admin' }, secret)
  await withServer(createSystemAccountsRouter({ service, jwtSecret: secret, accountMode: 'single_owner' }), async base => {
    const response = await fetch(base, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 403)
    assert.match((await response.json()).message, /单账号模式/)
  })
})
