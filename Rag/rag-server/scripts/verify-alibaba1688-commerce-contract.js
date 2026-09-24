const assert = require('node:assert/strict')
const dotenv = require('dotenv')

dotenv.config()

const { sequelize } = require('../src/config/database')
const ChannelAccount = require('../src/models/ChannelAccount')
const { createChannelEventInboxRepository } = require('../src/modules/channel-events/channelEventInbox.repository')
const { ensureChannelEventInboxSchema } = require('../src/modules/channel-events/channelEventInbox.schema')
const { createChannelSyncStateRepository } = require('../src/modules/channel-sync/channelSyncState.repository')
const { ensureChannelSyncStateSchema } = require('../src/modules/channel-sync/channelSyncState.schema')
const {
  ORDER_LIST_API,
  REFUND_LIST_API,
  createAlibaba1688SyncService
} = require('../src/modules/channel-adapters/alibaba1688-commerce/alibaba1688SyncService')

const FIXED_NOW_MS = Date.parse('2026-07-25T04:30:00.000Z')
const INITIAL_CURSOR = Math.floor(FIXED_NOW_MS / 1000) - 30 * 60
const CREDENTIALS = Object.freeze({
  appKey: 'contract-app-key',
  appSecret: 'contract-app-secret',
  accessToken: 'contract-access-token',
  sellerMemberId: 'contract-seller-member'
})

function order(id, modifyTime = '20260725121000000+0800') {
  return {
    baseInfo: {
      idOfStr: String(id),
      modifyTime,
      buyerOpenUid: `buyer-${id}`,
      status: 'waitbuyerpay',
      buyerLoginId: 'must-not-be-persisted',
      buyerMemo: 'must-not-be-persisted'
    },
    receiverInfo: {
      receiverName: 'must-not-be-persisted',
      mobile: '13800000000',
      fullAddress: 'must-not-be-persisted'
    },
    productItems: [{ productID: `P-${id}`, quantity: 1, price: 99 }]
  }
}

function refund(refundId, modified = '20260725121200000+0800') {
  return {
    refundId: String(refundId),
    orderId: `O-${refundId}`,
    gmtModified: modified,
    buyerOpenUid: `buyer-${refundId}`,
    refundPayment: 12.5,
    reason: 'contract verification',
    contactPhone: '13800000000'
  }
}

function orderResponse(records, totalRecord = records.length) {
  return { success: true, result: records, totalRecord, retCodes: [] }
}

function refundResponse(records, page = 0, totalCount = records.length) {
  return {
    success: true,
    result: { opOrderRefundModels: records, currentPageNum: page, totalCount }
  }
}

function createOrderClient(records, pageCalls) {
  return async (apiName, params) => {
    assert.equal(apiName, ORDER_LIST_API)
    assert.equal(params.needBuyerAddressAndPhone, false)
    assert.equal(params.needMemoInfo, false)
    assert.equal(params.isHis, false)
    pageCalls.push(params.page)
    const start = (params.page - 1) * 20
    return orderResponse(records.slice(start, start + 20), records.length)
  }
}

function createRefundClient(record) {
  return async (apiName, params) => {
    assert.equal(apiName, REFUND_LIST_API)
    return refundResponse([record], params.currentPageNum)
  }
}

