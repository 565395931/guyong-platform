const { callPinduoduoApi } = require('./pinduoduoClient')
const PinduoduoCommerceAdapter = require('./pinduoduoAdapter')

const CHANNEL = 'pinduoduo'
const INITIAL_LOOKBACK_SECONDS = 30 * 60
const MAX_WINDOW_SECONDS = 30 * 60
const PAGE_SIZE = 100
const MAX_PAGES = 100
const ORDER_DETAIL_API = 'pdd.order.information.get'

const RESOURCE_SPECS = Object.freeze({
  order: Object.freeze({
    apiType: 'pdd.order.number.list.increment.get',
    responseKey: 'order_number_list_get_response',
    listKey: 'order_sn_list',
    normalizeMethod: 'normalizeOrder'
  }),
  after_sales: Object.freeze({
    apiType: 'pdd.refund.list.increment.get',
    responseKey: 'refund_increment_get_response',
    listKey: 'refund_list',
    normalizeMethod: 'normalizeAfterSale'
  })
})

function safeCode(error, fallback = 'PINDUODUO_SYNC_FAILED') {
  const code = String(error?.code || '').trim()
  return /^[A-Za-z0-9_:-]{1,100}$/.test(code) ? code : fallback
}

function syncError(code, message) {
  const error = new Error(message)
  error.name = 'PinduoduoSyncError'
  error.code = code
  return error
}

function validateAccountId(account) {
  const accountId = Number(account?.id)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw syncError('PINDUODUO_ACCOUNT_INVALID', 'Pinduoduo account id is invalid')
  }
  return accountId
}

function requireCredentials(account) {
  const credentials = account?.credentials
  const required = ['clientId', 'clientSecret', 'accessToken', 'mallId']
  if (!credentials || typeof credentials !== 'object' ||
      required.some(field => typeof credentials[field] !== 'string' || !credentials[field].trim())) {
    throw syncError('PINDUODUO_CREDENTIALS_INVALID', 'Pinduoduo account credentials are incomplete')
  }
  return credentials
}

function parsePage(payload, spec, expectedTotal) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo sync response is invalid')
  }
  const body = payload[spec.responseKey]
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo sync response root is invalid')
  }
  const records = body[spec.listKey]
  const totalCount = body.total_count
  if (!Array.isArray(records) || records.length > PAGE_SIZE ||
      !Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo sync response page is invalid')
  }
  if (expectedTotal != null && totalCount !== expectedTotal) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo sync total changed during pagination')
  }
  return { records, totalCount }
}

function isHydratedOrder(record) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    typeof record.updated_at === 'string' && record.updated_at.trim()
}

function requireOrderNumber(record) {
  const value = record && typeof record === 'object' && !Array.isArray(record)
    ? record.order_sn
    : record
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo order number is unsafe')
  }
  const orderSn = ['string', 'number', 'bigint'].includes(typeof value) ? String(value).trim() : ''
  if (!orderSn) throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo order number is invalid')
  return orderSn
}

function parseOrderDetail(payload, expectedOrderSn) {
  const order = payload?.order_info_get_response?.order_info
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo order detail response is invalid')
  }
  if (requireOrderNumber(order) !== expectedOrderSn) {
    throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo order detail identity changed')
  }
  return order
}

