'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWarehouseRouter } = require('./warehouse.routes')

function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } } }

test('exposes warehouse inventory and reservation endpoints with role gates', () => {
  const service = {}
  const router = createWarehouseRouter({ service, authenticate: (req, res, next) => { req.user = { id: 4, role: 'admin' }; next() } })
  const routes = router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`)
  assert.deepEqual(routes, [
    'GET /', 'POST /', 'GET /:code/inventory', 'POST /:code/inventory/adjust',
    'GET /:code/inventory/:skuCode', 'GET /:code/reservations', 'GET /:code/ledger', 'POST /:code/reservations', 'POST /reservations/:reservationKey/release', 'POST /reservations/:reservationKey/fulfill'
  ])
})

test('returns a stable generic error for invalid warehouse requests', async () => {
  const router = createWarehouseRouter({
    service: { async createWarehouse() { const error = new Error('warehouse code is required'); error.code = 'warehouse_invalid_input'; throw error } },
    authenticate: (req, res, next) => { req.user = { id: 4, role: 'admin' }; next() }
  })
  const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle
  const res = response()
  await handler({ body: {}, user: { id: 4, role: 'admin' } }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.success, false)
})

test('maps missing warehouses to 404', async () => {
  const router = createWarehouseRouter({
    service: { listWarehouses: async () => [], listInventory: async () => { const error = new Error('warehouse not found'); error.code = 'warehouse_not_found'; throw error } },
    authenticate: (req, res, next) => { req.user = { role: 'agent', id: 1 }; next() }
  })
  const layer = router.stack.find(item => item.route?.path === '/:code/inventory')
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body } }
  await layer.route.stack.at(-1).handle({ params: { code: 'MISSING' } }, response)
  assert.equal(response.statusCode, 404)
})

test('forwards bounded ledger filters through the read route', async () => {
  let received = null
  const router = createWarehouseRouter({
    service: { listLedger: async (code, filters) => { received = { code, filters }; return { items: [], total: 0, page: 2, pageSize: 50 } } },
    authenticate: (req, res, next) => { req.user = { role: 'agent', id: 1 }; next() }
  })
  const layer = router.stack.find(item => item.route?.path === '/:code/ledger')
  const res = response()
  await layer.route.stack.at(-1).handle({ params: { code: 'WH-1' }, query: { skuCode: 'SKU-1', operationType: 'receipt', page: '2', pageSize: '50' } }, res)
  assert.deepEqual(received, { code: 'WH-1', filters: { skuCode: 'SKU-1', operationType: 'receipt', page: '2', pageSize: '50' } })
  assert.equal(res.body.data.total, 0)
})
