const {
  callAlibaba1688Api,
  ORDER_LIST_API,
  REFUND_LIST_API
} = require('./alibaba1688Client')
const Alibaba1688CommerceAdapter = require('./alibaba1688Adapter')

const CHANNEL = 'alibaba1688'
const INITIAL_LOOKBACK_SECONDS = 30 * 60
const MAX_WINDOW_SECONDS = 30 * 60
const PAGE_SIZE = 20
const MAX_PAGES = 100

const RESOURCE_SPECS = Object.freeze({
  order: Object.freeze({
    apiName: ORDER_LIST_API,
    firstPage: 1,
    pageParam: 'page',
    normalizeMethod: 'normalizeOrder'
  }),
  after_sales: Object.freeze({
    apiName: REFUND_LIST_API,
    firstPage: 0,
    pageParam: 'currentPageNum',
    normalizeMethod: 'normalizeAfterSale'
  })
})

function syncError(code, message) {
  const error = new Error(message)
  error.name = 'Alibaba1688SyncError'
  error.code = code
  return error
}

function safeCode(error, fallback = 'ALIBABA1688_SYNC_FAILED') {
  const code = String(error?.code || '').trim()
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : fallback
}

function requireAccountId(account) {
  const accountId = Number(account?.id)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw syncError('ALIBABA1688_ACCOUNT_INVALID', '1688 account id is invalid')
  }
  return accountId
}

function requireCredentials(account) {
  const credentials = account?.credentials
  const required = ['appKey', 'appSecret', 'accessToken', 'sellerMemberId']
  if (!credentials || typeof credentials !== 'object' ||
      required.some(field => typeof credentials[field] !== 'string' || !credentials[field].trim())) {
    throw syncError('ALIBABA1688_CREDENTIALS_INVALID', '1688 account credentials are incomplete')
  }
  return credentials
}

