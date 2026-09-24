export function buildChannelEventQuery({
  channel = 'douyin',
  accountId = '',
  category = '',
  status = '',
  page = 1,
  pageSize = 20
} = {}) {
  const query = {
    channel: String(channel || 'douyin').trim().toLowerCase(),
    limit: pageSize,
    offset: Math.max(0, page - 1) * pageSize
  }
  if (accountId !== '' && accountId != null) query.account_id = accountId
  if (category) query.category = category
  if (status) query.status = status
  return query
}

export function normalizeProjectionSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid projection summary')
  }
  const readCount = field => {
    const raw = String(value[field] ?? '')
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw new TypeError('Invalid projection summary')
    const count = Number(raw)
    if (!Number.isSafeInteger(count)) throw new TypeError('Invalid projection summary')
    return count
  }
  const summary = {
    total: readCount('total'),
    ready: readCount('ready'),
    rawOnly: readCount('rawOnly')
  }
  if (summary.ready + summary.rawOnly !== summary.total) {
    throw new TypeError('Invalid projection summary reconciliation')
  }
  return Object.freeze(summary)
}

export function channelEventEmptyState(accountCount, channel = 'douyin') {
  const normalized = String(channel || 'douyin').trim().toLowerCase()
  const isPinduoduo = normalized === 'pinduoduo'
  const isTaobao = normalized === 'taobao'
  const isAlibaba1688 = normalized === 'alibaba1688'
  const eventDescription = isAlibaba1688
    ? '当前筛选条件下没有订单或退款事件。'
    : isTaobao
    ? '当前筛选条件下没有订单或退款事件。'
    : isPinduoduo
      ? '当前筛选条件下没有订单或售后事件。'
      : '当前筛选条件下没有订单、售后或商品事件。'
  const accountTitle = isAlibaba1688
    ? '尚未配置 1688 账号'
    : isTaobao
    ? '尚未配置淘宝账号'
    : isPinduoduo
      ? '尚未配置拼多多账号'
      : '尚未配置抖店账号'
  const accountDescription = isAlibaba1688
    ? '请联系管理员先完成 1688 开放平台账号接入。'
    : isTaobao
    ? '请联系管理员先完成淘宝开放平台账号接入。'
    : isPinduoduo
      ? '请联系管理员先完成拼多多账号接入。'
      : '请联系管理员先完成抖店账号接入。'
  return accountCount > 0
    ? {
        title: '暂无业务事件',
        description: eventDescription
      }
    : {
        title: accountTitle,
        description: accountDescription
      }
}

export function createLatestRequestRunner({ onStart, onSuccess, onError, onFinish } = {}) {
  let latestRequestId = 0
  return async function runLatest(request) {
    const requestId = ++latestRequestId
    onStart?.()
    try {
      const value = await request()
      if (requestId !== latestRequestId) return { stale: true }
      onSuccess?.(value)
      return { stale: false, value }
    } catch (error) {
      if (requestId !== latestRequestId) return { stale: true }
      onError?.(error)
      return { stale: false, error }
    } finally {
      if (requestId === latestRequestId) onFinish?.()
    }
  }
}
