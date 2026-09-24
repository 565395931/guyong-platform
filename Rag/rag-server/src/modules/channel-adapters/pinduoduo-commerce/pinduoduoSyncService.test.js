const test = require('node:test')
const assert = require('node:assert/strict')

let serviceModule = {}
try {
  serviceModule = require('./pinduoduoSyncService')
} catch {
  // RED phase: assertions below describe the module contract.
}

const ACCOUNT = Object.freeze({
  id: 7,
  credentials: Object.freeze({
    clientId: 'client-id',
    clientSecret: 'client-secret-sensitive',
    accessToken: 'access-token-sensitive',
    mallId: 'mall-7'
  })
})

function order(orderSn, updatedAt = '2026-07-25 12:00:00') {
  return { order_sn: orderSn, updated_at: updatedAt }
}

function refund(id, updatedTime = '2026-07-25 12:00:00') {
  return { id, order_sn: `P-${id}`, updated_time: updatedTime }
}

async function rejectedError(operation) {
  try {
    await operation()
    assert.fail('expected operation to reject')
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error
    return error
  }
}

function createHarness({ apiResponses = [], cursorAt = 1_000, nowSeconds = 2_800 } = {}) {
  const apiCalls = []
  const storedEvents = []
  const successCalls = []
  const failureCalls = []
  let responseIndex = 0
  const service = serviceModule.createPinduoduoSyncService({
    apiClient: async (type, params, credentials) => {
      apiCalls.push({ type, params, credentials })
      const next = apiResponses[responseIndex++]
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(type, params) : next
    },
    eventInbox: {
      store: async event => {
        storedEvents.push(event)
        return { stored: true, duplicate: false }
      }
    },
    syncState: {
      getOrCreate: async ({ channel, accountId, resource, initialCursorAt }) => ({
        channel, accountId, resource,
        cursorAt: cursorAt == null ? initialCursorAt : cursorAt
      }),
      markSuccess: async input => successCalls.push(input),
      markFailure: async input => failureCalls.push(input)
    },
    now: () => nowSeconds * 1000
  })
  return { service, apiCalls, storedEvents, successCalls, failureCalls }
}

test('uses the official APIs, a window no larger than 1800 seconds and 100-row pages', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const harness = createHarness({
    apiResponses: [
      { order_number_list_get_response: { order_sn_list: [order('P1')], total_count: 1 } },
      { refund_increment_get_response: { refund_list: [refund('R1')], total_count: 1 } }
    ]
  })

  const result = await harness.service.syncAccount(ACCOUNT)

  assert.equal(result.success, true)
  assert.deepEqual(harness.apiCalls.map(call => call.type), [
    'pdd.order.number.list.increment.get',
    'pdd.refund.list.increment.get'
  ])
  for (const call of harness.apiCalls) {
    assert.equal(call.params.end_updated_at - call.params.start_updated_at <= 1800, true)
    assert.equal(call.params.page_size, 100)
    assert.equal(call.params.page, 1)
    assert.equal(call.credentials, ACCOUNT.credentials)
  }
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['order', 'after_sales'])
  assert.equal(harness.successCalls.length, 2)
  assert.equal(harness.failureCalls.length, 0)
})

test('hydrates incremental order numbers through the official order detail API', async () => {
  const harness = createHarness({
    apiResponses: [
      { order_number_list_get_response: { order_sn_list: [{ order_sn: 'P-detail' }], total_count: 1 } },
      { order_info_get_response: { order_info: order('P-detail', '2026-07-25 12:10:00') } }
    ]
  })

  const result = await harness.service.syncResource({ account: ACCOUNT, resource: 'order' })

  assert.deepEqual(harness.apiCalls.map(call => call.type), [
    'pdd.order.number.list.increment.get',
    'pdd.order.information.get'
  ])
  assert.deepEqual(harness.apiCalls[1].params, { order_sn: 'P-detail' })
  assert.equal(harness.storedEvents[0].businessKey, 'P-detail')
  assert.equal(result.received, 1)
  assert.equal(harness.successCalls.length, 1)
})

test('retains the cursor when an order detail response is malformed', async () => {
  const harness = createHarness({
    apiResponses: [
      { order_number_list_get_response: { order_sn_list: [{ order_sn: 'P-detail' }], total_count: 1 } },
      { order_info_get_response: {} }
    ]
  })

  await assert.rejects(
    () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
    error => error.code === 'PINDUODUO_SYNC_FAILED'
  )
  assert.equal(harness.storedEvents.length, 0)
  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
})

test('starts a new account at now minus 30 minutes', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const getCalls = []
  const apiCalls = []
  const service = serviceModule.createPinduoduoSyncService({
    apiClient: async (type, params) => {
      apiCalls.push({ type, params })
      return type === 'pdd.order.number.list.increment.get'
        ? { order_number_list_get_response: { order_sn_list: [], total_count: 0 } }
        : { refund_increment_get_response: { refund_list: [], total_count: 0 } }
    },
    eventInbox: { store: async () => ({ stored: true, duplicate: false }) },
    syncState: {
      getOrCreate: async input => {
        getCalls.push(input)
        return { ...input, cursorAt: input.initialCursorAt }
      },
      markSuccess: async () => {},
      markFailure: async () => {}
    },
    now: () => 10_000 * 1000
  })

  await service.syncAccount(ACCOUNT)

  assert.deepEqual(getCalls.map(call => call.initialCursorAt), [8_200, 8_200])
  assert.deepEqual(apiCalls.map(call => call.params.start_updated_at), [8_200, 8_200])
  assert.deepEqual(apiCalls.map(call => call.params.end_updated_at), [10_000, 10_000])
})

