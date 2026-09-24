const test = require('node:test')
const assert = require('node:assert/strict')

let serviceModule = {}
try {
  serviceModule = require('./alibaba1688SyncService')
} catch {
  // RED phase: assertions below define the sync contract.
}

const ACCOUNT = Object.freeze({
  id: 18,
  credentials: Object.freeze({
    appKey: 'app-key',
    appSecret: 'app-secret-sensitive',
    accessToken: 'access-token-sensitive',
    sellerMemberId: 'seller-member-id'
  })
})

function order(id, modifyTime = '20260725121000000+0800') {
  return {
    baseInfo: { idOfStr: id, modifyTime, buyerOpenUid: `buyer-${id}` },
    productItems: []
  }
}

function refund(id, gmtModified = '20260725121200000+0800') {
  return { refundId: id, orderId: `O-${id}`, gmtModified, buyerOpenUid: `buyer-${id}` }
}

function orderResponse(records, totalRecord = records.length) {
  return { success: true, result: records, totalRecord, retCodes: [] }
}

function refundResponse(records, currentPageNum = 0, totalCount = records.length) {
  return {
    success: true,
    result: { opOrderRefundModels: records, totalCount, currentPageNum }
  }
}

function createHarness({
  responder,
  eventStore,
  cursorAt = Math.floor(Date.parse('2026-07-25T04:00:00.000Z') / 1000),
  nowMs = Date.parse('2026-07-25T04:30:00.000Z')
} = {}) {
  const apiCalls = []
  const storedEvents = []
  const successCalls = []
  const failureCalls = []
  const service = serviceModule.createAlibaba1688SyncService({
    apiClient: async (apiName, params, credentials) => {
      apiCalls.push({ apiName, params, credentials })
      return responder(apiName, params, apiCalls.length)
    },
    eventInbox: {
      store: async event => {
        storedEvents.push(event)
        return eventStore ? eventStore(event, storedEvents.length) : { stored: true, duplicate: false }
      }
    },
    syncState: {
      getOrCreate: async input => ({ ...input, cursorAt: cursorAt == null ? input.initialCursorAt : cursorAt }),
      markSuccess: async input => successCalls.push(input),
      markFailure: async input => failureCalls.push(input)
    },
    now: () => nowMs
  })
  return { service, apiCalls, storedEvents, successCalls, failureCalls }
}

test('uses official APIs, a 30-minute window and privacy-safe order parameters', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const harness = createHarness({
    responder(apiName, params) {
      return apiName === serviceModule.ORDER_LIST_API
        ? orderResponse([order('O-1')])
        : refundResponse([refund('R-1')], params.currentPageNum)
    }
  })

  const result = await harness.service.syncAccount(ACCOUNT)

  assert.equal(result.success, true)
  assert.deepEqual(harness.apiCalls.map(call => call.apiName), [
    serviceModule.ORDER_LIST_API,
    serviceModule.REFUND_LIST_API
  ])
  for (const call of harness.apiCalls) {
    assert.equal(call.params.modifyStartTime, '20260725120000000+0800')
    assert.equal(call.params.modifyEndTime, '20260725123000000+0800')
    assert.equal(call.params.pageSize, 20)
    assert.equal(call.params.sellerMemberId, ACCOUNT.credentials.sellerMemberId)
    assert.equal(call.credentials, ACCOUNT.credentials)
  }
  assert.equal(harness.apiCalls[0].params.page, 1)
  assert.equal(harness.apiCalls[0].params.needBuyerAddressAndPhone, false)
  assert.equal(harness.apiCalls[0].params.needMemoInfo, false)
  assert.equal(harness.apiCalls[0].params.isHis, false)
  assert.equal(harness.apiCalls[1].params.currentPageNum, 0)
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['order', 'after_sales'])
  assert.equal(harness.successCalls.length, 2)
})

test('starts new order and refund cursors at now minus 30 minutes', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const getCalls = []
  const nowMs = Date.parse('2026-07-25T04:30:00.000Z')
  const service = serviceModule.createAlibaba1688SyncService({
    apiClient: async (apiName, params) => apiName === serviceModule.ORDER_LIST_API
      ? orderResponse([])
      : refundResponse([], params.currentPageNum),
    eventInbox: { store: async () => ({ stored: true }) },
    syncState: {
      getOrCreate: async input => { getCalls.push(input); return { ...input, cursorAt: input.initialCursorAt } },
      markSuccess: async () => {},
      markFailure: async () => {}
    },
    now: () => nowMs
  })

  await service.syncAccount(ACCOUNT)
  const initial = Math.floor(nowMs / 1000) - 1800
  assert.deepEqual(getCalls.map(call => [call.resource, call.initialCursorAt]), [
    ['order', initial],
    ['after_sales', initial]
  ])
})

