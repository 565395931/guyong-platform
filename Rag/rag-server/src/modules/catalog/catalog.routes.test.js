const test = require('node:test')
const assert = require('node:assert/strict')
const {
  canReadCatalog,
  canManageCatalog,
  createCatalogRouter,
  statusForError
} = require('./catalog.routes')

test('agents can read but cannot mutate catalog data', () => {
  assert.equal(canReadCatalog({ role: 'agent' }), true)
  assert.equal(canManageCatalog({ role: 'agent' }), false)
  assert.equal(canManageCatalog({ role: 'supervisor' }), true)
  assert.equal(canManageCatalog({ role: 'admin' }), true)
})

test('route factory exposes catalog lifecycle and quote endpoints', () => {
  const noOpService = new Proxy({}, { get: () => async () => [] })
  const router = createCatalogRouter({
    catalogService: noOpService,
    importService: noOpService,
    quoteService: noOpService,
    authenticate: (req, res, next) => { req.user = { id: 1, role: 'admin' }; next() }
  })
  const paths = router.stack.filter(layer => layer.route).map(layer => layer.route.path)
  assert.ok(paths.includes('/versions'))
  assert.ok(paths.includes('/versions/:id/publish'))
  assert.ok(paths.includes('/import/preview'))
  assert.ok(paths.includes('/quote/resolve'))
})

test('domain errors map to stable HTTP statuses', () => {
  assert.equal(statusForError(new Error('skuCode is required')), 400)
  assert.equal(statusForError(new Error('catalog changes require a draft version')), 409)
  assert.equal(statusForError(new Error('catalog version not found')), 404)
  assert.equal(statusForError(new Error('database offline')), 500)
})

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
}

test('unexpected catalog service errors return a generic 500 without internal details', async () => {
  const router = createCatalogRouter({
    catalogService: { listVersions: async () => { throw new Error('SQL failure SELECT private_column FROM internal_table') } },
    importService: {}, quoteService: {}, authenticate: (req, res, next) => next()
  })
  const handler = router.stack.find(layer => layer.route?.path === '/versions').route.stack.at(-1).handle
  const res = response()
  await handler({}, res)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { success: false, message: '目录操作失败，请稍后重试' })
})

test('catalog error middleware masks unknown failures but preserves business errors', () => {
  const router = createCatalogRouter({ catalogService: {}, importService: {}, quoteService: {}, authenticate: (req, res, next) => next() })
  const handler = router.stack.find(layer => !layer.route && layer.handle.length === 4).handle
  for (const [message, statusCode, expectedMessage] of [
    ['internal parser stack details', 500, '目录操作失败，请稍后重试'],
    ['不支持的文件类型', 400, '不支持的文件类型'],
    ['catalog version not found', 404, 'catalog version not found'],
    ['catalog changes require a draft version', 409, 'catalog changes require a draft version']
  ]) {
    const res = response()
    handler(new Error(message), {}, res, () => assert.fail('error must be handled'))
    assert.equal(res.statusCode, statusCode)
    assert.deepEqual(res.body, { success: false, message: expectedMessage })
  }
})

test('catalog service business errors retain the existing 4xx message', async () => {
  for (const [message, statusCode] of [
    ['skuCode is required', 400], ['catalog version not found', 404], ['catalog changes require a draft version', 409]
  ]) {
    const router = createCatalogRouter({
      catalogService: { listVersions: async () => { throw new Error(message) } },
      importService: {}, quoteService: {}, authenticate: (req, res, next) => next()
    })
    const handler = router.stack.find(layer => layer.route?.path === '/versions').route.stack.at(-1).handle
    const res = response()
    await handler({}, res)
    assert.equal(res.statusCode, statusCode)
    assert.deepEqual(res.body, { success: false, message })
  }
})
