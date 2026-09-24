const assert = require('node:assert/strict')
const dotenv = require('dotenv')

dotenv.config()

const { sequelize } = require('../src/config/database')
const ChannelAccount = require('../src/models/ChannelAccount')
const { createChannelEventInboxRepository } = require('../src/modules/channel-events/channelEventInbox.repository')
const { ensureChannelEventInboxSchema } = require('../src/modules/channel-events/channelEventInbox.schema')
const { createChannelSyncStateRepository } = require('../src/modules/channel-sync/channelSyncState.repository')
const { ensureChannelSyncStateSchema } = require('../src/modules/channel-sync/channelSyncState.schema')
const { createTaobaoSyncService } = require('../src/modules/channel-adapters/taobao-commerce/taobaoSyncService')

const FIXED_NOW_MS = Date.parse('2026-07-25T04:30:00.000Z')
const INITIAL_CURSOR = Math.floor(FIXED_NOW_MS / 1000) - 30 * 60
const CREDENTIALS = Object.freeze({
  appKey: 'contract-app-key',
  appSecret: 'contract-app-secret',
  sessionKey: 'contract-session-key',
  sellerNick: 'contract-seller'
})

function order(tid, modified = '2026-07-25 12:10:00') {
  return {
    tid: String(tid),
    modified,
    status: 'WAIT_BUYER_CONFIRM_GOODS',
    payment: '99.00',
    buyer_open_uid: `buyer-${tid}`,
    ouid: `ouid-${tid}`
  }
}

