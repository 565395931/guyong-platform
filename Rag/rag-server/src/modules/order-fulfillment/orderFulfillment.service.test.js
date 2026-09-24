'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOrderFulfillmentService } = require('./orderFulfillment.service')

function memoryRepository() {
  const state = { fulfillments: new Map(), outbox: new Map(), shipments: [], statuses: [] }
  return {
    state,
    async getOrder(orderId) { return orderId === 'ORDER-1' ? { id: orderId, orderNo: 'SO-1', channel: 'taobao', accountId: 7, externalOrderId: 'TB-1' } : null },
    async listItems() { return [{ id: 'line-1', externalSku: 'TB-001', skuCode: null, quantity: '2' }] },
    async findFulfillment(orderId) { return [...state.fulfillments.values()].find(row => row.orderId === orderId) || null },
    async createFulfillment(row) { state.fulfillments.set(row.id, row); return row },
    async markShipped(id, input) { const row = state.fulfillments.get(id); const updated = { ...row, status: 'shipped', ...input }; state.fulfillments.set(id, updated); return updated },
    async createShipment(input) { state.shipments.push(input); return input },
    async enqueueWriteback(row) { const stored = { id: row.id || `wb-${state.outbox.size + 1}`, status: 'pending', ...row }; state.outbox.set(stored.id, stored); return stored },
    async findPendingWriteback(fulfillmentId) { return [...state.outbox.values()].find(row => row.fulfillmentId === fulfillmentId && row.status === 'pending') || null },
    async getWritebackStatus(fulfillmentId) { return [...state.outbox.values()].find(row => row.fulfillmentId === fulfillmentId && row.eventType === 'shipment.created')?.status || null },
    async markWriteback(id, patch) { const row = state.outbox.get(id); const updated = { ...row, ...patch }; state.outbox.set(id, updated); return updated },
    async updateOrderStatus(orderId, status) { state.statuses.push({ orderId, status }) }
  }
}

test('reserves an order after resolving the platform SKU to the warehouse SKU', async () => {
  const repository = memoryRepository()
  const reserved = []
  const service = createOrderFulfillmentService({
    repository,
    warehouseService: { reserve: async input => { reserved.push(input); return { reservationKey: input.reservationKey } }, fulfill: async () => ({}) },
    skuMappingService: { resolve: async () => ({ internalSkuCode: 'SKU-001' }) }
  })
  const result = await service.reserve({ orderId: 'ORDER-1', warehouseCode: 'WH-SH', idempotencyKey: 'alloc-1', operatorId: 9 })
  assert.equal(result.status, 'reserved')
  assert.deepEqual(reserved[0].lines, [{ skuCode: 'SKU-001', quantity: '2' }])
})

test('ships once, creates logistics record, and dispatches platform writeback', async () => {
  const repository = memoryRepository()
  const fulfilled = []
  const service = createOrderFulfillmentService({
    repository,
    warehouseService: {
      reserve: async input => ({ reservationKey: input.reservationKey }),
      fulfill: async key => { fulfilled.push(key); return { reservationKey: key } }
    },
    skuMappingService: { resolve: async () => ({ internalSkuCode: 'SKU-001' }) },
    writebackAdapter: { writeShipment: async input => ({ externalTrackingNo: input.trackingNo }) }
  })
  await service.reserve({ orderId: 'ORDER-1', warehouseCode: 'WH-SH', idempotencyKey: 'alloc-2', operatorId: 9 })
  const result = await service.ship({ orderId: 'ORDER-1', courier: '申通', trackingNo: 'ST-001', operatorId: 9 })
  assert.equal(result.status, 'shipped')
  assert.deepEqual(fulfilled, ['order:ORDER-1:alloc-2'])
  assert.equal(repository.state.shipments[0].trackingNo, 'ST-001')
  assert.equal([...repository.state.outbox.values()][0].status, 'succeeded')
})

test('blocks allocation when the external SKU has no active mapping', async () => {
  const repository = memoryRepository()
  const service = createOrderFulfillmentService({
    repository,
    warehouseService: { reserve: async () => { throw new Error('should not reserve') } },
    skuMappingService: { resolve: async () => { const error = new Error('mapping missing'); error.code = 'platform_sku_mapping_unavailable'; throw error } }
  })
  await assert.rejects(() => service.reserve({ orderId: 'ORDER-1', warehouseCode: 'WH-SH', idempotencyKey: 'alloc-3', operatorId: 9 }), error => error.code === 'platform_sku_mapping_unavailable')
})

for (const status of ['pending', 'processing', 'failed', 'succeeded', null]) {
  test(`shipped retries report ${status || 'unknown'} from outbox without shipping again`, async () => {
    const repository = memoryRepository()
    repository.state.fulfillments.set('F-1', { id: 'F-1', orderId: 'ORDER-1', status: 'shipped' })
    if (status) repository.state.outbox.set('WB-1', { id: 'WB-1', fulfillmentId: 'F-1', eventType: 'shipment.created', status })
    repository.state.outbox.set('WB-2', { id: 'WB-2', fulfillmentId: 'F-2', eventType: 'shipment.created', status: 'succeeded' })
    const service = createOrderFulfillmentService({
      repository,
      warehouseService: { fulfill: async () => assert.fail('must not consume inventory again') },
      skuMappingService: {},
      writebackAdapter: { writeShipment: async () => assert.fail('must not send a platform request') }
    })

    const result = await service.ship({ orderId: 'ORDER-1', courier: 'Carrier', trackingNo: 'TRACK-1', operatorId: 9 })
    assert.equal(result.status, 'shipped')
    assert.equal(result.writebackStatus, status || 'unknown')
    assert.equal(repository.state.shipments.length, 0)
    assert.equal(repository.state.outbox.size, status ? 2 : 1)
  })
}

test('shipped retries propagate unavailable outbox state instead of claiming success', async () => {
  const service = createOrderFulfillmentService({
    repository: {
      findFulfillment: async () => ({ id: 'F-1', status: 'shipped' }),
      getWritebackStatus: async () => { throw new Error('outbox unavailable') }
    },
    warehouseService: {},
    skuMappingService: {}
  })
  await assert.rejects(() => service.ship({ orderId: 'ORDER-1', courier: 'Carrier', trackingNo: 'TRACK-1', operatorId: 9 }), /outbox unavailable/)
})
