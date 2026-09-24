# Customer Conversation Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect customer management and daily reports to exact conversations through a role-safe unified customer context and an on-demand customer drawer, without changing the existing left sidebar.

**Architecture:** Extend the existing `customer-operations` domain with durable event idempotency, versioned customer context, report snapshots, and object-level authorization. The frontend deep-links by conversation ID, independently loads conversations outside the current pool, and renders one reusable customer drawer inside the existing workbench.

**Tech Stack:** Node.js CommonJS, Express, Sequelize raw SQL, MySQL, `node:test`, Vue 3, Pinia, Element Plus, ECharts, Vite.

**Execution note:** `E:\project\project\Rag` currently has no Git metadata, so commit steps are replaced by focused test checkpoints. Do not initialize Git unless the user explicitly requests it.

---

### Task 1: Centralize Authentication and Close Existing IDOR Paths

**Files:**
- Create: `rag-server/src/middleware/authenticate.js`
- Create: `rag-server/src/middleware/authenticate.test.js`
- Modify: `rag-server/src/config/jwt.js`
- Modify: `rag-server/src/routes/customers.js`
- Modify: `rag-server/src/routes/conversations.js`
- Test: `rag-server/src/routes/customerAuthorization.test.js`
- Test: `rag-server/src/routes/conversationAuthorization.test.js`

- [ ] **Step 1: Write failing JWT configuration tests**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveJwtConfig } = require('../config/jwt')

test('rejects a missing JWT secret outside explicit tests', () => {
  assert.throws(() => resolveJwtConfig({ NODE_ENV: 'development' }), /JWT_SECRET/)
})

