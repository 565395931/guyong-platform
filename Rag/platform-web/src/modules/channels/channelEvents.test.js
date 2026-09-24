import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

let eventModule = {}
try {
  eventModule = await import('./channelEvents.js')
} catch {
  eventModule = {}
}

test('builds a fixed Douyin event query and omits empty filters', () => {
  assert.equal(typeof eventModule.buildChannelEventQuery, 'function')
  assert.deepEqual(eventModule.buildChannelEventQuery({
    accountId: 12,
    category: 'order',
    status: '',
    page: 3,
    pageSize: 20
  }), {
    channel: 'douyin',
    account_id: 12,
    category: 'order',
    limit: 20,
    offset: 40
  })
})

test('builds a route-selected Pinduoduo event query', () => {
  assert.deepEqual(eventModule.buildChannelEventQuery({
    channel: 'pinduoduo',
    accountId: '7',
    page: 2,
    pageSize: 10
  }), {
    channel: 'pinduoduo',
    account_id: '7',
    limit: 10,
    offset: 10
  })
})

test('normalizes a reconciled projection summary and rejects broken contracts', () => {
  assert.deepEqual(eventModule.normalizeProjectionSummary({ total: '12', ready: 5, rawOnly: 7 }), {
    total: 12,
    ready: 5,
    rawOnly: 7
  })

  for (const value of [
    null,
    { total: -1, ready: 0, rawOnly: 0 },
    { total: 2, ready: 1.5, rawOnly: 0.5 },
    { total: 2, ready: 1, rawOnly: 0 }
  ]) assert.throws(() => eventModule.normalizeProjectionSummary(value), /projection summary/i)
})

test('distinguishes no configured account from no matching event', () => {
  assert.equal(typeof eventModule.channelEventEmptyState, 'function')
  assert.deepEqual(eventModule.channelEventEmptyState(0), {
    title: '尚未配置抖店账号',
    description: '请联系管理员先完成抖店账号接入。'
  })
  assert.deepEqual(eventModule.channelEventEmptyState(2), {
    title: '暂无业务事件',
    description: '当前筛选条件下没有订单、售后或商品事件。'
  })
})

test('uses channel-specific empty copy without claiming unsupported product events', () => {
  assert.deepEqual(eventModule.channelEventEmptyState(0, 'pinduoduo'), {
    title: '尚未配置拼多多账号',
    description: '请联系管理员先完成拼多多账号接入。'
  })
  assert.deepEqual(eventModule.channelEventEmptyState(2, 'pinduoduo'), {
    title: '暂无业务事件',
    description: '当前筛选条件下没有订单或售后事件。'
  })
})

test('uses Taobao-specific order and refund copy', () => {
  assert.deepEqual(eventModule.buildChannelEventQuery({
    channel: 'taobao',
    accountId: '18'
  }), {
    channel: 'taobao',
    account_id: '18',
    limit: 20,
    offset: 0
  })
  assert.deepEqual(eventModule.channelEventEmptyState(0, 'taobao'), {
    title: '尚未配置淘宝账号',
    description: '请联系管理员先完成淘宝开放平台账号接入。'
  })
  assert.deepEqual(eventModule.channelEventEmptyState(1, 'taobao'), {
    title: '暂无业务事件',
    description: '当前筛选条件下没有订单或退款事件。'
  })
})

test('builds 1688 queries and uses encrypted-order identity copy', () => {
  assert.deepEqual(eventModule.buildChannelEventQuery({
    channel: 'alibaba1688',
    accountId: '28'
  }), {
    channel: 'alibaba1688',
    account_id: '28',
    limit: 20,
    offset: 0
  })
  assert.deepEqual(eventModule.channelEventEmptyState(0, 'alibaba1688'), {
    title: '尚未配置 1688 账号',
    description: '请联系管理员先完成 1688 开放平台账号接入。'
  })
  assert.deepEqual(eventModule.channelEventEmptyState(1, 'alibaba1688'), {
    title: '暂无业务事件',
    description: '当前筛选条件下没有订单或退款事件。'
  })
})

test('latest request runner ignores stale success and stale loading completion', async () => {
  assert.equal(typeof eventModule.createLatestRequestRunner, 'function')
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const state = { items: ['existing'], loading: false, error: '' }
  const runLatest = eventModule.createLatestRequestRunner({
    onStart: () => { state.loading = true; state.error = '' },
    onSuccess: value => { state.items = value },
    onError: error => { state.error = error.message },
    onFinish: () => { state.loading = false }
  })
  const older = deferred()
  const newer = deferred()

  const olderRun = runLatest(() => older.promise)
  const newerRun = runLatest(() => newer.promise)
  newer.resolve(['newer'])
  await newerRun
  older.resolve(['older'])
  await olderRun

  assert.deepEqual(state, { items: ['newer'], loading: false, error: '' })
})

