const { callTaobaoApi } = require('./taobaoClient')
const TaobaoCommerceAdapter = require('./taobaoAdapter')

const CHANNEL = 'taobao'
const INITIAL_LOOKBACK_SECONDS = 30 * 60
const MAX_WINDOW_SECONDS = 30 * 60
const PAGE_SIZE = 100
const MAX_PAGES = 100

const ORDER_FIELDS = Object.freeze([
  'tid', 'status', 'payment', 'total_fee', 'post_fee', 'modified', 'created',
  'buyer_open_uid', 'ouid', 'orders'
])
const REFUND_FIELDS = Object.freeze([
  'refund_id', 'tid', 'oid', 'status', 'modified', 'created', 'refund_fee',
  'reason', 'desc', 'title', 'sku', 'new_sku', 'ouid', 'buyer_open_uid',
  'refund_phase', 'dispute_type', 'operation_contraint'
])

const RESOURCE_SPECS = Object.freeze({
  order: Object.freeze({
    method: 'taobao.trades.simple.sold.increment.get',
    responseKey: 'trades_simple_sold_increment_get_response',
    collectionKey: 'trades',
    recordKey: 'trade',
    fields: ORDER_FIELDS,
    normalizeMethod: 'normalizeOrder'
  }),
  after_sales: Object.freeze({
    method: 'taobao.refunds.receive.get',
    responseKey: 'refunds_receive_get_response',
    collectionKey: 'refunds',
    recordKey: 'refund',
    fields: REFUND_FIELDS,
    normalizeMethod: 'normalizeAfterSale'
  })
})

function syncError(code, message) {
  const error = new Error(message)
  error.name = 'TaobaoSyncError'
  error.code = code
  return error
}

function safeCode(error, fallback = 'TAOBAO_SYNC_FAILED') {
  const code = String(error?.code || '').trim()
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : fallback
}

function requireAccountId(account) {
  const accountId = Number(account?.id)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw syncError('TAOBAO_ACCOUNT_INVALID', 'Taobao account id is invalid')
  }
  return accountId
}

function requireCredentials(account) {
  const credentials = account?.credentials
  const required = ['appKey', 'appSecret', 'sessionKey', 'sellerNick']
  if (!credentials || typeof credentials !== 'object' ||
      required.some(field => typeof credentials[field] !== 'string' || !credentials[field].trim())) {
    throw syncError('TAOBAO_CREDENTIALS_INVALID', 'Taobao account credentials are incomplete')
  }
  return credentials
}

function formatChinaTime(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw syncError('TAOBAO_CURSOR_INVALID', 'Taobao sync time is invalid')
  }
  const date = new Date((epochSeconds + 8 * 60 * 60) * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function parsePage(payload, spec, expectedTotal = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao response is invalid')
  }
  const body = payload[spec.responseKey]
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao response root is invalid')
  }
  const totalResults = body.total_results
  if (!Number.isSafeInteger(totalResults) || totalResults < 0 ||
      (expectedTotal != null && totalResults !== expectedTotal)) {
    throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao response total is invalid')
  }

  const collection = body[spec.collectionKey]
  if (totalResults === 0 && collection == null) return { records: [], totalResults }
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao response collection is invalid')
  }
  const records = collection[spec.recordKey]
  if (!Array.isArray(records) || records.length > PAGE_SIZE) {
    throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao response records are invalid')
  }
  return { records, totalResults }
}

