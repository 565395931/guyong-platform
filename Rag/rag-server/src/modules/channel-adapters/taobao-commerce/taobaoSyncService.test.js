const test = require('node:test')
const assert = require('node:assert/strict')

let serviceModule = {}
try {
  serviceModule = require('./taobaoSyncService')
} catch {
  // RED phase: assertions below define the sync contract.
}

const ACCOUNT = Object.freeze({
  id: 11,
  credentials: Object.freeze({
    appKey: 'app-key',
    appSecret: 'app-secret-sensitive',
    sessionKey: 'session-key-sensitive',
    sellerNick: 'seller-a'
  })
})

function order(tid, modified = '2026-07-25 12:10:00') {
  return { tid, modified, buyer_open_uid: `buyer-${tid}`, ouid: `ouid-${tid}` }
}

function refund(refundId, modified = '2026-07-25 12:12:00') {
  return { refund_id: refundId, tid: `T-${refundId}`, modified, refund_fee: '12.50' }
}

function orderResponse(records, totalResults = records.length) {
  return {
    trades_simple_sold_increment_get_response: {
      total_results: totalResults,
      trades: { trade: records }
    }
  }
}

function refundResponse(records, totalResults = records.length) {
  return {
    refunds_receive_get_response: {
      total_results: totalResults,
      refunds: { refund: records }
    }
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
  const service = serviceModule.createTaobaoSyncService({
    apiClient: async (method, params, credentials) => {
      apiCalls.push({ method, params, credentials })
      return responder(method, params, apiCalls.length)
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

test('uses approved fields, a 30-minute China-time window and official methods', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  const harness = createHarness({
    responder(method) {
      return method === 'taobao.trades.simple.sold.increment.get'
        ? orderResponse([order('T1')])
        : refundResponse([refund('R1')])
    }
  })

  const result = await harness.service.syncAccount(ACCOUNT)

  assert.equal(result.success, true)
  assert.deepEqual(harness.apiCalls.map(call => call.method), [
    'taobao.trades.simple.sold.increment.get',
    'taobao.trades.simple.sold.increment.get',
    'taobao.refunds.receive.get',
    'taobao.refunds.receive.get'
  ])
  for (const call of harness.apiCalls) {
    assert.equal(call.params.start_modified, '2026-07-25 12:00:00')
    assert.equal(call.params.end_modified, '2026-07-25 12:30:00')
    assert.equal(call.params.page_size, 100)
    assert.equal(call.params.use_has_next, false)
    assert.equal(call.credentials, ACCOUNT.credentials)
    assert.equal(call.params.fields.includes('modified'), true)
    assert.equal(call.params.fields.includes('buyer_nick'), false)
    assert.equal(call.params.fields.includes('receiver_phone'), false)
    assert.equal(call.params.fields.includes('receiver_address'), false)
  }
  assert.equal(harness.apiCalls[0].params.fields.includes('buyer_open_uid'), true)
  assert.equal(harness.apiCalls[0].params.fields.includes('ouid'), true)
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['order', 'after_sales'])
  assert.equal(harness.successCalls.length, 2)
})

test('discovers total pages then fetches order pages from last to first', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  const harness = createHarness({
    responder(method, params, callNumber) {
      assert.equal(method, 'taobao.trades.simple.sold.increment.get')
      if (callNumber === 1) return orderResponse([order('discovery')], 201)
      if (params.page_no === 3) return orderResponse([order('T201')], 201)
      if (params.page_no === 2) return orderResponse(Array.from({ length: 100 }, (_, index) => order(`T${101 + index}`)), 201)
      return orderResponse(Array.from({ length: 100 }, (_, index) => order(`T${1 + index}`)), 201)
    }
  })

  const result = await harness.service.syncResource({ account: ACCOUNT, resource: 'order' })

  assert.deepEqual(harness.apiCalls.map(call => call.params.page_no), [1, 3, 2, 1])
  assert.equal(harness.storedEvents.length, 201)
  assert.equal(harness.storedEvents[0].businessKey, 'T201')
  assert.equal(harness.storedEvents.at(-1).businessKey, 'T100')
  assert.equal(result.received, 201)
  assert.equal(harness.successCalls.length, 1)
})

test('starts a new account at now minus 30 minutes', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  const getCalls = []
  const apiCalls = []
  const nowMs = Date.parse('2026-07-25T04:30:00.000Z')
  const service = serviceModule.createTaobaoSyncService({
    apiClient: async (method, params) => {
      apiCalls.push({ method, params })
      return method === 'taobao.trades.simple.sold.increment.get'
        ? orderResponse([])
        : refundResponse([])
    },
    eventInbox: { store: async () => ({ stored: true, duplicate: false }) },
    syncState: {
      getOrCreate: async input => { getCalls.push(input); return { ...input, cursorAt: input.initialCursorAt } },
      markSuccess: async () => {},
      markFailure: async () => {}
    },
    now: () => nowMs
  })

  await service.syncAccount(ACCOUNT)

  const initial = Math.floor(nowMs / 1000) - 1800
  assert.deepEqual(getCalls.map(call => call.initialCursorAt), [initial, initial])
  assert.deepEqual(apiCalls.map(call => call.params.start_modified), Array(2).fill('2026-07-25 12:00:00'))
})

test('fails before storing when more than 100 pages are reported', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  const harness = createHarness({ responder: () => orderResponse([], 10_001) })

  await assert.rejects(
    () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
    error => error.code === 'TAOBAO_SYNC_FAILED'
  )

  assert.equal(harness.apiCalls.length, 1)
  assert.equal(harness.storedEvents.length, 0)
  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
})