test('latest request failure reports an error without requiring existing data to be cleared', async () => {
  assert.equal(typeof eventModule.createLatestRequestRunner, 'function')
  const state = { items: ['existing'], loading: false, error: '' }
  const runLatest = eventModule.createLatestRequestRunner({
    onStart: () => { state.loading = true; state.error = '' },
    onSuccess: value => { state.items = value },
    onError: error => { state.error = error.message },
    onFinish: () => { state.loading = false }
  })

  await runLatest(() => Promise.reject(new Error('网络不可用')))

  assert.deepEqual(state, { items: ['existing'], loading: false, error: '网络不可用' })
})

test('detail latest runner keeps the newer event when an older detail returns last', async () => {
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const state = { selected: null, loading: false, error: '' }
  const runLatestDetail = eventModule.createLatestRequestRunner({
    onStart: () => { state.loading = true; state.error = '' },
    onSuccess: detail => { state.selected = detail },
    onError: error => { state.error = error.message },
    onFinish: () => { state.loading = false }
  })
  const older = deferred()
  const newer = deferred()
  const open = (summary, request) => {
    state.selected = summary
    return runLatestDetail(request)
  }

  const olderRun = open({ id: 'A', summary: true }, () => older.promise)
  const newerRun = open({ id: 'B', summary: true }, () => newer.promise)
  newer.resolve({ id: 'B', payload: { newer: true } })
  await newerRun
  older.resolve({ id: 'A', payload: { older: true } })
  await olderRun

  assert.deepEqual(state, {
    selected: { id: 'B', payload: { newer: true } },
    loading: false,
    error: ''
  })
})

test('latest detail failure preserves the current event summary', async () => {
  const state = { selected: { id: 'B', summary: true }, loading: false, error: '' }
  const runLatestDetail = eventModule.createLatestRequestRunner({
    onStart: () => { state.loading = true; state.error = '' },
    onSuccess: detail => { state.selected = detail },
    onError: error => { state.error = error.message },
    onFinish: () => { state.loading = false }
  })

  await runLatestDetail(() => Promise.reject(new Error('详情失败')))

  assert.deepEqual(state, {
    selected: { id: 'B', summary: true },
    loading: false,
    error: '详情失败'
  })
})

test('channel event view uses real APIs, a compact table, pagination and a payload drawer', () => {
  const viewUrl = new URL('../../views/Channels/ChannelEventsView.vue', import.meta.url)
  const apiUrl = new URL('../../api/channels.js', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const view = existsSync(viewUrl) ? readFileSync(viewUrl, 'utf8') : ''
  const api = readFileSync(apiUrl, 'utf8')

  assert.match(api, /export function getChannelEvents\(params\)/)
  assert.match(api, /export function getChannelEventAccounts\(params\)/)
  assert.match(api, /export function getChannelEvent\(id\)/)
  assert.match(api, /export function getChannelProjectionSummary\(params\)/)
  assert.match(view, /抖店业务消息/)
  assert.match(view, /拼多多业务消息/)
  assert.match(view, /淘宝 \/ 千牛业务消息/)
  assert.match(view, /buyer_open_uid \/ ouid/)
  assert.match(view, /平台暂未开放飞鸽客服收发 API，只显示订单\/售后\/商品事件/)
  assert.match(view, /<el-table/)
  assert.match(view, /<el-pagination/)
  assert.match(view, /<el-drawer/)
  assert.match(view, /eventsLoading/)
  assert.match(view, /accountsLoading/)
  assert.match(view, /detailLoading/)
  assert.match(view, /eventError/)
  assert.match(view, /accountsError/)
  assert.match(view, /detailError/)
  assert.match(view, /projectionSummary/)
  assert.match(view, /projectionSummaryError/)
  assert.match(view, /getChannelProjectionSummary/)
  assert.match(view, /Promise\.allSettled/)
  assert.match(view, /getChannelEvent\(event\.id\)/)
  assert.match(view, /route\.meta\.channelCode/)
  assert.match(view, /const runLatestDetailRequest = createLatestRequestRunner/)
  assert.match(view, /event-table[\s\S]*overflow-x:\s*auto/)
  assert.match(view, /el-descriptions__table[\s\S]*table-layout:\s*fixed/)
  assert.match(view, /el-descriptions__label[\s\S]*white-space:\s*nowrap/)
  assert.match(view, /el-descriptions__content[\s\S]*overflow-wrap:\s*anywhere/)
  assert.match(view, /detail-content[\s\S]*overflow-x:\s*hidden/)
  assert.match(
    view,
    /v-else-if="!eventsLoading && !accountsLoading && !eventError && !accountsError"/
  )
  assert.match(view, /重试/)
  assert.doesNotMatch(view, /AI 回复|人工回复/)
  assert.doesNotMatch(view, /发送消息|回复买家/)
})
