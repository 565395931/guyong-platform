# 客户画像与智能复联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有左侧导航的前提下，增加按自然日统计的客户沟通标签、每日客户报表、成交后 AI 复联任务和三层角色数据隔离。

**Architecture:** 在 `rag-server` 新增 customer-operations 领域模块，负责身份映射、沟通日幂等、成交任务、AI 结构化输出和日报聚合；消息与订单流程只发出异步领域更新。`/v1/customers` 路由在 SQL 层统一应用角色范围，`platform-web` 在现有客户列表/画像内容区增加报表和时间线，不修改侧栏。

**Tech Stack:** Node.js CommonJS、Express、Sequelize raw SQL、MySQL、Node `node:test`、Vue 3、Element Plus、ECharts。

---

### Task 1: 建立沟通阶段和角色范围纯函数

**Files:**
- Create: `rag-server/src/modules/customer-operations/communicationRules.js`
- Test: `rag-server/src/modules/customer-operations/communicationRules.test.js`

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  stageForCommunicationIndex,
  localDateKey,
  buildVisibilityPredicate
} = require('./communicationRules')

test('maps daily communication index to first, second, third and nth labels', () => {
  assert.deepEqual([1, 2, 3, 4].map(stageForCommunicationIndex), [
    { code: 'first', label: '首次沟通' },
    { code: 'second', label: '二次沟通' },
    { code: 'third', label: '三次沟通' },
    { code: 'nth', label: '第4次沟通' }
  ])
})

test('uses the configured timezone date for the communication day', () => {
  assert.equal(localDateKey('2026-08-03T15:30:00.000Z', 'Asia/Shanghai'), '2026-08-03')
})

