# 拼多多订单与售后同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让系统安全配置多个拼多多店铺账号，按官方接口增量同步订单和售后事件，并在统一前端展示真实能力与同步结果。

**Architecture:** 新增 `pinduoduo_commerce` 适配器，负责凭据校验、固定网关签名、官方 API 调用和订单/售后规范化。同步服务按账号和资源维护持久化游标，将事件写入现有 `channel_event_inbox`；前端复用渠道事件页，仅在管理角色下开放账号配置，客服聊天始终禁用。

**Tech Stack:** Node.js、Express、Sequelize/MySQL、Vue 3、Element Plus、Node test runner

---

### Task 1: 渠道能力与账号配置

**Files:**
- Modify: `rag-server/src/modules/channel-capabilities/channelCapabilities.js`
- Modify: `rag-server/src/modules/channel-capabilities/channelDefinitions.seed.js`
- Create: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAccountConfig.js`
- Test: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAccountConfig.test.js`
- Modify: `rag-server/src/routes/channelAccounts.js`
- Modify: `rag-server/src/routes/channelAccounts.presenter.js`

- [x] **Step 1: Write failing capability and credential tests**

```js
assert.deepEqual(getChannelCapabilities('pinduoduo'), {
  customerMessagesIn: false,
  customerMessagesOut: false,
  orderEvents: true,
  afterSalesEvents: true,
  productEvents: false,
  requiresPublicCallback: false,
  limitation: '拼多多官方商家 API 当前未提供买家客服聊天收发能力，本系统只同步订单和售后事件'
})
assert.deepEqual(
  validatePinduoduoAccountConfig({ clientId: 'id', clientSecret: 'secret', accessToken: 'token', mallId: '1001' }),
  { clientId: 'id', clientSecret: 'secret', accessToken: 'token', mallId: '1001' }
)
assert.throws(() => validatePinduoduoAccountConfig({}), /clientId, clientSecret, accessToken, mallId/)
```

- [x] **Step 2: Run tests and confirm RED**

Run: `node --test src/modules/channel-capabilities/channelCapabilities.test.js src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAccountConfig.test.js`

Expected: FAIL because the capability and config module do not exist.

- [x] **Step 3: Implement capability, idempotent seed, validation and redacted presentation**

```js
const PINDUODUO_COMMERCE_ADAPTER_TYPE = 'pinduoduo_commerce'
const REQUIRED_FIELDS = Object.freeze(['clientId', 'clientSecret', 'accessToken', 'mallId'])

function validatePinduoduoAccountConfig(config = {}) {
  const normalized = Object.fromEntries(REQUIRED_FIELDS.map(field => [field, String(config[field] || '').trim()]))
  const missing = REQUIRED_FIELDS.filter(field => !normalized[field])
  if (missing.length) {
    const error = new TypeError(`拼多多配置字段必须为非空字符串: ${missing.join(', ')}`)
    error.code = 'PINDUODUO_ACCOUNT_CONFIG_INVALID'
    error.fields = missing
    throw error
  }
  return normalized
}
```

The account create route must force `adapter_type=pinduoduo_commerce`; list and detail responses may expose only `credentialStatus`, `mallIdMask` and sync status, never config, Client Secret or Access Token.

- [x] **Step 4: Run tests and confirm GREEN**

Run: `node --test src/modules/channel-capabilities/*.test.js src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAccountConfig.test.js src/routes/channelAccounts.presenter.test.js`

Expected: PASS.

### Task 2: Official gateway signer and client

**Files:**
- Create: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoSignature.js`
- Create: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoClient.js`
- Test: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoClient.test.js`

- [x] **Step 1: Write failing deterministic signature and HTTP contract tests**

```js
assert.equal(
  buildPinduoduoSign({ type: 'pdd.order.number.list.increment.get', client_id: 'abc', timestamp: 100 }, 'secret'),
  crypto.createHash('md5').update('secretclient_idabctimestamp100typepdd.order.number.list.increment.getsecret').digest('hex').toUpperCase()
)
assert.equal(request.url, 'https://gw-api.pinduoduo.com/api/router')
assert.equal(request.body.type, 'pdd.order.number.list.increment.get')
assert.ok(request.body.sign)
assert.equal(Object.hasOwn(request.body, 'client_secret'), false)
```

- [x] **Step 2: Run test and confirm RED**

Run: `node --test src/modules/channel-adapters/pinduoduo-commerce/pinduoduoClient.test.js`

Expected: FAIL because signer and client do not exist.

- [x] **Step 3: Implement sorted MD5 signing and fixed-host JSON POST**

```js
const GATEWAY_URL = 'https://gw-api.pinduoduo.com/api/router'

function buildPinduoduoSign(params, secret) {
  const canonical = Object.keys(params).sort().map(key => `${key}${serializeValue(params[key])}`).join('')
  return crypto.createHash('md5').update(`${secret}${canonical}${secret}`, 'utf8').digest('hex').toUpperCase()
}

