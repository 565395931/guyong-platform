const test = require('node:test')
const assert = require('node:assert/strict')

const {
  canViewConnections,
  canManageConnections,
  canManageAccountPolicy,
  canManageAllowlist,
  createPlatformConnectionsRouter,
  statusForError
} = require('./platformConnections.routes')

test('enforces connection and account-policy roles', () => {
  assert.equal(canViewConnections({ role: 'agent' }), false)
  assert.equal(canViewConnections({ role: 'supervisor' }), true)
  assert.equal(canManageConnections({ role: 'supervisor' }), false)
  assert.equal(canManageConnections({ role: 'admin' }), true)
  assert.equal(canManageAccountPolicy({ role: 'supervisor' }), true)
  assert.equal(canManageAllowlist({ role: 'supervisor' }), true)
  assert.equal(canManageAllowlist({ role: 'agent' }), false)
})

test('exposes the enterprise connection lifecycle endpoints', () => {
  const service = new Proxy({}, { get: () => async () => [] })
  const router = createPlatformConnectionsRouter({
    service,
    authenticate: (req, res, next) => { req.user = { id: 1, role: 'admin' }; next() }
  })
  const routes = router.stack.filter(layer => layer.route).map(layer => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods)
  }))

  assert.ok(routes.some(route => route.path === '/' && route.methods.includes('get')))
  assert.ok(routes.some(route => route.path === '/' && route.methods.includes('post')))
  assert.ok(routes.some(route => route.path === '/:id/credentials' && route.methods.includes('patch')))
  assert.ok(routes.some(route => route.path === '/:id/verify' && route.methods.includes('post')))
  assert.ok(routes.some(route => route.path === '/:id/publish-runtime' && route.methods.includes('post')))
  assert.ok(routes.some(route => route.path === '/:id/disable-runtime' && route.methods.includes('post')))
  assert.ok(routes.some(route => route.path === '/:id/accounts' && route.methods.includes('get')))
  assert.ok(routes.some(route => route.path === '/accounts/:accountId/policy' && route.methods.includes('patch')))
  assert.ok(routes.some(route => route.path === '/accounts/:accountId/allowlist' && route.methods.includes('get')))
  assert.ok(routes.some(route => route.path === '/accounts/:accountId/allowlist' && route.methods.includes('post')))
  assert.ok(routes.some(route => route.path === '/accounts/:accountId/allowlist/:entryId' && route.methods.includes('delete')))
  assert.ok(routes.some(route => route.path === '/operation-logs' && route.methods.includes('get')))
})

test('maps stable client-facing error statuses', () => {
  assert.equal(statusForError(new Error('connectionName is required')), 400)
  assert.equal(statusForError(new Error('production baseline account is locked')), 400)
  assert.equal(statusForError(new Error('enterprise CorpID already exists')), 409)
  assert.equal(statusForError(new Error('platform connection not found')), 404)
  assert.equal(statusForError(new Error('WeCom runtime config publisher is not configured')), 503)
  assert.equal(statusForError(new Error('disable runtime before editing account configuration')), 409)
  assert.equal(statusForError(new Error('allowlist is available only for test accounts')), 400)
  assert.equal(statusForError(new Error('only an active WeCom runtime can be disabled')), 400)
  assert.equal(statusForError(new Error('database unavailable')), 500)
})