test('buffers all order pages from page 1 before writing', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const harness = createHarness({
    responder(apiName, params) {
      assert.equal(apiName, serviceModule.ORDER_LIST_API)
      if (params.page === 1) {
        return orderResponse(Array.from({ length: 20 }, (_, index) => order(`O-${index + 1}`)), 21)
      }
      return orderResponse([order('O-21')], 21)
    }
  })

  const result = await harness.service.syncResource({ account: ACCOUNT, resource: 'order' })

  assert.deepEqual(harness.apiCalls.map(call => call.params.page), [1, 2])
  assert.equal(harness.storedEvents.length, 21)
  assert.equal(result.received, 21)
  assert.equal(harness.successCalls.length, 1)
})

test('uses zero-based refund pages and validates the echoed page number', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const harness = createHarness({
    responder(apiName, params) {
      assert.equal(apiName, serviceModule.REFUND_LIST_API)
      if (params.currentPageNum === 0) {
        return refundResponse(Array.from({ length: 20 }, (_, index) => refund(`R-${index + 1}`)), 0, 21)
      }
      return refundResponse([refund('R-21')], 1, 21)
    }
  })

  await harness.service.syncResource({ account: ACCOUNT, resource: 'after_sales' })
  assert.deepEqual(harness.apiCalls.map(call => call.params.currentPageNum), [0, 1])
  assert.equal(harness.storedEvents.length, 21)

  const invalid = createHarness({
    responder: () => refundResponse([refund('R-1')], 9, 1)
  })
  await assert.rejects(() => invalid.service.syncResource({ account: ACCOUNT, resource: 'after_sales' }))
  assert.equal(invalid.storedEvents.length, 0)
  assert.equal(invalid.successCalls.length, 0)
  assert.equal(invalid.failureCalls.length, 1)
})

test('rejects page-limit and total inconsistencies before storing', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const tooMany = createHarness({ responder: () => orderResponse([], 2001) })
  await assert.rejects(() => tooMany.service.syncResource({ account: ACCOUNT, resource: 'order' }))
  assert.equal(tooMany.apiCalls.length, 1)
  assert.equal(tooMany.storedEvents.length, 0)

  const changed = createHarness({
    responder(apiName, params) {
      if (params.page === 1) {
        return orderResponse(Array.from({ length: 20 }, (_, index) => order(`O-${index + 1}`)), 21)
      }
      return orderResponse([order('O-21')], 20)
    }
  })
  await assert.rejects(() => changed.service.syncResource({ account: ACCOUNT, resource: 'order' }))
  assert.equal(changed.storedEvents.length, 0)
  assert.equal(changed.successCalls.length, 0)
})

test('treats duplicates as success but retains the cursor on an inbox failure', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  let writes = 0
  const duplicate = createHarness({
    responder: () => orderResponse([order('O-1'), order('O-1')], 2),
    eventStore: () => (++writes === 1 ? { stored: true } : { duplicate: true })
  })
  const result = await duplicate.service.syncResource({ account: ACCOUNT, resource: 'order' })
  assert.deepEqual({ stored: result.stored, duplicates: result.duplicates }, { stored: 1, duplicates: 1 })
  assert.equal(duplicate.successCalls.length, 1)

  const failed = createHarness({
    responder: () => orderResponse([order('O-1')]),
    eventStore() {
      throw Object.assign(new Error('database sensitive detail'), { code: 'INBOX_STORE_FAILED' })
    }
  })
  const error = await failed.service.syncResource({ account: ACCOUNT, resource: 'order' }).catch(value => value)
  assert.equal(error.code, 'ALIBABA1688_SYNC_FAILED')
  assert.equal(error.message.includes('sensitive'), false)
  assert.equal(failed.successCalls.length, 0)
  assert.deepEqual(failed.failureCalls.map(call => call.errorCode), ['INBOX_STORE_FAILED'])
})

test('continues with refunds after an order failure and reports a safe account failure', async () => {
  assert.equal(typeof serviceModule.createAlibaba1688SyncService, 'function')
  const harness = createHarness({
    responder(apiName, params) {
      if (apiName === serviceModule.ORDER_LIST_API) {
        throw Object.assign(new Error('upstream token-sensitive detail'), { code: 'ALIBABA1688_API_ERROR' })
      }
      return refundResponse([refund('R-1')], params.currentPageNum)
    }
  })

  const error = await harness.service.syncAccount(ACCOUNT).catch(value => value)
  assert.equal(error.code, 'ALIBABA1688_ACCOUNT_SYNC_FAILED')
  assert.equal(error.message.includes('sensitive'), false)
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['after_sales'])
  assert.deepEqual(harness.successCalls.map(call => call.resource), ['after_sales'])
  assert.deepEqual(harness.failureCalls.map(call => call.resource), ['order'])
})