function formatAlibaba1688Time(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw syncError('ALIBABA1688_CURSOR_INVALID', '1688 sync time is invalid')
  }
  const date = new Date((epochSeconds + 8 * 60 * 60) * 1000)
  const pad2 = value => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}000+0800`
}

function requireTotal(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 response total is invalid')
  }
  return value
}

function requireRecords(records) {
  if (!Array.isArray(records) || records.length > PAGE_SIZE) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 response records are invalid')
  }
  return records
}

function validateResponseRoot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 response root is invalid')
  }
}

function parseOrderPage(payload, expectedTotal = null) {
  validateResponseRoot(payload)
  if (payload.retCodes != null && (!Array.isArray(payload.retCodes) || payload.retCodes.length > 0)) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 order response contains error codes')
  }
  const total = requireTotal(payload.totalRecord)
  if (expectedTotal != null && total !== expectedTotal) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 order total changed during pagination')
  }
  return { records: requireRecords(payload.result), total }
}

function parseRefundPage(payload, requestedPage, expectedTotal = null) {
  validateResponseRoot(payload)
  const body = payload.result
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 refund response root is invalid')
  }
  const total = requireTotal(body.totalCount)
  if (expectedTotal != null && total !== expectedTotal) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 refund total changed during pagination')
  }
  if (!Number.isSafeInteger(body.currentPageNum) || body.currentPageNum !== requestedPage) {
    throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 refund page number is invalid')
  }
  return { records: requireRecords(body.opOrderRefundModels), total }
}

function createAlibaba1688SyncService({
  apiClient = callAlibaba1688Api,
  adapter = new Alibaba1688CommerceAdapter(),
  eventInbox,
  syncState,
  now = Date.now
} = {}) {
  if (typeof apiClient !== 'function' || typeof now !== 'function') {
    throw new TypeError('1688 sync client dependencies are invalid')
  }
  if (!eventInbox || typeof eventInbox.store !== 'function') {
    throw new TypeError('1688 event inbox dependency is required')
  }
  if (!syncState || !['getOrCreate', 'markSuccess', 'markFailure'].every(
    method => typeof syncState[method] === 'function'
  )) {
    throw new TypeError('1688 sync state dependency is required')
  }

  function requestParams({ spec, credentials, from, to, page }) {
    const params = {
      sellerMemberId: credentials.sellerMemberId,
      modifyStartTime: formatAlibaba1688Time(from),
      modifyEndTime: formatAlibaba1688Time(to),
      pageSize: PAGE_SIZE,
      [spec.pageParam]: page
    }
    if (spec.apiName === ORDER_LIST_API) {
      Object.assign(params, {
        needBuyerAddressAndPhone: false,
        needMemoInfo: false,
        isHis: false
      })
    }
    return params
  }

  async function fetchAllPages({ spec, credentials, from, to }) {
    const firstPage = spec.firstPage
    const firstPayload = await apiClient(
      spec.apiName,
      requestParams({ spec, credentials, from, to, page: firstPage }),
      credentials
    )
    const first = spec.apiName === ORDER_LIST_API
      ? parseOrderPage(firstPayload)
      : parseRefundPage(firstPayload, firstPage)
    const pageCount = Math.ceil(first.total / PAGE_SIZE)
    if (pageCount > MAX_PAGES) {
      throw syncError('ALIBABA1688_SYNC_PAGE_LIMIT', '1688 sync exceeded the page limit')
    }

    const records = [...first.records]
    const expectedFirstCount = pageCount > 1 ? PAGE_SIZE : first.total
    if (first.records.length !== expectedFirstCount) {
      throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 first page count is inconsistent')
    }

    for (let index = 1; index < pageCount; index += 1) {
      const page = firstPage + index
      const payload = await apiClient(
        spec.apiName,
        requestParams({ spec, credentials, from, to, page }),
        credentials
      )
      const parsed = spec.apiName === ORDER_LIST_API
        ? parseOrderPage(payload, first.total)
        : parseRefundPage(payload, page, first.total)
      const expectedCount = index === pageCount - 1
        ? first.total - (pageCount - 1) * PAGE_SIZE
        : PAGE_SIZE
      if (parsed.records.length !== expectedCount) {
        throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 pagination count is inconsistent')
      }
      records.push(...parsed.records)
    }

    if (records.length !== first.total) {
      throw syncError('ALIBABA1688_SYNC_RESPONSE_INVALID', '1688 pagination total is inconsistent')
    }
    return records
  }

  async function syncResource({ account, resource }) {
    const accountId = requireAccountId(account)
    const spec = RESOURCE_SPECS[resource]
    if (!spec) throw syncError('ALIBABA1688_RESOURCE_INVALID', '1688 sync resource is invalid')
    const nowSeconds = Math.floor(now() / 1000)
    const initialCursorAt = Math.max(0, nowSeconds - INITIAL_LOOKBACK_SECONDS)

    let state
    try {
      state = await syncState.getOrCreate({ channel: CHANNEL, accountId, resource, initialCursorAt })
      const from = Number(state.cursorAt)
      if (!Number.isSafeInteger(from) || from < 0) {
        throw syncError('ALIBABA1688_CURSOR_INVALID', '1688 sync cursor is invalid')
      }
      if (from >= nowSeconds) {
        return { resource, received: 0, stored: 0, duplicates: 0, idle: true }
      }
      const to = Math.min(nowSeconds, from + MAX_WINDOW_SECONDS)
      if (to <= from || to - from > MAX_WINDOW_SECONDS) {
        throw syncError('ALIBABA1688_WINDOW_INVALID', '1688 sync window is invalid')
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
        else throw syncError('ALIBABA1688_INBOX_WRITE_INVALID', '1688 inbox write result is invalid')
      }

      await syncState.markSuccess({ channel: CHANNEL, accountId, resource, cursorAt: to })
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
          // Keep the original failure and never advance the cursor here.
        }
      }
      throw syncError('ALIBABA1688_SYNC_FAILED', `1688 ${resource} sync failed`)
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
    if (failed) {
      throw syncError('ALIBABA1688_ACCOUNT_SYNC_FAILED', 'One or more 1688 resources failed to sync')
    }
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
  ORDER_LIST_API,
  REFUND_LIST_API,
  RESOURCE_SPECS,
  formatAlibaba1688Time,
  createAlibaba1688SyncService
}