function createTaobaoSyncService({
  apiClient = callTaobaoApi,
  adapter = new TaobaoCommerceAdapter(),
  eventInbox,
  syncState,
  now = Date.now
} = {}) {
  if (typeof apiClient !== 'function' || typeof now !== 'function') {
    throw new TypeError('Taobao sync client dependencies are invalid')
  }
  if (!eventInbox || typeof eventInbox.store !== 'function') {
    throw new TypeError('Taobao event inbox dependency is required')
  }
  if (!syncState || !['getOrCreate', 'markSuccess', 'markFailure'].every(
    method => typeof syncState[method] === 'function'
  )) {
    throw new TypeError('Taobao sync state dependency is required')
  }

  function requestParams(spec, from, to, pageNo) {
    return {
      fields: spec.fields.join(','),
      start_modified: formatChinaTime(from),
      end_modified: formatChinaTime(to),
      page_no: pageNo,
      page_size: PAGE_SIZE,
      use_has_next: false
    }
  }

  async function fetchAllPages({ spec, credentials, from, to }) {
    const discovery = parsePage(
      await apiClient(spec.method, requestParams(spec, from, to, 1), credentials),
      spec
    )
    const totalResults = discovery.totalResults
    const pageCount = Math.ceil(totalResults / PAGE_SIZE)
    if (pageCount > MAX_PAGES) {
      throw syncError('TAOBAO_SYNC_PAGE_LIMIT', 'Taobao sync exceeded the page limit')
    }

    const records = []
    for (let pageNo = pageCount; pageNo >= 1; pageNo -= 1) {
      const page = parsePage(
        await apiClient(spec.method, requestParams(spec, from, to, pageNo), credentials),
        spec,
        totalResults
      )
      const expectedCount = pageNo === pageCount
        ? totalResults - (pageCount - 1) * PAGE_SIZE
        : PAGE_SIZE
      if (page.records.length !== expectedCount) {
        throw syncError('TAOBAO_SYNC_RESPONSE_INVALID', 'Taobao reverse pagination is inconsistent')
      }
      records.push(...page.records)
    }
    return records
  }

  async function syncResource({ account, resource }) {
    const accountId = requireAccountId(account)
    const spec = RESOURCE_SPECS[resource]
    if (!spec) throw syncError('TAOBAO_RESOURCE_INVALID', 'Taobao sync resource is invalid')
    const nowSeconds = Math.floor(now() / 1000)
    const initialCursorAt = Math.max(0, nowSeconds - INITIAL_LOOKBACK_SECONDS)

    let state
    try {
      state = await syncState.getOrCreate({ channel: CHANNEL, accountId, resource, initialCursorAt })
      const from = Number(state.cursorAt)
      if (!Number.isSafeInteger(from) || from < 0) {
        throw syncError('TAOBAO_CURSOR_INVALID', 'Taobao sync cursor is invalid')
      }
      if (from >= nowSeconds) {
        return { resource, received: 0, stored: 0, duplicates: 0, idle: true }
      }
      const to = Math.min(nowSeconds, from + MAX_WINDOW_SECONDS)
      if (to <= from || to - from > MAX_WINDOW_SECONDS) {
        throw syncError('TAOBAO_WINDOW_INVALID', 'Taobao sync window is invalid')
      }

      const credentials = requireCredentials(account)
      const records = await fetchAllPages({ spec, credentials, from, to })
      let stored = 0
      let duplicates = 0
      for (const record of records) {
        const event = adapter[spec.normalizeMethod](record, { accountId })
        const write = await eventInbox.store(event)
        if (write?.stored) stored += 1
        else if (write?.duplicate) duplicates += 1
        else throw syncError('TAOBAO_INBOX_WRITE_INVALID', 'Taobao inbox write result is invalid')
      }

      await syncState.markSuccess({ channel: CHANNEL, accountId, resource, cursorAt: to })
      return { resource, received: records.length, stored, duplicates, cursorAt: to }
    } catch (error) {
      if (state) {
        try {
          await syncState.markFailure({ channel: CHANNEL, accountId, resource, errorCode: safeCode(error) })
        } catch {
          // Preserve the original failure and never attempt a cursor advance here.
        }
      }
      throw syncError('TAOBAO_SYNC_FAILED', `Taobao ${resource} sync failed`)
    }
  }

  async function syncAccount(account) {
    requireAccountId(account)
    const resources = []
    let failed = false
    for (const resource of Object.keys(RESOURCE_SPECS)) {
      try {
        resources.push(await syncResource({ account, resource }))
      } catch {
        failed = true
        resources.push({ resource, success: false })
      }
    }
    if (failed) throw syncError('TAOBAO_ACCOUNT_SYNC_FAILED', 'One or more Taobao resources failed to sync')
    return { success: true, resources }
  }

  return { syncAccount, syncResource }
}

module.exports = {
  CHANNEL,
  INITIAL_LOOKBACK_SECONDS,
  MAX_WINDOW_SECONDS,
  PAGE_SIZE,
  MAX_PAGES,
  ORDER_FIELDS,
  REFUND_FIELDS,
  RESOURCE_SPECS,
  formatChinaTime,
  createTaobaoSyncService
}