async function callPinduoduoApi(type, businessParams, credentials, { fetchImpl = fetch, now = Date.now } = {}) {
  const body = compactParams({
    ...businessParams,
    type,
    client_id: credentials.clientId,
    access_token: credentials.accessToken,
    data_type: 'JSON',
    timestamp: Math.floor(now() / 1000)
  })
  body.sign = buildPinduoduoSign(body, credentials.clientSecret)
  const response = await fetchImpl(GATEWAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  })
  return parsePinduoduoResponse(response)
}
```

Map non-2xx, invalid JSON and `error_response` to errors with stable codes; redact request params and tokens from all logs.

- [x] **Step 4: Run test and confirm GREEN**

Run: `node --test src/modules/channel-adapters/pinduoduo-commerce/pinduoduoClient.test.js`

Expected: PASS for signing, fixed host, timeout, API error and secret-redaction cases.

### Task 3: Order and after-sales normalization

**Files:**
- Create: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAdapter.js`
- Test: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAdapter.test.js`
- Modify: `rag-server/src/modules/channel-adapters/index.js`

- [x] **Step 1: Write failing normalization and unsupported-chat tests**

```js
assert.deepEqual(adapter.normalizeOrder({ order_sn: 'P1', updated_at: '2026-07-25 12:00:00' }, { accountId: 4 }), {
  externalEventId: 'order:P1:2026-07-25 12:00:00',
  channel: 'pinduoduo',
  accountId: 4,
  eventType: 'order.updated',
  category: 'order',
  businessKey: 'P1',
  occurredAt: '2026-07-25T04:00:00.000Z',
  payload: { order_sn: 'P1', updated_at: '2026-07-25 12:00:00' }
})
assert.equal((await adapter.sendMessage()).code, 'capability_not_supported')
```

- [x] **Step 2: Run test and confirm RED**

Run: `node --test src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAdapter.test.js`

Expected: FAIL because the adapter is not registered.

- [x] **Step 3: Implement stable IDs and strict response extraction**

```js
normalizeAfterSale(refund, { accountId }) {
  const updated = String(refund.updated_time || refund.updated_at || '')
  const refundId = String(refund.id || '')
  if (!refundId || !updated) throw createShapeError('refund id and updated_time are required')
  return {
    externalEventId: `after_sales:${refundId}:${updated}`,
    channel: 'pinduoduo', accountId,
    eventType: 'after_sales.updated', category: 'after_sales',
    businessKey: String(refund.order_sn || refundId),
    occurredAt: parseChinaTime(updated), payload: { ...refund }
  }
}
```

Reject missing stable identifiers instead of inventing random IDs. Register `pinduoduo_commerce` and map channel `pinduoduo` to it.

- [x] **Step 4: Run test and confirm GREEN**

Run: `node --test src/modules/channel-adapters/pinduoduo-commerce/pinduoduoAdapter.test.js src/modules/channel-adapters/douyin-commerce/douyinAdapter.test.js`

Expected: PASS with no Douyin regression.

### Task 4: Persistent cursors and automatic sync

**Files:**
- Create: `rag-server/src/modules/channel-sync/channelSyncState.schema.js`
- Create: `rag-server/src/modules/channel-sync/channelSyncState.repository.js`
- Test: `rag-server/src/modules/channel-sync/channelSyncState.test.js`
- Create: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoSyncService.js`
- Test: `rag-server/src/modules/channel-adapters/pinduoduo-commerce/pinduoduoSyncService.test.js`
- Create: `rag-server/src/workers/pinduoduoSyncWorker.js`
- Modify: `rag-server/src/config/database.js`
- Modify: `rag-server/src/app.js`

- [x] **Step 1: Write failing cursor, pagination, retry and overlap tests**

```js
assert.match(schemaSql, /UNIQUE KEY uq_channel_sync_state \(channel, account_id, resource\)/)
assert.equal(orderCall.end_updated_at - orderCall.start_updated_at <= 1800, true)
assert.equal(storedEvents.length, 2)
assert.equal(cursor.advanceCalls.length, 1)
await assert.rejects(() => syncAccount(failingAccount))
assert.equal(cursor.advanceCalls.length, 0)
assert.equal(workerTickWhileRunning.skipped, true)
```

- [x] **Step 2: Run tests and confirm RED**

Run: `node --test src/modules/channel-sync/*.test.js src/modules/channel-adapters/pinduoduo-commerce/pinduoduoSyncService.test.js src/workers/pinduoduoSyncWorker.test.js`

Expected: FAIL because the state repository, service and worker do not exist.

- [x] **Step 3: Implement fail-closed cursor advancement**

```js
async function syncResource({ account, resource, from, to }) {
  assertWindow(from, to, 1800)
  const pages = await fetchAllPages({ account, resource, from, to, maxPages: 100 })
  for (const event of normalizePages(pages, account.id, resource)) await eventInbox.store(event)
  await syncState.markSuccess({ channel: 'pinduoduo', accountId: account.id, resource, cursorAt: to })
  return { resource, received: pages.length }
}
```

On any API, shape or storage error call `markFailure` without changing `cursor_at`. The worker runs every 60 seconds, prevents overlapping ticks, loads only active `pinduoduo_commerce` accounts, and starts each new account at `now - 30 minutes`.

