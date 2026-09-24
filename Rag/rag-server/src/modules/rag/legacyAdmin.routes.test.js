const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const { createAuthenticate } = require('../../middleware/authenticate')
const { createLegacyAdminRouter } = require('./legacyAdmin.routes')

const environment = { JWT_SECRET: 'isolated-legacy-admin-test-secret' }
const endpoints = [
  ['GET', '/stats', 'getStats'],
  ['GET', '/seat-skill-tags', 'getSeatSkillTags'],
  ['POST', '/seat-skill-tags', 'createSeatSkillTag'],
  ['DELETE', '/seat-skill-tags/3', 'deleteSeatSkillTag'],
  ['GET', '/users', 'getUsers'],
  ['POST', '/users/3/update', 'updateUser'],
  ['DELETE', '/users/3', 'deleteUser']
]

async function withHarness(callback) {
  const calls = []
  const users = new Map([
    [1, { id: 1, username: 'admin', role: 'admin', status: 'active' }],
    [2, { id: 2, username: 'supervisor', role: 'supervisor', status: 'active' }],
    [3, { id: 3, username: 'agent', role: 'agent', status: 'active' }],
    [4, { id: 4, username: 'disabled', role: 'admin', status: 'disabled' }]
  ])
  const controller = Object.fromEntries(endpoints.map(([, , handler]) => [handler, (req, res) => {
    calls.push(handler)
    res.json({ success: true, handler, operatorId: req.user?.id })
  }]))
  const app = express()
  app.use('/api/admin', createLegacyAdminRouter({
    controller,
    authenticate: createAuthenticate({ environment, findUser: async id => users.get(id) })
  }))
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  async function request(endpoint, userId) {
    const token = userId === undefined ? null : jwt.sign({ id: userId, role: 'admin' }, environment.JWT_SECRET, {
      algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web'
    })
    return fetch(`http://127.0.0.1:${server.address().port}/api/admin${endpoint[1]}`, {
      method: endpoint[0], headers: token ? { authorization: `Bearer ${token}` } : {}
    })
  }
  try { await callback({ request, calls }) } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('legacy administration rejects anonymous requests before any controller runs', async () => {
  await withHarness(async ({ request, calls }) => {
    for (const endpoint of endpoints) assert.equal((await request(endpoint)).status, 401, endpoint[1])
    assert.deepEqual(calls, [])
  })
})

test('stored agent role cannot access legacy administration even with old admin claims', async () => {
  await withHarness(async ({ request, calls }) => {
    for (const endpoint of endpoints) assert.equal((await request(endpoint, 3)).status, 403, endpoint[1])
    assert.deepEqual(calls, [])
  })
})

test('supervisors keep stats and skill access but cannot list or modify system users', async () => {
  await withHarness(async ({ request, calls }) => {
    for (const endpoint of endpoints) {
      assert.equal((await request(endpoint, 2)).status, endpoint[1].startsWith('/users') ? 403 : 200)
    }
    assert.deepEqual(calls, endpoints.slice(0, 4).map(endpoint => endpoint[2]))
  })
})

test('active administrators can use every legacy administration operation', async () => {
  await withHarness(async ({ request, calls }) => {
    for (const endpoint of endpoints) {
      const response = await request(endpoint, 1)
      assert.equal(response.status, 200)
      assert.equal((await response.json()).operatorId, 1)
    }
    assert.deepEqual(calls, endpoints.map(endpoint => endpoint[2]))
  })
})

test('disabled or deleted administrators cannot use a still-valid JWT', async () => {
  await withHarness(async ({ request, calls }) => {
    assert.equal((await request(endpoints[5], 4)).status, 401)
    assert.equal((await request(endpoints[5], 999)).status, 401)
    assert.deepEqual(calls, [])
  })
})