test('ordinary users are scoped to owned conversations while supervisors see all', () => {
  assert.match(buildVisibilityPredicate({ role: 'user', id: 7 }).sql, /claimed_by = :viewerId/)
  assert.equal(buildVisibilityPredicate({ role: 'supervisor', id: 7 }).sql, '1=1')
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test src/modules/customer-operations/communicationRules.test.js` from `rag-server`.

Expected: FAIL because `communicationRules.js` does not exist.

- [ ] **Step 3: Implement the minimal pure functions**

```js
const STAGES = [
  { code: 'first', label: '首次沟通' },
  { code: 'second', label: '二次沟通' },
  { code: 'third', label: '三次沟通' }
]

function stageForCommunicationIndex(index) {
  const n = Math.max(1, Number(index) || 1)
  return STAGES[n - 1] || { code: 'nth', label: `第${n}次沟通` }
}

function localDateKey(value, timeZone = process.env.APP_TIMEZONE || 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value))
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`
}

function buildVisibilityPredicate(user, alias = 'c') {
  if (['admin', 'supervisor'].includes(user?.role)) return { sql: '1=1', replacements: {} }
  return {
    sql: `(${alias}.claimed_by = :viewerId OR ${alias}.agent_id = :viewerId)`,
    replacements: { viewerId: Number(user?.id || user?.userId) }
  }
}

module.exports = { stageForCommunicationIndex, localDateKey, buildVisibilityPredicate }
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test src/modules/customer-operations/communicationRules.test.js`.

Expected: all 3 tests pass.

### Task 2: Add idempotent customer operations tables and repository

**Files:**
- Modify: `rag-server/src/config/database.js` after the existing `customers` migration
- Create: `rag-server/src/modules/customer-operations/customerOperations.repository.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.repository.test.js`

- [ ] **Step 1: Write repository tests for identity lookup and daily upsert**

Use a fake `sequelize.query` that records SQL and returns controlled rows. Assert that identity lookup uses `(channel, account_id, external_user_id)`, daily writes use `ON DUPLICATE KEY UPDATE`, and repeated order status writes use a unique `(order_id, type)` key.

- [ ] **Step 2: Run the repository test to see the expected failure**

Run: `node --test src/modules/customer-operations/customerOperations.repository.test.js`.

Expected: FAIL because the repository module is missing.

- [ ] **Step 3: Add idempotent migrations**

Create `customer_identities`, `customer_communication_days`, `customer_followups`, `customer_daily_reports`, and `customer_ai_audit_logs` using the exact columns from the design spec. Add `display_name`, `owner_id`, `won_status`, `won_at`, `ai_profile`, and `ai_profile_updated_at` to `customers` with the existing try/catch `ALTER TABLE` pattern. Add unique keys for identity, customer/date, report scope, and order/type.

- [ ] **Step 4: Implement repository methods**

Export methods with stable signatures:

```js
findOrCreateCustomerIdentity(identity, transaction)
upsertCommunicationDay(input, transaction)
resequenceCommunicationStages(customerId, transaction)
createWonFollowupIfMissing(input, transaction)
listFollowups(customerId, visibility, transaction)
writeDailyReport(input, transaction)
appendAiAuditLog(input, transaction)
```

All methods must use replacements, never interpolate user values into SQL.

- [ ] **Step 5: Run focused repository tests**

Run: `node --test src/modules/customer-operations/customerOperations.repository.test.js`.

Expected: all repository assertions pass.

### Task 3: Implement communication, order and visibility service

**Files:**
- Create: `rag-server/src/modules/customer-operations/customerOperations.service.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.service.test.js`

- [ ] **Step 1: Write failing behavior tests**

Cover these cases with injected repository and clock dependencies:

```js
test('thirty messages on one day create one communication day', async () => {
  const repo = createRecordingRepository()
  const service = createCustomerOperationsService({ repository: repo, now: () => '2026-08-03T08:00:00Z' })
  await Promise.all(Array.from({ length: 30 }, () => service.recordMessage({
    channel: 'whatsapp', accountId: 2, externalUserId: 'u1', direction: 'inbound', senderType: 'customer'
  })))
  assert.equal(repo.communicationDays.length, 1)
  assert.equal(repo.communicationDays[0].messageCount, 30)
})

function createRecordingRepository() {
  const communicationDays = []
  const followups = []
  return {
    communicationDays,
    followups,
    async findOrCreateCustomerIdentity() { return { customerId: 'customer-1' } },
    async upsertCommunicationDay(input) {
      let row = communicationDays.find(item => item.customerId === input.customerId && item.communicationDate === input.communicationDate)
      if (!row) {
        row = { ...input, messageCount: 0 }
        communicationDays.push(row)
      }
      row.messageCount += 1
      return row
    },
    async resequenceCommunicationStages() {},
    async createWonFollowupIfMissing(input) {
      if (!followups.some(item => item.orderId === input.orderId && item.type === input.type)) followups.push(input)
      return input
    },
    async markAiRecomputeNeeded() {}
  }
}

test('paid order creates one first follow-up and second follow-up remains idempotent', async () => {
  const repo = createRecordingRepository()
  const service = createCustomerOperationsService({ repository: repo, now: () => '2026-08-03T08:00:00Z' })
  await service.applyOrderStatus({ orderId: 'o1', status: 'paid', customer: { phone: '13800000000' } })
  await service.applyOrderStatus({ orderId: 'o1', status: 'paid', customer: { phone: '13800000000' } })
  assert.equal(repo.followups.filter(item => item.type === 'won_first').length, 1)
})
```

- [ ] **Step 2: Run the focused service test and verify it fails**

Run: `node --test src/modules/customer-operations/customerOperations.service.test.js`.

Expected: FAIL because `customerOperations.service.js` is missing.

- [ ] **Step 3: Implement the service with injected dependencies**

Implement `recordMessage`, `applyOrderStatus`, `getVisibleCustomerScope`, `getProfileData`, `buildDailyReportData`, and `markAiRecomputeNeeded`. Count only inbound customer and outbound agent messages, normalize the date with `localDateKey`, and re-sequence stages after each new communication day. Use repository idempotency for concurrent calls.

- [ ] **Step 4: Verify service tests pass**

Run: `node --test src/modules/customer-operations/customerOperations.service.test.js`.

Expected: all focused service tests pass.

### Task 4: Add structured AI decision service and timer

**Files:**
- Create: `rag-server/src/modules/customer-operations/customerAi.service.js`
- Create: `rag-server/src/modules/customer-operations/customerOperations.timer.js`
- Test: `rag-server/src/modules/customer-operations/customerAi.service.test.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.timer.test.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Write failing AI contract tests**

Assert that valid JSON is normalized, confidence is clamped/rejected, unknown follow-up types are rejected, and provider failures return a +10-day first reminder or +15-day second reminder without changing a human-locked due date.

- [ ] **Step 2: Run AI tests and verify RED**

Run: `node --test src/modules/customer-operations/customerAi.service.test.js`.

Expected: FAIL because the AI service is missing.

- [ ] **Step 3: Implement provider adapter and safe fallback**

Expose `createCustomerAiService({ provider, repository, now })` with `decide(input)`. The provider receives the JSON input and a strict JSON-only prompt. Validate output with the existing `zod` dependency, limit summary/evidence lengths, and return `{ source: 'ai' | 'fallback', ... }`. Never overwrite `overridden_by` tasks.

- [ ] **Step 4: Write timer lifecycle tests and implement timer**

The timer must prevent overlapping ticks, call one injected `runPendingWork` per interval, call `.unref()` when available, and expose `startCustomerOperationsTimer`/`stopCustomerOperationsTimer`. The default interval is 60 seconds.

- [ ] **Step 5: Start the timer from app startup**

Import the timer beside `startPoolTimers` and start it after the HTTP server begins listening. In `NODE_ENV=test`, do not create a real interval. Timer errors go to `systemLogger` and do not terminate the process.

- [ ] **Step 6: Run AI and timer tests**

Run: `node --test src/modules/customer-operations/customerAi.service.test.js src/modules/customer-operations/customerOperations.timer.test.js`.

Expected: all tests pass.

### Task 5: Hook message and order events into customer operations

**Files:**
- Modify: `rag-server/src/modules/messaging/messaging.service.js`
- Modify: `rag-server/src/routes/orders.js`
- Modify: `rag-server/src/modules/messaging/inboundMessage.service.js` only if the existing post-store hook is required to pass the normalized message shape
- Test: `rag-server/src/modules/customer-operations/customerOperations.events.test.js`

- [ ] **Step 1: Write failing event-hook tests**

Inject a fake customer operations service and assert that persisted inbound/customer and outbound/agent messages call `recordMessage`, AI outbound does not, and an order transition to `paid`, `delivered`, or `closed` calls `applyOrderStatus` exactly once per request.

- [ ] **Step 2: Run event tests and confirm RED**

Run: `node --test src/modules/customer-operations/customerOperations.events.test.js`.

Expected: FAIL because no hook is installed.

- [ ] **Step 3: Add non-blocking hooks after successful persistence**

Require the service once at module scope, invoke it after the `INSERT INTO plat_messages` succeeds, and use `void service.recordMessage(...).catch(logger)` so customer analytics cannot make channel delivery fail. Add the order hook after the order update commits and pass both old/new status to preserve idempotency.

- [ ] **Step 4: Run the event test and the existing messaging/order tests**

Run: `node --test src/modules/customer-operations/customerOperations.events.test.js src/modules/messaging/*.test.js src/routes/*.test.js`.

Expected: new and existing tests pass.

### Task 6: Extend customer APIs with role-safe reports, profiles and follow-ups

**Files:**
- Modify: `rag-server/src/routes/customers.js`
- Test: `rag-server/src/routes/customers.customer-operations.test.js`

- [ ] **Step 1: Write failing route tests**

Use the existing JWT secret and an injected/fake service boundary to assert: ordinary user requests only include their owner predicate; supervisor/admin requests include all; unauthorized profile IDs return 404; daily report and follow-up actions validate dates, statuses and IDs.

- [ ] **Step 2: Run route tests and verify RED**

Run: `node --test src/routes/customers.customer-operations.test.js`.

Expected: FAIL because the new endpoints are absent.

- [ ] **Step 3: Add server-side scope and endpoints**

Keep existing customer CRUD behavior compatible. Add `GET /daily-report`, `POST /daily-report/regenerate`, and profile/follow-up operations from the design spec. Return `data.report`, `data.customers`, `data.communicationDays`, `data.followups`, and `data.aiProfile`. Apply visibility in every repository query; never trust `owner_id` supplied by the browser.

- [ ] **Step 4: Protect deletion and preserve history**

Before `DELETE /:id`, query for linked conversations/orders/followups. Return `409` with a clear message when history exists; otherwise delete the standalone manual customer. Add tests for both paths.

- [ ] **Step 5: Run route tests**

Run: `node --test src/routes/customers.customer-operations.test.js`.

Expected: all route tests pass.

### Task 7: Add frontend API helpers and report normalization tests

**Files:**
- Modify: `platform-web/src/api/customers.js`
- Create: `platform-web/src/modules/customers/customerReport.js`
- Test: `platform-web/src/modules/customers/customerReport.test.js`

- [ ] **Step 1: Write failing normalization tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDailyReport, stageLabel } from './customerReport.js'

test('normalizes missing AI fields without losing deterministic counts', () => {
  const report = normalizeDailyReport({ first_count: '2', customer_count: '30', details: null })
  assert.equal(report.customerCount, 30)
  assert.equal(report.firstCount, 2)
  assert.deepEqual(report.details, [])
})

test('maps communication stage codes to Chinese labels', () => {
  assert.equal(stageLabel('first'), '首次沟通')
  assert.equal(stageLabel('nth', 4), '第4次沟通')
})
```

- [ ] **Step 2: Run the frontend test and confirm RED**

Run: `node --test src/modules/customers/customerReport.test.js` from `platform-web`.

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement normalization and API calls**

Add `getDailyCustomerReport`, `regenerateDailyCustomerReport`, `markCustomerWon`, `completeCustomerFollowup`, `skipCustomerFollowup`, and `updateCustomerFollowup` to `api/customers.js`. Keep response unwrapping consistent with `api/index.js`.

- [ ] **Step 4: Run the module test**

Run: `node --test src/modules/customers/customerReport.test.js`.

Expected: all frontend module tests pass.

### Task 8: Add the daily report to the existing customer page

**Files:**
- Modify: `platform-web/src/views/Customers/CustomersView.vue`
- Test: `platform-web/src/modules/navigation/channelNavigation.test.js` (assert the existing `/customers` route remains unchanged)

- [ ] **Step 1: Add content-area tabs without touching the sidebar**

Keep the existing customer list as the default tab and add a local `activeView` state with `customers` and `daily-report`. Do not modify `AppSidebar.vue`, `channelNavigation.js`, route paths, or menu labels.

- [ ] **Step 2: Add report loading and role-aware filters**

Use `useUserStore()` to hide the owner filter for `user`/`agent`, show it for `supervisor`/`admin`, and pass only allowed filter values to the API. The date picker defaults to the local current date. Loading and retry states must preserve the existing page height behavior.

- [ ] **Step 3: Render KPI cards, stage distribution and customer details**

Use stable grid tracks and compact cards. Render each customer detail with a stage tag, owner, AI summary fallback, next follow-up, and links to `/customers/:id/profile` and the current conversation route. No decorative hero or new navigation panel.

- [ ] **Step 4: Verify frontend build and navigation tests**

Run: `node --test src/modules/navigation/channelNavigation.test.js` and `npm run build` from `platform-web`.

Expected: navigation tests pass and Vite exits with code 0.

### Task 9: Extend the customer profile with communication and follow-up timelines

**Files:**
- Modify: `platform-web/src/views/Customers/CustomerProfileView.vue`
- Modify: `platform-web/src/api/customers.js` if profile action payloads need explicit helpers

- [ ] **Step 1: Add profile data sections**

Keep current order KPIs/charts. Add a communication card with current stage, total communication days and AI signals; add a chronological communication-day timeline; add a follow-up timeline with due/overdue/completed states.

- [ ] **Step 2: Add role-aware actions**

Render mark-won and follow-up controls for the current owner, supervisor and admin; hide mutation controls for a read-only user viewing an inaccessible customer. Date edits require an explicit timestamp and optional reason, then refresh the profile.

- [ ] **Step 3: Handle empty, pending-AI and error states**

Show deterministic communication statistics when AI summary is absent, a retry action when profile loading fails, and a non-blocking “AI 分析处理中” state while the timer has not completed.

- [ ] **Step 4: Run production build**

Run: `npm run build` from `platform-web`.

Expected: Vite exits with code 0 and no unresolved imports.

### Task 10: Full verification and regression check

**Files:**
- Test: all files listed above

- [ ] **Step 1: Run all backend tests**

Run: `npm test` from `rag-server`.

Expected: exit code 0 and no failed tests.

- [ ] **Step 2: Run all frontend tests and build**

Run: `npm run test:channel-navigation; npm run test:message-review; npm run test:ai-config; npm run build` from `platform-web`.

Expected: all test commands and build exit 0.

- [ ] **Step 3: Inspect the final diff and verify sidebar invariants**

Run: `rg -n "AppSidebar|channelNavigation|/customers" platform-web/src` and inspect `git diff --stat` where a Git repository is available. Confirm no sidebar file or existing route path was modified, and confirm the migration is additive and idempotent.

- [ ] **Step 4: Record limitations**

If a live AI provider or MySQL instance is unavailable, record that integration verification was not run; unit tests must still prove deterministic fallback, role isolation, and idempotency.