test('rejects malformed pages and retains the cursor', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  for (const malformed of [
    {},
    { trades_simple_sold_increment_get_response: { total_results: '1', trades: { trade: [] } } },
    { trades_simple_sold_increment_get_response: { total_results: 1, trades: { trade: {} } } },
    orderResponse([], 1)
  ]) {
    const harness = createHarness({ responder: () => malformed })
    await assert.rejects(() => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }))
    assert.equal(harness.successCalls.length, 0)
    assert.equal(harness.failureCalls.length, 1)
  }
})

test('treats duplicates as success and never leaks upstream error text', async () => {
  assert.equal(typeof serviceModule.createTaobaoSyncService, 'function')
  let stores = 0
  const successCalls = []
  const failureCalls = []
  const service = serviceModule.createTaobaoSyncService({
    apiClient: async () => orderResponse([order('T1'), order('T1')], 2),
    eventInbox: { store: async () => (++stores === 1 ? { stored: true } : { duplicate: true }) },
    syncState: {
      getOrCreate: async input => ({
        ...input,
        cursorAt: Math.floor(Date.parse('2026-07-25T04:00:00.000Z') / 1000)
      }),
      markSuccess: async input => successCalls.push(input),
      markFailure: async input => failureCalls.push(input)
    },
    now: () => Date.parse('2026-07-25T04:30:00.000Z')
  })

  const result = await service.syncResource({ account: ACCOUNT, resource: 'order' })
  assert.deepEqual({ stored: result.stored, duplicates: result.duplicates }, { stored: 1, duplicates: 1 })
  assert.equal(successCalls.length, 1)

  const failing = createHarness({
    responder() {
      throw Object.assign(new Error('app-secret-sensitive session-key-sensitive'), { code: 'TAOBAO_API_ERROR' })
    }
  })
  const error = await failing.service.syncResource({ account: ACCOUNT, resource: 'order' }).catch(value => value)
  assert.equal(error.code, 'TAOBAO_SYNC_FAILED')
  assert.equal(error.message.includes('sensitive'), false)
  assert.equal(JSON.stringify(failing.failureCalls).includes('sensitive'), false)
})

test('retains the cursor when an inbox write fails', async () => {
  const harness = createHarness({
    responder: () => orderResponse([order('T1')]),
    eventStore() {
      throw Object.assign(new Error('database write failed'), { code: 'INBOX_STORE_FAILED' })
    }
  })

  await assert.rejects(
    () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
    error => error.code === 'TAOBAO_SYNC_FAILED'
  )

  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
  assert.equal(harness.failureCalls[0].errorCode, 'INBOX_STORE_FAILED')
})

test('continues with refunds after an order failure and reports a safe account failure', async () => {
  const harness = createHarness({
    responder(method) {
      if (method === 'taobao.trades.simple.sold.increment.get') {
        throw Object.assign(new Error('order upstream sensitive detail'), { code: 'TAOBAO_API_ERROR' })
      }
      return refundResponse([refund('R1')])
    }
  })

  const error = await harness.service.syncAccount(ACCOUNT).catch(value => value)

  assert.equal(error.code, 'TAOBAO_ACCOUNT_SYNC_FAILED')
  assert.equal(error.message.includes('sensitive'), false)
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['after_sales'])
  assert.deepEqual(harness.successCalls.map(call => call.resource), ['after_sales'])
  assert.deepEqual(harness.failureCalls.map(call => call.resource), ['order'])
})

test('fails closed without storing when total_results changes during reverse pagination', async () => {
  const harness = createHarness({
    responder(method, params, callNumber) {
      assert.equal(method, 'taobao.trades.simple.sold.increment.get')
      if (callNumber === 1) return orderResponse([order('discovery')], 101)
      if (params.page_no === 2) return orderResponse([order('T101')], 101)
      return orderResponse(Array.from({ length: 100 }, (_, index) => order(`T${index + 1}`)), 100)
    }
  })

  await assert.rejects(
    () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
    error => error.code === 'TAOBAO_SYNC_FAILED'
  )

  assert.equal(harness.storedEvents.length, 0)
  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
})