async function countEvents(accountId, category = null) {
  const categoryClause = category ? ' AND category = :category' : ''
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM channel_event_inbox
      WHERE channel = 'alibaba1688'
        AND account_id = :accountId${categoryClause}`,
    { replacements: { accountId, category } }
  )
  return Number(rows[0]?.total || 0)
}

async function loadState(accountId, resource) {
  const [rows] = await sequelize.query(
    `SELECT UNIX_TIMESTAMP(cursor_at) AS cursor_at,
            failure_count,
            last_error_code
       FROM channel_sync_state
      WHERE channel = 'alibaba1688'
        AND account_id = :accountId
        AND resource = :resource
      LIMIT 1`,
    { replacements: { accountId, resource } }
  )
  assert.ok(rows[0], `missing ${resource} sync state`)
  return {
    cursorAt: Number(rows[0].cursor_at),
    failureCount: Number(rows[0].failure_count),
    lastErrorCode: rows[0].last_error_code
  }
}

async function resetCursor(accountId, resource) {
  await sequelize.query(
    `UPDATE channel_sync_state
        SET cursor_at = FROM_UNIXTIME(:cursorAt),
            failure_count = 0,
            last_error_code = NULL
      WHERE channel = 'alibaba1688'
        AND account_id = :accountId
        AND resource = :resource`,
    { replacements: { accountId, resource, cursorAt: INITIAL_CURSOR } }
  )
}

async function assertSanitizedPayload(accountId) {
  const [rows] = await sequelize.query(
    `SELECT payload_json
       FROM channel_event_inbox
      WHERE channel = 'alibaba1688'
        AND account_id = :accountId
        AND category = 'order'
      ORDER BY id ASC
      LIMIT 1`,
    { replacements: { accountId } }
  )
  const serialized = JSON.stringify(rows[0]?.payload_json || {})
  assert.equal(serialized.includes('buyerOpenUid'), true)
  assert.equal(serialized.includes('must-not-be-persisted'), false)
  assert.equal(serialized.includes('13800000000'), false)
}

async function main() {
  const marker = `alibaba1688-contract-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const accountIds = []
  const inbox = createChannelEventInboxRepository(sequelize)
  const syncState = createChannelSyncStateRepository(sequelize)

  const makeService = apiClient => createAlibaba1688SyncService({
    apiClient,
    eventInbox: inbox,
    syncState,
    now: () => FIXED_NOW_MS
  })

  try {
    await sequelize.authenticate()
    await ensureChannelEventInboxSchema(sequelize)
    await ensureChannelSyncStateSchema(sequelize)

    for (const suffix of ['a', 'b']) {
      const account = await ChannelAccount.create({
        channel: 'alibaba1688',
        account_name: `${marker}-${suffix}`,
        config: JSON.stringify({ contractMarker: marker }),
        status: 'inactive',
        adapter_type: 'alibaba1688_commerce',
        max_daily_quota: 1000
      })
      accountIds.push(Number(account.id))
    }

    const [primaryAccountId, isolatedAccountId] = accountIds
    const primary = { id: primaryAccountId, credentials: CREDENTIALS }
    const isolated = { id: isolatedAccountId, credentials: CREDENTIALS }
    const orders = Array.from({ length: 41 }, (_, index) =>
      order(`9007199254740993${String(index + 1).padStart(3, '0')}`)
    )

    const firstPageCalls = []
    const first = await makeService(createOrderClient(orders, firstPageCalls))
      .syncResource({ account: primary, resource: 'order' })
    assert.deepEqual(firstPageCalls, [1, 2, 3])
    assert.deepEqual({ received: first.received, stored: first.stored, duplicates: first.duplicates }, {
      received: 41,
      stored: 41,
      duplicates: 0
    })
    assert.equal(await countEvents(primaryAccountId, 'order'), 41)
    assert.equal((await loadState(primaryAccountId, 'order')).cursorAt, Math.floor(FIXED_NOW_MS / 1000))
    await assertSanitizedPayload(primaryAccountId)

    await resetCursor(primaryAccountId, 'order')
    const duplicatePageCalls = []
    const duplicate = await makeService(createOrderClient(orders, duplicatePageCalls))
      .syncResource({ account: primary, resource: 'order' })
    assert.deepEqual(duplicatePageCalls, [1, 2, 3])
    assert.deepEqual({ stored: duplicate.stored, duplicates: duplicate.duplicates }, {
      stored: 0,
      duplicates: 41
    })
    assert.equal(await countEvents(primaryAccountId, 'order'), 41)

    const refundResult = await makeService(createRefundClient(refund('R-9007199254740993123')))
      .syncResource({ account: primary, resource: 'after_sales' })
    assert.deepEqual({ received: refundResult.received, stored: refundResult.stored }, { received: 1, stored: 1 })
    assert.equal(await countEvents(primaryAccountId, 'after_sales'), 1)

    await resetCursor(primaryAccountId, 'order')
    const malformedService = makeService(async () => ({
      success: true,
      result: [],
      totalRecord: 'invalid',
      retCodes: []
    }))
    await assert.rejects(
      () => malformedService.syncResource({ account: primary, resource: 'order' }),
      error => error.code === 'ALIBABA1688_SYNC_FAILED'
    )
    const malformedState = await loadState(primaryAccountId, 'order')
    assert.equal(malformedState.cursorAt, INITIAL_CURSOR)
    assert.equal(malformedState.failureCount, 1)
    assert.equal(malformedState.lastErrorCode, 'ALIBABA1688_SYNC_RESPONSE_INVALID')

    const apiFailureService = makeService(async () => {
      throw Object.assign(new Error('upstream detail must stay private'), { code: 'ALIBABA1688_API_ERROR' })
    })
    await assert.rejects(
      () => apiFailureService.syncResource({ account: primary, resource: 'order' }),
      error => error.code === 'ALIBABA1688_SYNC_FAILED' && !error.message.includes('private')
    )
    const apiFailureState = await loadState(primaryAccountId, 'order')
    assert.equal(apiFailureState.cursorAt, INITIAL_CURSOR)
    assert.equal(apiFailureState.failureCount, 2)
    assert.equal(apiFailureState.lastErrorCode, 'ALIBABA1688_API_ERROR')

    const isolationCalls = []
    const isolatedResult = await makeService(createOrderClient([orders[0]], isolationCalls))
      .syncResource({ account: isolated, resource: 'order' })
    assert.deepEqual(isolationCalls, [1])
    assert.equal(isolatedResult.stored, 1)
    assert.equal(await countEvents(isolatedAccountId, 'order'), 1)
    assert.equal(await countEvents(primaryAccountId), 42)

    console.log(JSON.stringify({
      success: true,
      pageOrder: firstPageCalls,
      primaryEvents: 42,
      isolatedEvents: 1,
      duplicateEvents: duplicate.duplicates,
      privacySanitized: true,
      cursorRetainedAfterFailures: apiFailureState.cursorAt === INITIAL_CURSOR
    }))
  } finally {
    for (const accountId of accountIds) {
      await sequelize.query(
        `DELETE FROM channel_event_inbox WHERE channel = 'alibaba1688' AND account_id = :accountId`,
        { replacements: { accountId } }
      ).catch(() => {})
      await sequelize.query(
        `DELETE FROM channel_sync_state WHERE channel = 'alibaba1688' AND account_id = :accountId`,
        { replacements: { accountId } }
      ).catch(() => {})
      await sequelize.query(
        `DELETE FROM channel_accounts WHERE id = :accountId AND account_name LIKE :marker`,
        { replacements: { accountId, marker: `${marker}%` } }
      ).catch(() => {})
    }
    await sequelize.close().catch(() => {})
  }
}

main().catch(error => {
  console.error(JSON.stringify({ success: false, code: error.code || error.name || 'CONTRACT_FAILED' }))
  process.exitCode = 1
})