- [x] **Step 4: Run tests and confirm GREEN**

Run: `node --test src/modules/channel-sync/*.test.js src/modules/channel-adapters/pinduoduo-commerce/*.test.js src/workers/pinduoduoSyncWorker.test.js`

Expected: PASS for cursor isolation, pagination bounds, dedupe, retries and no overlapping runs.

### Task 5: Shared front-end event page and Pinduoduo account form

**Files:**
- Create: `platform-web/src/modules/channels/pinduoduoAccountForm.js`
- Test: `platform-web/src/modules/channels/pinduoduoAccountForm.test.js`
- Modify: `platform-web/src/modules/channels/channelCapabilities.js`
- Modify: `platform-web/src/views/Settings/AccountManage.vue`
- Modify: `platform-web/src/views/Channels/ChannelEventsView.vue`
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/router/index.js`

- [x] **Step 1: Write failing form, route-meta and navigation tests**

```js
assert.deepEqual(buildPinduoduoAccountPayload(form), {
  channel: 'pinduoduo', account_name: form.accountName,
  adapter_type: 'pinduoduo_commerce', max_daily_quota: 1000,
  config: { clientId: form.clientId, clientSecret: form.clientSecret, accessToken: form.accessToken, mallId: form.mallId }
})
assert.deepEqual(buildSidebarMenu('agent').find(item => item.key === 'pinduoduo').children.map(x => x.path), ['/pinduoduo/events'])
assert.deepEqual(buildSidebarMenu('admin').find(item => item.key === 'pinduoduo').children.map(x => x.path), ['/pinduoduo/events', '/pinduoduo/accounts'])
```

- [x] **Step 2: Run tests and confirm RED**

Run: `node --test src/modules/channels/pinduoduoAccountForm.test.js src/modules/channels/channelEvents.test.js src/modules/navigation/channelNavigation.test.js`

Expected: FAIL because Pinduoduo form and navigation are absent.

- [x] **Step 3: Add password fields and route-driven shared event copy**

```js
const channelPresentation = computed(() => ({
  douyin: { eyebrow: 'DOUYIN COMMERCE', title: '抖店业务消息' },
  pinduoduo: { eyebrow: 'PINDUODUO COMMERCE', title: '拼多多业务消息' }
}[route.meta.channelCode]))

const channelCode = computed(() => route.meta.channelCode)
getChannelEventAccounts({ channel: channelCode.value })
getChannelEvents(buildChannelEventQuery({ ...filters, channel: channelCode.value, page: page.value, pageSize: pageSize.value }))
```

The account dialog uses password inputs with `autocomplete=off`, never repopulates secrets after submit, and shows order/after-sales capability tags plus the customer-chat limitation. Add expandable Pinduoduo menu and `/pinduoduo/events`, `/pinduoduo/accounts` routes.

- [x] **Step 4: Run tests and production build**

Run: `node --test src/modules/channels/*.test.js src/modules/navigation/*.test.js`

Run: `npm run build`

Expected: tests PASS and Vite build succeeds.

### Task 6: Local end-to-end verification and operations

**Files:**
- Create: `docs/operations/pinduoduo-commerce.md`
- Modify: `docs/superpowers/plans/2026-07-25-pinduoduo-commerce-sync.md`

- [x] **Step 1: Restart local services and verify schema/seed**

Run: `powershell -ExecutionPolicy Bypass -File tools/local-deploy/start-local-platform.ps1`

Expected: MySQL, backend, frontend, Redis and gateway health checks succeed; `pinduoduo` is active with adapter `pinduoduo_commerce`; `channel_sync_state` exists.

- [x] **Step 2: Execute a local contract flow with injected official-shaped responses**

Use a uniquely marked temporary account and mock only the fixed outbound gateway response. Verify order first sync, duplicate sync, two-page sync, refund sync, malformed response failure, API error failure, cursor non-advancement and account isolation. Delete only rows carrying that unique marker.

- [x] **Step 3: Run full related regression tests**

Run: `node --test src/modules/channel-capabilities/*.test.js src/modules/channel-adapters/douyin-commerce/*.test.js src/modules/channel-adapters/pinduoduo-commerce/*.test.js src/modules/channel-events/*.test.js src/modules/channel-sync/*.test.js src/routes/channelAccounts.presenter.test.js src/workers/pinduoduoSyncWorker.test.js`

Run: `node --test src/modules/channels/*.test.js src/modules/navigation/*.test.js && npm run build`

Expected: all tests PASS; only pre-existing Sass or chunk-size warnings are allowed.

- [x] **Step 4: Verify desktop and mobile in a real browser**

Check expandable Pinduoduo navigation, business event list, account form, credential non-echo, detail drawer, error/retry states and horizontal scrolling at desktop and mobile widths. Confirm no reply box or send button appears.

- [x] **Step 5: Document production prerequisites**

Document Client ID, Client Secret, per-store Access Token, required order/refund scopes, 30-minute incremental window, one-token-per-account isolation, token renewal, fixed HTTPS gateway, cursor recovery and the explicit absence of buyer customer-chat APIs.