function refund(refundId, modified = '2026-07-25 12:12:00') {
  return {
    refund_id: String(refundId),
    tid: `T-${refundId}`,
    modified,
    status: 'WAIT_SELLER_AGREE',
    refund_fee: '12.50',
    reason: 'contract verification'
  }
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

function createReverseOrderClient(records, pageCalls) {
  let discoveryPending = true
  return async (method, params) => {
    assert.equal(method, 'taobao.trades.simple.sold.increment.get')
    pageCalls.push(params.page_no)
    if (discoveryPending) {
      discoveryPending = false
      return orderResponse(records.slice(0, 100), records.length)
    }
    const start = (params.page_no - 1) * 100
    return orderResponse(records.slice(start, start + 100), records.length)
  }
}

function createSingleRefundClient(record) {
  return async method => {
    assert.equal(method, 'taobao.refunds.receive.get')
    return refundResponse([record])
  }
}

async function countEvents(accountId, category = null) {
  const categoryClause = category ? ' AND category = :category' : ''
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM channel_event_inbox
      WHERE channel = 'taobao'
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
      WHERE channel = 'taobao'
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
      WHERE channel = 'taobao'
        AND account_id = :accountId
        AND resource = :resource`,
    { replacements: { accountId, resource, cursorAt: INITIAL_CURSOR } }
  )
}

async function main() {
  const marker = `taobao-contract-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const accountIds = []
  const inbox = createChannelEventInboxRepository(sequelize)
  const syncState = createChannelSyncStateRepository(sequelize)

  const makeService = apiClient => createTaobaoSyncService({
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
        channel: 'taobao',
        account_name: `${marker}-${suffix}`,
        config: JSON.stringify({ contractMarker: marker }),
        status: 'inactive',
        adapter_type: 'taobao_commerce',
        max_daily_quota: 1000
      })
      accountIds.push(Number(account.id))
    }

    const [primaryAccountId, isolatedAccountId] = accountIds
    const primary = { id: primaryAccountId, credentials: CREDENTIALS }
    const isolated = { id: isolatedAccountId, credentials: CREDENTIALS }
    const orders = Array.from({ length: 201 }, (_, index) =>
      order(`9007199254740993${String(index + 1).padStart(3, '0')}`)
    )

    const firstPageCalls = []
    const first = await makeService(createReverseOrderClient(orders, firstPageCalls))
      .syncResource({ account: primary, resource: 'order' })
    assert.deepEqual(firstPageCalls, [1, 3, 2, 1])
    assert.deepEqual({ received: first.received, stored: first.stored, duplicates: first.duplicates }, {
      received: 201,
      stored: 201,
      duplicates: 0
    })
    assert.equal(await countEvents(primaryAccountId, 'order'), 201)
    assert.equal((await loadState(primaryAccountId, 'order')).cursorAt, Math.floor(FIXED_NOW_MS / 1000))

    await resetCursor(primaryAccountId, 'order')
    const duplicatePageCalls = []
    const duplicate = await makeService(createReverseOrderClient(orders, duplicatePageCalls))
      .syncResource({ account: primary, resource: 'order' })
    assert.deepEqual(duplicatePageCalls, [1, 3, 2, 1])
    assert.deepEqual({ stored: duplicate.stored, duplicates: duplicate.duplicates }, {
      stored: 0,
      duplicates: 201
    })
    assert.equal(await countEvents(primaryAccountId, 'order'), 201)

    const refundResult = await makeService(createSingleRefundClient(refund('R-9007199254740993123')))
      .syncResource({ account: primary, resource: 'after_sales' })
    assert.deepEqual({ received: refundResult.received, stored: refundResult.stored }, { received: 1, stored: 1 })
    assert.equal(await countEvents(primaryAccountId, 'after_sales'), 1)

    await resetCursor(primaryAccountId, 'order')
    const malformedService = makeService(async () => ({
      trades_simple_sold_increment_get_response: { total_results: 'invalid' }
    }))
    await assert.rejects(
      () => malformedService.syncResource({ account: primary, resource: 'order' }),
      error => error.code === 'TAOBAO_SYNC_FAILED'
    )
    const malformedState = await loadState(primaryAccountId, 'order')
    assert.equal(malformedState.cursorAt, INITIAL_CURSOR)
    assert.equal(malformedState.failureCount, 1)
    assert.equal(malformedState.lastErrorCode, 'TAOBAO_SYNC_RESPONSE_INVALID')

    const apiFailureService = makeService(async () => {
      throw Object.assign(new Error('upstream detail must stay private'), { code: 'TOP_API_ERROR' })
    })
    await assert.rejects(
      () => apiFailureService.syncResource({ account: primary, resource: 'order' }),
      error => error.code === 'TAOBAO_SYNC_FAILED' && !error.message.includes('private')
    )
    const apiFailureState = await loadState(primaryAccountId, 'order')
    assert.equal(apiFailureState.cursorAt, INITIAL_CURSOR)
    assert.equal(apiFailureState.failureCount, 2)
    assert.equal(apiFailureState.lastErrorCode, 'TOP_API_ERROR')

    const isolationCalls = []
    const isolatedResult = await makeService(createReverseOrderClient([orders[0]], isolationCalls))
      .syncResource({ account: isolated, resource: 'order' })
    assert.deepEqual(isolationCalls, [1, 1])
    assert.equal(isolatedResult.stored, 1)
    assert.equal(await countEvents(isolatedAccountId, 'order'), 1)
    assert.equal(await countEvents(primaryAccountId), 202)

    console.log(JSON.stringify({
      success: true,
      reversePageOrder: firstPageCalls,
      primaryEvents: 202,
      isolatedEvents: 1,
      duplicateEvents: duplicate.duplicates,
      cursorRetainedAfterFailures: apiFailureState.cursorAt === INITIAL_CURSOR
    }))
  } finally {
    for (const accountId of accountIds) {
      await sequelize.query(
        `DELETE FROM channel_event_inbox WHERE channel = 'taobao' AND account_id = :accountId`,
        { replacements: { accountId } }
      ).catch(() => {})
      await sequelize.query(
        `DELETE FROM channel_sync_state WHERE channel = 'taobao' AND account_id = :accountId`,
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