test('accepts an explicitly injected test secret', () => {
  assert.equal(resolveJwtConfig({ NODE_ENV: 'test', JWT_SECRET: 'test-secret' }).secret, 'test-secret')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `rag-server`: `node --test src/middleware/authenticate.test.js`

Expected: FAIL because `resolveJwtConfig` and the middleware do not exist.

- [ ] **Step 3: Implement one authentication middleware**

```js
const jwt = require('jsonwebtoken')
const { User } = require('../models')
const { resolveJwtConfig } = require('../config/jwt')

function createAuthenticate({ findUser = id => User.findByPk(id), environment = process.env } = {}) {
  const config = resolveJwtConfig(environment)
  return async function authenticate(req, res, next) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ success: false, message: '未提供认证令牌' })
    try {
      const claims = jwt.verify(token, config.secret, {
        algorithms: ['HS256'], issuer: config.issuer, audience: config.audience
      })
      const user = await findUser(claims.id || claims.userId)
      if (!user || user.status !== 'active') {
        return res.status(401).json({ success: false, message: '账号不可用' })
      }
      req.user = { id: user.id, username: user.username, role: user.role === 'user' ? 'agent' : user.role }
      next()
    } catch {
      return res.status(401).json({ success: false, message: '认证失败' })
    }
  }
}

module.exports = { createAuthenticate }
```

`resolveJwtConfig` must require a secret in every environment, except tests that explicitly pass one. It must return `{ secret, issuer: 'rag-server', audience: 'platform-web' }`.

- [ ] **Step 4: Replace route-local JWT verification and close old write paths**

Use `router.use(authenticate)` in customer and conversation routes. In customer `PUT/PATCH/DELETE`, require the same `customerVisibility` predicate used by reads. In conversation routes:

```js
if (agent_id !== undefined && !['supervisor', 'admin'].includes(req.user.role)) {
  return res.status(403).json({ success: false, message: '仅主管或管理员可重新分配负责人' })
}
```

Apply the same role rule to `/:id/assign`, `/:id/transfer`, and `claim` requests containing a target seat ID. Validate that the target user is active, has role `agent`, belongs to the allowed team/account scope, and return 404 for inaccessible conversations.

Restrict batch avatar backfill and full history synchronization to administrators or explicitly authorized supervisors with account scope. Restrict job-status reads to the creator, an authorized supervisor, or an administrator. Add per-user rate limits, concurrency caps, and audit events to these global side-effect endpoints.

- [ ] **Step 5: Add route-level authorization matrix tests**

Test `agent`, legacy `user`, `supervisor`, and `admin` for own/other customers and conversations. Assert agents receive 404 for foreign objects and 403 for assignment commands. Assert disabled users receive 401.

- [ ] **Step 6: Run the security checkpoint**

Run: `node --test src/middleware/authenticate.test.js src/routes/customerAuthorization.test.js src/routes/conversationAuthorization.test.js src/routes/auth.test.js`

Expected: all tests pass; no response includes JWT parser errors or stack traces.

### Task 2: Add Stable Customer Links, Versions, Audit, and Durable Events

**Files:**
- Modify: `rag-server/src/config/database.js`
- Modify: `rag-server/src/modules/customer-operations/customerOperations.repository.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.repository.test.js`
- Create: `rag-server/src/modules/customer-operations/customerOperationEvents.repository.js`
- Test: `rag-server/src/modules/customer-operations/customerOperationEvents.repository.test.js`

- [ ] **Step 1: Write failing migration/source tests**

Assert the migration contains these additive structures:

```js
for (const table of [
  'customer_communication_events', 'customer_operation_events', 'customer_tags',
  'customer_profile_corrections', 'customer_audit_logs', 'customer_daily_report_revisions'
]) assert.match(databaseSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))

assert.match(databaseSource, /ALTER TABLE orders ADD COLUMN customer_id/)
assert.match(databaseSource, /ALTER TABLE customers ADD COLUMN version/)
assert.match(databaseSource, /normalized_account_key/)
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `node --test src/modules/customer-operations/customerOperations.repository.test.js src/modules/customer-operations/customerOperationEvents.repository.test.js`

Expected: FAIL because the new tables and repository are absent.

- [ ] **Step 3: Add idempotent migrations**

Add UUID primary keys and indexed foreign IDs. Required unique keys:

```sql
UNIQUE KEY uk_customer_message_event (message_id, event_type),
UNIQUE KEY uk_customer_operation_event (event_key),
UNIQUE KEY uk_customer_identity_normalized (channel, normalized_account_key, external_user_id),
UNIQUE KEY uk_report_revision (report_date, scope_type, scope_id, revision)
```

Use a non-null normalized account key such as `COALESCE(CAST(account_id AS CHAR), '__none__')`. Add `orders.customer_id`, `customers.version`, `customer_followups.version`, source conversation/owner columns for AI evidence and report details. Migrations remain additive and rerunnable.

- [ ] **Step 4: Implement the durable event repository**

```js
function createCustomerOperationEventsRepository({ sequelize }) {
  async function enqueue(input, transaction) {
    return sequelize.query(
      `INSERT INTO customer_operation_events
       (id, event_key, event_type, payload, status, attempts, available_at, created_at, updated_at)
       VALUES (:id, :eventKey, :eventType, CAST(:payload AS JSON), 'pending', 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE event_key = event_key`,
      { replacements: input, transaction }
    )
  }
  async function claimBatch({ workerId, limit, leaseUntil }, transaction) {
    const [rows] = await sequelize.query(
      `SELECT id FROM customer_operation_events
       WHERE status IN ('pending','retry') AND available_at <= NOW()
         AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY available_at, created_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { replacements: { limit: Math.min(Math.max(Number(limit) || 20, 1), 100) }, transaction }
    )
    if (!rows.length) return []
    const ids = rows.map(row => row.id)
    await sequelize.query(
      `UPDATE customer_operation_events
       SET status='processing', worker_id=:workerId, lease_until=:leaseUntil, updated_at=NOW()
       WHERE id IN (:ids)`,
      { replacements: { workerId, leaseUntil, ids }, transaction }
    )
    return ids
  }
  async function complete(id, transaction) {
    return sequelize.query(
      `UPDATE customer_operation_events
       SET status='completed', worker_id=NULL, lease_until=NULL, updated_at=NOW() WHERE id=:id`,
      { replacements: { id }, transaction }
    )
  }
  async function retry(id, errorCode, availableAt, transaction) {
    return sequelize.query(
      `UPDATE customer_operation_events
       SET status='retry', attempts=attempts+1, last_error_code=:errorCode,
           available_at=:availableAt, worker_id=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=:id`,
      { replacements: { id, errorCode, availableAt }, transaction }
    )
  }
  return { enqueue, claimBatch, complete, retry }
}
```

Implement `claimBatch` with parameterized SQL, a bounded limit, and a database lease. Do not rely on the existing process-local `running` flag for correctness.

- [ ] **Step 5: Move order linkage to stable customer IDs**

Backfill only unique identity matches. Ambiguous phone matches remain `NULL` and are reported as `bindingStatus: 'needs_review'`. Change customer profile/order queries to use `orders.customer_id = :customerId`; never return order details through phone-only joins.

- [ ] **Step 6: Run the data checkpoint**

Run: `node --test src/modules/customer-operations/customerOperations.repository.test.js src/modules/customer-operations/customerOperationEvents.repository.test.js`

Expected: all SQL assertions pass, including null-account identity uniqueness and stable order linkage.

### Task 3: Make Message and Order Customer Updates Transactional and Idempotent

**Files:**
- Modify: `rag-server/src/modules/messaging/messaging.service.js`
- Modify: `rag-server/src/routes/orders.js`
- Modify: `rag-server/src/modules/customer-operations/customerOperations.events.js`
- Modify: `rag-server/src/modules/customer-operations/customerOperations.worker.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.events.test.js`
- Test: `rag-server/src/modules/customer-operations/customerOperations.worker.test.js`

- [ ] **Step 1: Write failing duplicate-event tests**

```js
test('replaying one message event increments the day once', async () => {
  await handler.handle({ eventKey: 'message:m1:communication', messageId: 'm1' })
  await handler.handle({ eventKey: 'message:m1:communication', messageId: 'm1' })
  assert.equal(repo.communicationDeltaFor('m1'), 1)
})

test('paid order transaction enqueues one won command', async () => {
  await updateOrder('o1', 'paid', 'idem-order-1')
  await updateOrder('o1', 'paid', 'idem-order-1')
  assert.equal(events.count('order:o1:paid'), 1)
})
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test src/modules/customer-operations/customerOperations.events.test.js src/modules/customer-operations/customerOperations.worker.test.js`

- [ ] **Step 3: Write outbox events in the source transaction**

After a message or order mutation succeeds, call `enqueue(..., transaction)` before commit. The event handler first inserts into `customer_communication_events`; only a newly inserted event may increment `message_count`.

- [ ] **Step 4: Add worker lease and optimistic AI writeback**

Claim events through the repository lease. Each AI job reads `customers.version` before generation and updates with:

```sql
UPDATE customers
SET ai_profile = CAST(:profile AS JSON), version = version + 1, updated_at = NOW()
WHERE id = :customerId AND version = :expectedVersion
```

If affected rows are zero, append a stale-result audit event and do not overwrite the newer profile.

- [ ] **Step 5: Run event and worker tests**

Expected: replay, concurrent first-message, expired lease, stale AI writeback, and provider-failure tests pass.

### Task 4: Build the Unified Customer Workspace Context

**Files:**
- Create: `rag-server/src/modules/customer-operations/customerWorkspace.repository.js`
- Create: `rag-server/src/modules/customer-operations/customerWorkspace.service.js`
- Test: `rag-server/src/modules/customer-operations/customerWorkspace.service.test.js`
- Modify: `rag-server/src/routes/customers.js`
- Modify: `rag-server/src/routes/conversations.js`
- Test: `rag-server/src/routes/customerWorkspace.routes.test.js`

- [ ] **Step 1: Write failing service contract tests**

```js
assert.deepEqual(context.permissions, {
  view: true, editProfile: true, manageFollowups: true,
  reassignOwner: false, linkConversation: false, viewAudit: false
})
assert.equal(context.activeConversation.id, 'conv-1')
assert.equal(context.communicationStage.code, 'second')
assert.equal(context.followups.every(item => item.ownerId === viewer.id), true)
```

Add a second test proving an agent cannot receive evidence sourced from another owner's conversation.

- [ ] **Step 2: Run and verify RED**

Run: `node --test src/modules/customer-operations/customerWorkspace.service.test.js src/routes/customerWorkspace.routes.test.js`

- [ ] **Step 3: Implement repository projections**

Expose focused methods:

```js
findCustomerByConversation(conversationId, scope)
findCustomer(customerId, scope)
listVisibleCommunicationDays(customerId, scope, pagination)
listVisibleFollowups(customerId, scope, pagination)
listVisibleOrders(customerId, scope, pagination)
listProfileChanges(customerId, scope, pagination)
```

Every derived record carries `sourceConversationId` and `ownerId`. Apply scope before pagination.

- [ ] **Step 4: Implement light and full contexts**

```js
async function getConversationContext({ conversationId, viewer }) {
  const scope = authorization.customerScope(viewer)
  const customer = await repository.findCustomerByConversation(conversationId, scope)
  if (!customer) return null
  return {
    customer,
    activeConversation: customer.activeConversation,
    communicationStage: await repository.getStage(customer.id, scope),
    aiProfile: await repository.getVisibleAiProfile(customer.id, scope),
    followups: await repository.listVisibleFollowups(customer.id, scope, { limit: 5 }),
    orders: await repository.listVisibleOrders(customer.id, scope, { limit: 3 }),
    permissions: authorization.permissions(viewer, customer),
    generatedAt: new Date().toISOString()
  }
}
```

The customer endpoint adds paginated timeline and audit data. Return field-level permissions from the server, but enforce authorization again on writes.

- [ ] **Step 5: Add endpoints**

Add `GET /conversations/:id/customer-context` and `GET /customers/:id/workspace-context`. Validate UUID/string IDs, bounded pagination, and `conversation_id`. Return 404 for inaccessible objects.

- [ ] **Step 6: Run context tests**

Expected: own/other identity, multi-owner customer, order binding, derived evidence, and 404 tests pass.

### Task 5: Add Atomic Customer Commands and Audit History

**Files:**
- Create: `rag-server/src/modules/customer-operations/customerCommands.service.js`
- Test: `rag-server/src/modules/customer-operations/customerCommands.service.test.js`
- Modify: `rag-server/src/routes/customers.js`
- Test: `rag-server/src/routes/customerCommands.routes.test.js`

- [ ] **Step 1: Write failing state-transition and idempotency tests**

Cover manual follow-up creation, owner reassignment, tag add/remove, profile correction/undo, conversation link conflict, won transition, complete/skip/adjust follow-up, and identical `Idempotency-Key` replay.

- [ ] **Step 2: Define command input schemas**

Use Zod with these core shapes:

```js
const versioned = z.object({ expectedVersion: z.number().int().nonnegative() })
const followupCreate = versioned.extend({
  dueAt: z.string().datetime(), reason: z.string().trim().min(1).max(500),
  conversationId: z.string().trim().min(1).optional()
})
const profileCorrection = versioned.extend({
  field: z.enum(['intent','priceSensitivity','decisionPace','communicationStyle']),
  value: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(500)
})
```

- [ ] **Step 3: Implement one transaction per command**

Each command checks authorization and version, performs a legal state transition, appends `customer_audit_logs`, enqueues an outbox event, and commits atomically. Return `409` with the current version on conflicts. Scope idempotency by user, route, target, and key.

- [ ] **Step 4: Add routes**

Implement the approved owner, tag, manual follow-up, profile correction/undo, audit, and conversation-link endpoints. Existing won/follow-up endpoints delegate to the command service rather than issuing raw multi-step queries.

- [ ] **Step 5: Run command tests**

Run: `node --test src/modules/customer-operations/customerCommands.service.test.js src/routes/customerCommands.routes.test.js`

Expected: transaction rollback, replay, version conflict, role matrix, and audit assertions pass.

### Task 6: Persist Live and Snapshot Daily Reports

**Files:**
- Create: `rag-server/src/modules/customer-operations/customerReports.service.js`
- Test: `rag-server/src/modules/customer-operations/customerReports.service.test.js`
- Create: `rag-server/src/modules/customer-operations/customerReportExport.service.js`
- Test: `rag-server/src/modules/customer-operations/customerReportExport.service.test.js`
- Modify: `rag-server/src/routes/customers.js`
- Modify: `platform-web/src/modules/customers/customerReport.js`
- Test: `platform-web/src/modules/customers/customerReport.test.js`

- [ ] **Step 1: Write failing report tests**

Assert today's report has `mode: 'live'`; a past date reads the saved revision; due customers with no same-day chat appear in the action list; owner transfer removes the customer from the old owner's current view; regeneration creates revision `n + 1`.

- [ ] **Step 2: Implement deterministic metrics and snapshots**

Return:

```js
{
  mode: 'live', revision: 0, generatedAt, asOf,
  metrics: { customerCount, firstCount, secondCount, thirdCount, wonCount,
    dueCount, overdueCount, followupCompletionRate, intentRaisedCount,
    intentLoweredCount, inactiveCount },
  stageDistribution: [], intentDistribution: [], ownerDistribution: [], details: []
}
```

Build the action list from the union of communication days and active follow-ups, not only customers who chatted today. Snapshot rows store immutable JSON; reads filter detail rows against current authorization.

- [ ] **Step 3: Extend routes and normalization**

Validate `YYYY-MM-DD`, owner scope, pagination, and filters. `POST /daily-report/regenerate` requires an idempotency key and writes an audit event. Extend frontend normalization without dropping existing fields.

Add `POST /daily-report/export` to create a short-lived, unguessable export token bound to the requesting user, role, filters, report revision, and a field whitelist. Add authenticated `GET /daily-report/export/:token` to recheck current authorization and return only redacted export data. Audit creation and download with record count; expire tokens after five minutes and never return a public URL.

- [ ] **Step 4: Run report and export tests**

Expected: live/snapshot/revision, no-chat due task, current-permission filtering, token expiry, reassignment-before-download, redaction, and legacy response compatibility pass.

### Task 7: Add Exact Conversation Deep Links and State Restoration

**Files:**
- Create: `platform-web/src/modules/platformMessages/conversationDeepLink.js`
- Test: `platform-web/src/modules/platformMessages/conversationDeepLink.test.js`
- Modify: `platform-web/src/views/PlatformMessages/PlatformMessagesView.vue`
- Modify: `platform-web/src/views/Workbench/WorkbenchView.vue`
- Modify: `platform-web/src/components/Conversation/ConversationList.vue`
- Modify: `platform-web/src/api/conversations.js`
- Modify: `platform-web/src/views/Customers/CustomersView.vue`
- Modify: `platform-web/src/views/Customers/CustomerProfileView.vue`

- [ ] **Step 1: Write failing deep-link tests**

```js
assert.deepEqual(normalizeConversationDeepLink({
  conversation: 'c1', customer: 'u1', panel: 'customer', return: 'report:abc'
}), { conversationId: 'c1', customerId: 'u1', openCustomerPanel: true, returnKey: 'report:abc' })
assert.equal(buildConversationQuery({ conversationId: 'c1' }).conversation, 'c1')
```

Also assert arbitrary URLs are rejected as return keys.

- [ ] **Step 2: Preserve deep-link parameters**

`PlatformMessagesView.syncQuery()` must merge controlled keys instead of rebuilding only channel/account/view. Pass `targetConversationId` and `openCustomerPanel` into `WorkbenchView`.

- [ ] **Step 3: Independently load the target conversation**

In `WorkbenchView`, call `getConversation(id)` when the target is absent from `conversationStore.list`, validate the expected customer ID through the context response, then call `selectConversation`. This works for archived, another pool, another page, and an account-filtered-out conversation.

- [ ] **Step 4: Add state restoration**

Create a session-scoped return-state map keyed by a random `return` token. Store date, filters, page, and scroll position before navigation; consume it once when returning. Never store an arbitrary URL.

- [ ] **Step 5: Run deep-link and navigation tests**

Run: `node --test src/modules/platformMessages/conversationDeepLink.test.js src/modules/platformMessages/PlatformMessagesView.test.js src/modules/navigation/channelNavigation.test.js`

Expected: target selection and query preservation tests pass; sidebar route assertions remain unchanged.

### Task 8: Build the On-Demand Customer Drawer

**Files:**
- Create: `platform-web/src/components/CustomerWorkspace/CustomerWorkspaceDrawer.vue`
- Create: `platform-web/src/components/CustomerWorkspace/CustomerOverview.vue`
- Create: `platform-web/src/components/CustomerWorkspace/CustomerTimeline.vue`
- Create: `platform-web/src/components/CustomerWorkspace/CustomerFollowups.vue`
- Create: `platform-web/src/components/CustomerWorkspace/CustomerOrders.vue`
- Create: `platform-web/src/modules/customers/customerWorkspace.js`
- Test: `platform-web/src/modules/customers/customerWorkspace.test.js`
- Modify: `platform-web/src/views/Workbench/WorkbenchView.vue`
- Modify: `platform-web/src/api/customers.js`

- [ ] **Step 1: Write failing context normalization tests**

Test missing AI data, field-level permissions, versioned follow-ups, source evidence, order binding state, and stale-response protection when rapidly switching conversations.

- [ ] **Step 2: Implement the normalized view model**

```js
export function normalizeCustomerWorkspace(raw = {}) {
  return {
    customer: raw.customer || null,
    stage: raw.communicationStage || { code: null, index: 0, label: '暂无沟通' },
    profile: raw.aiProfile || { summary: '', signals: [], version: 0 },
    followups: Array.isArray(raw.followups) ? raw.followups : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    permissions: { view: false, editProfile: false, manageFollowups: false, ...(raw.permissions || {}) }
  }
}
```

- [ ] **Step 3: Implement the drawer UI**

Use `el-drawer` from the right, 480px desktop width and full width below 620px. Tabs are 智能概览、沟通时间线、跟进任务、订单信息、用户信息、快捷话术. Keep the drawer closed by default and lazy-load heavy tabs. Bottom actions are 完成本次沟通、标记成交、安排跟进、打开完整画像.

- [ ] **Step 4: Replace simultaneous right-panel width usage**

Move existing `UserInfoCard` and `QuickReplyPanel` into the drawer tab system. Do not change `AppSidebar.vue`, left workbench panel widths, route hierarchy, or mobile left drawer behavior.

- [ ] **Step 5: Add optimistic command handling**

Send `expectedVersion` and `Idempotency-Key`. On 409, show a conflict message, reload only the current customer context, and preserve unsent form values.

- [ ] **Step 6: Run module tests and build**

Run: `node --test src/modules/customers/customerWorkspace.test.js` and `npm run build` from `platform-web`.

Expected: tests pass and Vite exits 0.

### Task 9: Upgrade the Daily Report and Customer Pages

**Files:**
- Modify: `platform-web/src/views/Customers/CustomersView.vue`
- Modify: `platform-web/src/views/Customers/CustomerProfileView.vue`
- Create: `platform-web/src/components/Customers/DailyReportCharts.vue`
- Create: `platform-web/src/components/Customers/DailyReportActionList.vue`
- Create: `platform-web/src/modules/customers/reportExport.js`
- Test: `platform-web/src/modules/customers/reportExport.test.js`
- Modify: `platform-web/package.json`

- [ ] **Step 1: Add failing report action and export tests**

Assert filters map to API query keys, customer actions build exact conversation deep links, and export redaction masks phone/notes/evidence for non-privileged users.

- [ ] **Step 2: Add visual report bands**

Render compact KPI cells, stage funnel, intent distribution, follow-up completion, trend, and owner workload above the action list. Filters include owner, channel, stage, intent, won, follow-up, overdue, intent change, and inactive status.

- [ ] **Step 3: Add batch operations**

Supervisor/admin may select bounded rows and atomically assign owner or add tags. Ordinary users never receive the full owner directory or hidden team rows.

- [ ] **Step 4: Add image export and print**

Install `html-to-image`. Request a server export token, download the newly authorized/redacted export payload, render only that payload in the export surface, and convert it to PNG. Do not reuse the already-loaded team table as the export source. Printing uses the same redacted payload and token flow.

- [ ] **Step 5: Preserve customer profile capabilities**

Keep existing order KPI/chart sections. Replace duplicate customer-operation markup with the same normalized workspace components where practical, while retaining full-page timeline and audit pagination.

- [ ] **Step 6: Run frontend regression tests**

Run: `node --test src/modules/customers/customerReport.test.js src/modules/customers/customerProfile.test.js src/modules/customers/reportExport.test.js src/modules/navigation/channelNavigation.test.js` and `npm run build`.

Expected: all tests pass; no left sidebar file changes.

### Task 10: Integration, E2E, Security, and Coverage Gate

**Files:**
- Create: `platform-web/e2e/customer-workspace.spec.js`
- Create: `platform-web/playwright.config.js`
- Modify: `platform-web/package.json`
- Test: all customer workspace files above

- [ ] **Step 1: Add authenticated backend integration tests**

Exercise the four-role matrix, own/other customers, multi-owner identities, task ownership, deep-link context, version conflicts, command replay, live/snapshot reports, and historical current-permission filtering against a disposable test database.

Add `@playwright/test` as a dev dependency and configure the existing HTTPS frontend/base URL through environment variables so credentials and ports are not hardcoded.

- [ ] **Step 2: Add Playwright critical paths**

Cover report filter → exact conversation → auto-open drawer; target in another pool; follow-up completion updating the report; browser return state; unauthorized URL edit; desktop and mobile drawer layouts.

- [ ] **Step 3: Run the complete verification loop**

Run from `rag-server`:

```powershell
node --test src/middleware/authenticate.test.js src/routes/customerAuthorization.test.js src/routes/conversationAuthorization.test.js src/routes/customerWorkspace.routes.test.js src/routes/customerCommands.routes.test.js src/modules/customer-operations/*.test.js
npm audit --audit-level=high
```

Run from `platform-web`:

```powershell
node --test src/modules/platformMessages/*.test.js src/modules/customers/*.test.js src/modules/navigation/channelNavigation.test.js
npm run build
npx playwright test e2e/customer-workspace.spec.js
npm audit --audit-level=high
```

Expected: all focused tests, build, E2E, and audits pass. If the existing full backend `npm test` still exceeds the environment timeout, report that separately and do not represent it as passing.

- [ ] **Step 4: Verify coverage and layout invariants**

Run Node coverage for new backend modules and pure frontend modules; require at least 80% line coverage for newly introduced files. Confirm `platform-web/src/components/Layout/AppSidebar.vue` and existing sidebar navigation definitions were not modified.