function createPinduoduoSyncService({
  apiClient = callPinduoduoApi,
  adapter = new PinduoduoCommerceAdapter(),
  eventInbox,
  syncState,
  now = Date.now
} = {}) {
  if (typeof apiClient !== 'function' || typeof now !== 'function') {
    throw new TypeError('Pinduoduo sync client dependencies are invalid')
  }
  if (!eventInbox || typeof eventInbox.store !== 'function') {
    throw new TypeError('Pinduoduo event inbox dependency is required')
  }
  if (!syncState || !['getOrCreate', 'markSuccess', 'markFailure'].every(
    method => typeof syncState[method] === 'function'
  )) {
    throw new TypeError('Pinduoduo sync state dependency is required')
  }

  async function fetchAllPages({ spec, credentials, from, to }) {
    const records = []
    let expectedTotal = null

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await apiClient(spec.apiType, {
        start_updated_at: from,
        end_updated_at: to,
        page,
        page_size: PAGE_SIZE
      }, credentials)
      const parsed = parsePage(payload, spec, expectedTotal)
      if (expectedTotal == null) expectedTotal = parsed.totalCount
      records.push(...parsed.records)

      if (records.length === expectedTotal) return records
      if (records.length > expectedTotal || parsed.records.length === 0) {
        throw syncError('PINDUODUO_SYNC_RESPONSE_INVALID', 'Pinduoduo sync pagination is inconsistent')
      }
    }

    throw syncError('PINDUODUO_SYNC_PAGE_LIMIT', 'Pinduoduo sync exceeded the page limit')
  }

  async function hydrateOrderRecords(records, credentials) {
    const orders = []
    for (const record of records) {
      if (isHydratedOrder(record)) {
        orders.push(record)
        continue
      }
      const orderSn = requireOrderNumber(record)
      const payload = await apiClient(ORDER_DETAIL_API, { order_sn: orderSn }, credentials)
      orders.push(parseOrderDetail(payload, orderSn))
    }
    return orders
  }

  async function syncResource({ account, resource }) {
    const accountId = validateAccountId(account)
    const spec = RESOURCE_SPECS[resource]
    if (!spec) throw syncError('PINDUODUO_RESOURCE_INVALID', 'Pinduoduo sync resource is invalid')
    const nowSeconds = Math.floor(now() / 1000)
    const initialCursorAt = Math.max(0, nowSeconds - INITIAL_LOOKBACK_SECONDS)

    let state
    try {
      state = await syncState.getOrCreate({
        channel: CHANNEL,
        accountId,
        resource,
        initialCursorAt
      })
      const from = Number(state.cursorAt)
      if (!Number.isSafeInteger(from) || from < 0) {
        throw syncError('PINDUODUO_CURSOR_INVALID', 'Pinduoduo sync cursor is invalid')
      }
      if (from >= nowSeconds) {
        return { resource, received: 0, stored: 0, duplicates: 0, idle: true }
      }
      const to = Math.min(nowSeconds, from + MAX_WINDOW_SECONDS)
      if (to <= from || to - from > MAX_WINDOW_SECONDS) {
        throw syncError('PINDUODUO_WINDOW_INVALID', 'Pinduoduo sync window is invalid')
      }

      const credentials = requireCredentials(account)
      const incrementalRecords = await fetchAllPages({ spec, credentials, from, to })
      const records = resource === 'order'
        ? await hydrateOrderRecords(incrementalRecords, credentials)
        : incrementalRecords
      let stored = 0
      let duplicates = 0
      for (const record of records) {
        const event = adapter[spec.normalizeMethod](record, { accountId })
        const write = await eventInbox.store(event)
        if (write?.stored) stored += 1
        else if (write?.duplicate) duplicates += 1
        else throw syncError('PINDUODUO_INBOX_WRITE_INVALID', 'Pinduoduo inbox write result is invalid')
      }

      await syncState.markSuccess({
        channel: CHANNEL,
        accountId,
        resource,
        cursorAt: to
      })
      return { resource, received: records.length, stored, duplicates, cursorAt: to }
    } catch (error) {
      if (state) {
        try {
          await syncState.markFailure({
            channel: CHANNEL,
            accountId,
            resource,
            errorCode: safeCode(error)
          })
        } catch {
          // The original failure remains the useful signal; cursor updates are never attempted here.
        }
      }
      throw syncError('PINDUODUO_SYNC_FAILED', `Pinduoduo ${resource} sync failed`)
    }
  }

  async function syncAccount(account) {
    validateAccountId(account)
    const results = []
    let failed = false
    for (const resource of Object.keys(RESOURCE_SPECS)) {
      try {
        results.push(await syncResource({ account, resource }))
      } catch {
        failed = true
        results.push({ resource, success: false })
      }
    }
    if (failed) {
      throw syncError('PINDUODUO_ACCOUNT_SYNC_FAILED', 'One or more Pinduoduo resources failed to sync')
    }
    return { success: true, resources: results }
  }

  return { syncAccount, syncResource }
}

module.exports = {
  CHANNEL,
  INITIAL_LOOKBACK_SECONDS,
  MAX_WINDOW_SECONDS,
  PAGE_SIZE,
  MAX_PAGES,
  ORDER_DETAIL_API,
  RESOURCE_SPECS,
  createPinduoduoSyncService
}
