const test = require('node:test')
const assert = require('node:assert/strict')

const { requireProjectionAdmin } = require('./commerceProjectionAdminRoutes')

test('allows only administrators to operate projection jobs', () => {
  let nextCalls = 0
  requireProjectionAdmin({ user: { role: 'admin' } }, {}, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)

  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
  requireProjectionAdmin({ user: { role: 'supervisor' } }, response, () => { nextCalls += 1 })
  assert.equal(response.statusCode, 403)
  assert.deepEqual(response.body, {
    success: false,
    error: { code: 'FORBIDDEN', message: 'Only administrators can manage projection jobs' }
  })
  assert.equal(nextCalls, 1)
})