test('fetches multiple pages and stores every normalized event before advancing', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const harness = createHarness({
    apiResponses: [
      {
        order_number_list_get_response: {
          order_sn_list: Array.from({ length: 100 }, (_, index) => order(`P${index}`)),
          total_count: 101
        }
      },
      { order_number_list_get_response: { order_sn_list: [order('P100')], total_count: 101 } }
    ]
  })

  const result = await harness.service.syncResource({ account: ACCOUNT, resource: 'order' })

  assert.deepEqual(harness.apiCalls.map(call => call.params.page), [1, 2])
  assert.equal(harness.storedEvents.length, 101)
  assert.equal(harness.successCalls.length, 1)
  assert.equal(harness.successCalls[0].cursorAt, 2_800)
  assert.equal(result.received, 101)
})

test('treats duplicate inbox writes as successful and still advances once', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  let stores = 0
  const successCalls = []
  const service = serviceModule.createPinduoduoSyncService({
    apiClient: async () => ({
      order_number_list_get_response: {
        order_sn_list: [order('P1'), order('P1')],
        total_count: 2
      }
    }),
    eventInbox: {
      store: async () => {
        stores += 1
        return stores === 1
          ? { stored: true, duplicate: false }
          : { stored: false, duplicate: true }
      }
    },
    syncState: {
      getOrCreate: async input => ({ ...input, cursorAt: 1_000 }),
      markSuccess: async input => successCalls.push(input),
      markFailure: async () => {}
    },
    now: () => 2_000 * 1000
  })

  const result = await service.syncResource({ account: ACCOUNT, resource: 'order' })

  assert.equal(result.received, 2)
  assert.equal(result.stored, 1)
  assert.equal(result.duplicates, 1)
  assert.equal(successCalls.length, 1)
})

test('rejects malformed official response shapes and does not advance the cursor', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  for (const malformed of [
    {},
    { order_number_list_get_response: { order_sn_list: {}, total_count: 0 } },
    { order_number_list_get_response: { order_sn_list: [], total_count: '0' } },
    { order_number_list_get_response: { order_sn_list: [], total_count: 1 } }
  ]) {
    const harness = createHarness({ apiResponses: [malformed] })
    await assert.rejects(
      () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
      error => error.code === 'PINDUODUO_SYNC_FAILED'
    )
    assert.equal(harness.successCalls.length, 0)
    assert.equal(harness.failureCalls.length, 1)
  }
})

test('bounds pagination at 100 pages and fails closed when results remain', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const page = {
    order_number_list_get_response: {
      order_sn_list: Array.from({ length: 100 }, (_, index) => order(`P${index}`)),
      total_count: 10_001
    }
  }
  const harness = createHarness({ apiResponses: Array.from({ length: 100 }, () => page) })

  await assert.rejects(
    () => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }),
    error => error.code === 'PINDUODUO_SYNC_FAILED'
  )

  assert.equal(harness.apiCalls.length, 100)
  assert.equal(harness.storedEvents.length, 0, 'pages must be complete before any event is stored')
  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
})

test('marks API, normalization and inbox failures without advancing the cursor', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const cases = [
    {
      apiResponses: [Object.assign(new Error('secret-bearing upstream detail'), { code: 'PINDUODUO_API_ERROR' })]
    },
    {
      apiResponses: [{ order_number_list_get_response: { order_sn_list: [{}], total_count: 1 } }]
    }
  ]

  for (const setup of cases) {
    const harness = createHarness(setup)
    await assert.rejects(() => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }))
    assert.equal(harness.successCalls.length, 0)
    assert.equal(harness.failureCalls.length, 1)
    assert.equal(
      JSON.stringify(harness.failureCalls).includes('secret-bearing upstream detail'),
      false
    )
  }

  const harness = createHarness({
    apiResponses: [{ order_number_list_get_response: { order_sn_list: [order('P1')], total_count: 1 } }]
  })
  harness.service = serviceModule.createPinduoduoSyncService({
    apiClient: async () => harness.apiCalls.length === 0
      ? (harness.apiCalls.push(true), { order_number_list_get_response: { order_sn_list: [order('P1')], total_count: 1 } })
      : null,
    eventInbox: { store: async () => { throw Object.assign(new Error('database detail'), { code: 'ER_WRITE' }) } },
    syncState: {
      getOrCreate: async input => ({ ...input, cursorAt: 1_000 }),
      markSuccess: async input => harness.successCalls.push(input),
      markFailure: async input => harness.failureCalls.push(input)
    },
    now: () => 2_000 * 1000
  })
  await assert.rejects(() => harness.service.syncResource({ account: ACCOUNT, resource: 'order' }))
  assert.equal(harness.successCalls.length, 0)
  assert.equal(harness.failureCalls.length, 1)
})

test('continues the second resource after the first fails, then rejects the account safely', async () => {
  assert.equal(typeof serviceModule.createPinduoduoSyncService, 'function')
  const harness = createHarness({
    apiResponses: [
      Object.assign(new Error('token-sensitive upstream detail'), { code: 'PINDUODUO_API_ERROR' }),
      { refund_increment_get_response: { refund_list: [refund('R1')], total_count: 1 } }
    ]
  })

  const error = await rejectedError(() => harness.service.syncAccount(ACCOUNT))

  assert.equal(error.code, 'PINDUODUO_ACCOUNT_SYNC_FAILED')
  assert.equal(error.message.includes('token-sensitive upstream detail'), false)
  assert.equal(harness.failureCalls.length, 1)
  assert.equal(harness.successCalls.length, 1)
  assert.deepEqual(harness.storedEvents.map(event => event.category), ['after_sales'])
})
