const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const { resolveJwtConfig } = require('../config/jwt')
const { createAuthenticate } = require('./authenticate')

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

test('rejects a missing JWT secret outside explicit tests', () => {
  assert.throws(
    () => resolveJwtConfig({ NODE_ENV: 'development' }),
    /JWT_SECRET/
  )
})

test('accepts an explicitly injected secret and fixed JWT contract', () => {
  assert.deepEqual(resolveJwtConfig({ JWT_SECRET: 'test-secret' }), {
    secret: 'test-secret',
    issuer: 'rag-server',
    audience: 'platform-web',
    algorithms: ['HS256'],
    expiresIn: '7d'
  })
})

test('normalizes a legacy user role and rejects disabled accounts', async () => {
  const environment = { JWT_SECRET: 'test-secret' }
  const token = jwt.sign(
    { id: 7, username: 'seat-7', role: 'user' },
    environment.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web' }
  )
  const req = { headers: { authorization: `Bearer ${token}` } }
  const res = createResponse()
  let nextCalls = 0
  const authenticate = createAuthenticate({
    environment,
    findUser: async () => ({ id: 7, username: 'seat-7', role: 'user', status: 'active' })
  })

  await authenticate(req, res, () => { nextCalls += 1 })

  assert.equal(nextCalls, 1)
  assert.equal(req.user.role, 'agent')

  const disabledRes = createResponse()
  const disabled = createAuthenticate({
    environment,
    findUser: async () => ({ id: 7, username: 'seat-7', role: 'agent', status: 'disabled' })
  })
  await disabled(req, disabledRes, () => {})
  assert.equal(disabledRes.statusCode, 401)
  assert.equal(disabledRes.body.message, '账号不可用')
})

test('uses the current database role instead of a stale JWT role', async () => {
  const environment = { JWT_SECRET: 'test-secret' }
  const token = jwt.sign(
    { id: 8, username: 'manager-8', role: 'agent' },
    environment.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web' }
  )
  const req = { headers: { authorization: `Bearer ${token}` } }
  const res = createResponse()
  let nextCalls = 0
  const authenticate = createAuthenticate({
    environment,
    findUser: async () => ({
      id: 8,
      username: 'manager-8',
      role: 'supervisor',
      status: 'active'
    })
  })

  await authenticate(req, res, () => { nextCalls += 1 })

  assert.equal(nextCalls, 1)
  assert.equal(req.user.role, 'supervisor')
})

test('does not expose JWT parser details in authentication errors', async () => {
  const res = createResponse()
  const authenticate = createAuthenticate({
    environment: { JWT_SECRET: 'test-secret' },
    findUser: async () => null
  })

  await authenticate(
    { headers: { authorization: 'Bearer invalid-token' } },
    res,
    () => assert.fail('next must not be called')
  )

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { success: false, message: '认证失败' })
})
