# AI Message Review and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver AI-first inbound-message review with mandatory human confirmation for every no-reply decision, an admin AI configuration page, a three-column review workbench, and a verified channel-status/build baseline.

**Architecture:** A focused `message-review` backend module sits after inbound persistence and before conversation routing/AI enqueue. It combines hard rules with a strict JSON AI classifier, persists idempotent review items, exposes role-scoped atomic workflow APIs, and reuses the existing outbound sender. Vue pages consume small API/form modules; existing configuration storage, navigation, and status infrastructure are extended rather than replaced.

**Tech Stack:** Node.js 22, CommonJS, Express, MySQL/Sequelize raw queries, Redis/BullMQ, Node test runner, Vue 3, Pinia, Element Plus, Vite.

---

## File structure

### Backend files to create

- `rag-server/src/modules/message-review/reviewPolicy.js` — pure decision merge and strict classifier-output validation.
- `rag-server/src/modules/message-review/reviewPolicy.test.js` — policy and fail-closed tests.
- `rag-server/src/modules/message-review/reviewConfig.js` — public config schema, type/range validation, and defaults.
- `rag-server/src/modules/message-review/reviewConfig.test.js` — configuration contract tests.
- `rag-server/src/modules/message-review/reviewClassifier.js` — bounded-context model call and timeout handling.
- `rag-server/src/modules/message-review/reviewClassifier.test.js` — valid, invalid, and timeout behavior.
- `rag-server/src/modules/message-review/reviewRepository.js` — SQL persistence, list/detail, merge, claim, privileged atomic takeover, release, and resolve operations.
- `rag-server/src/modules/message-review/reviewRepository.test.js` — SQL contract and optimistic concurrency tests.
- `rag-server/src/modules/message-review/reviewService.js` — orchestration, assignment, state transitions, and outbound reply dependency.
- `rag-server/src/modules/message-review/reviewService.test.js` — service-level workflow tests.
- `rag-server/src/modules/message-review/reviewRoutes.js` — JWT/role-scoped HTTP API.
- `rag-server/src/modules/message-review/reviewRoutes.test.js` — route status/permission/409 tests.
- `rag-server/src/modules/message-review/index.js` — production dependency composition and router export.
- `rag-server/src/routes/channelStatus.test.js` — aggregated channel status behavior.

### Backend files to modify

- `rag-server/src/config/database.js` — idempotent `message_review_items` migration and review defaults.
- `rag-server/src/services/configService.js` — review defaults and validated public update path.
- `rag-server/src/modules/messaging/inboundMessage.service.js` — review gate before routing/enqueue.
- `rag-server/src/modules/messaging/inboundMessage.service.test.js` — reviewed/allowed behavior.
- `rag-server/src/workers/aiReplyWorker.js` — second-line pending-review guard.
- `rag-server/src/workers/aiReplyWorker.test.js` — stale job rejection.
- `rag-server/src/app.js` — mount `/api/v1/message-reviews`.
- `rag-server/package.json` — stable review test script.

### Frontend files to create

- `platform-web/src/api/messageReviews.js` — review endpoints.
- `platform-web/src/api/aiConfig.js` — public configuration endpoints.
- `platform-web/src/modules/messageReviews/reviewQueue.js` — filters, ordering, response normalization, and form validation.
- `platform-web/src/modules/messageReviews/reviewQueue.test.js` — pure UI-domain tests.
- `platform-web/src/modules/aiConfig/aiConfigForm.js` — whitelisted groups and normalization.
- `platform-web/src/modules/aiConfig/aiConfigForm.test.js` — form boundary tests.
- `platform-web/src/views/MessageReviews/MessageReviewView.vue` — three-column page orchestration.
- `platform-web/src/views/MessageReviews/components/ReviewQueuePanel.vue` — queue/filter column.
- `platform-web/src/views/MessageReviews/components/ReviewConversationPanel.vue` — context column.
- `platform-web/src/views/MessageReviews/components/ReviewDecisionPanel.vue` — evidence/actions column.
- `platform-web/src/views/Settings/AiConfigView.vue` — admin configuration page.
- `platform-web/src/components/Layout/ChannelStatusIndicator.test.js` — response-to-UI state tests.

### Frontend files to modify

- `platform-web/src/modules/navigation/channelChrome.js` — restore `showWahaStatus` contract.
- `platform-web/src/components/Layout/AppHeader.vue` — conditionally render channel status.
- `platform-web/src/modules/navigation/channelNavigation.js` — review and admin-config menu items.
- `platform-web/src/modules/navigation/channelNavigation.test.js` — role menu expectations.
- `platform-web/src/router/index.js` — review and AI config routes.
- `platform-web/src/components/Layout/AppSidebar.vue` — add required icons without custom branching.
- `platform-web/src/api/statistics.js` or `platform-web/src/views/Statistics/DashboardView.vue` — align export UI with actual backend capability.
- `platform-web/package.json` — review/config test scripts.

## Phase 1 — Restore a trustworthy baseline

### Task 1: Fix channel chrome and status contracts

**Files:**
- Modify: `platform-web/src/modules/navigation/channelChrome.js`
- Modify: `platform-web/src/components/Layout/AppHeader.vue`
- Test: `platform-web/src/modules/navigation/channelChrome.test.js`
- Create: `rag-server/src/routes/channelStatus.test.js`

- [ ] **Step 1: Re-run the existing failing channel chrome test**

Run:

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/navigation/channelChrome.test.js
```

Expected: two failures showing `showWahaStatus` is missing.

- [ ] **Step 2: Implement the smallest chrome contract**

Replace `resolveChannelChrome` with:

```js
export function resolveChannelChrome(value) {
  const channelCode = String(value || '').trim().toLowerCase()
  return {
    channelCode,
    showWahaStatus: channelCode !== 'wecom_kf'
  }
}
```

In `AppHeader.vue`, import `resolveChannelChrome`, add:

```js
const channelChrome = computed(() => resolveChannelChrome(route.meta?.channelCode))
```

and render:

```vue
<ChannelStatusIndicator v-if="channelChrome.showWahaStatus" />
```

- [ ] **Step 3: Verify channel chrome is green**

Run the Step 1 command. Expected: 3 tests pass, 0 fail.

- [ ] **Step 4: Write a failing backend channel-status route test**

Extract and export `buildChannelStatusSummary(accountRows, sessions)` from `channelStatus.js`, then first add a test expecting connected/partial/offline aggregation:

```js
test('aggregates active channels and WhatsApp sessions without hiding other channels', () => {
  const result = buildChannelStatusSummary(
    [{ channel: 'whatsapp', account_count: 2 }, { channel: 'wecom_kf', account_count: 1 }],
    [{ status: 'CONNECTED', sessionName: 'a' }, { status: 'OFFLINE', sessionName: 'b' }]
  )
  assert.equal(result.overall, 'WARNING')
  assert.equal(result.channels[0].status, 'PARTIAL')
  assert.equal(result.channels[1].status, 'ACTIVE')
})
```

Run:

```powershell
cd E:\project\project\Rag\rag-server
node --test src/routes/channelStatus.test.js
```

Expected: FAIL because the pure helper is not exported.

- [ ] **Step 5: Extract the aggregation helper and verify it**

Move the existing aggregation loop into the pure helper, call it from the route, and export it alongside the router:

```js
module.exports = router
module.exports.buildChannelStatusSummary = buildChannelStatusSummary
```

Run the Step 4 command. Expected: pass.

### Task 2: Repair the production-build contract

**Files:**
- Modify: `platform-web/src/api/statistics.js`
- Modify if required: `platform-web/src/views/Statistics/DashboardView.vue`
- Inspect: `rag-server/src/routes/statistics.js`

- [ ] **Step 1: Confirm whether the backend has an export endpoint**

Run:

```powershell
rg -n "export|download|csv|xlsx" E:\project\project\Rag\rag-server\src\routes\statistics.js
```

Expected: either one concrete route path or no matches.

- [ ] **Step 2: Make the failing import contract executable**

If the route is `GET /export`, add exactly:

```js
export function exportReport(params) {
  return request.get('/v1/statistics/export', { params, responseType: 'blob' })
}
```

If no backend route exists, remove `exportReport` from the import, remove its click handler and hide/remove the non-working export button. Do not add a fake success message.

- [ ] **Step 3: Run the production build**

```powershell
cd E:\project\project\Rag\platform-web
npm run build
```

Expected: exit 0. Sass deprecation warnings may remain; unresolved exports may not.

## Phase 2 — Backend review decision and persistence

### Task 3: Define review policy and configuration with TDD

**Files:**
- Create: `rag-server/src/modules/message-review/reviewPolicy.js`
- Create: `rag-server/src/modules/message-review/reviewPolicy.test.js`
- Create: `rag-server/src/modules/message-review/reviewConfig.js`
- Create: `rag-server/src/modules/message-review/reviewConfig.test.js`
- Modify: `rag-server/src/services/configService.js`

- [ ] **Step 1: Write failing policy tests**

Cover these exact assertions:

```js
assert.deepEqual(decideReview({ ruleHits: ['prompt_injection'], classifier: allowResult }), {
  action: 'review', riskLevel: 'high', reasonCode: 'prompt_injection'
})
assert.equal(decideReview({ ruleHits: [], classifier: noReplyResult }).action, 'review')
assert.equal(decideReview({ ruleHits: [], classifier: { ...allowResult, confidence: 0.79 }, allowThreshold: 0.8 }).action, 'review')
assert.equal(decideReview({ ruleHits: [], classifier: { ...allowResult, confidence: 0.9 }, allowThreshold: 0.8 }).action, 'allow')
assert.equal(decideReview({ ruleHits: [], classifierError: new Error('timeout') }).action, 'review')
```

Also test `parseClassifierOutput` rejects invalid JSON, unknown enum values, `NaN`/out-of-range confidence, and `reason` over 500 characters.

Run:

```powershell
cd E:\project\project\Rag\rag-server
node --test src/modules/message-review/reviewPolicy.test.js
```

Expected: FAIL with module not found.

- [ ] **Step 2: Implement pure policy functions**

Export:

```js
module.exports = {
  parseClassifierOutput,
  decideReview,
  matchHardRules,
  RISK_LEVELS: ['low', 'medium', 'high'],
  RECOMMENDED_ACTIONS: ['allow', 'review', 'no_reply']
}
```

`matchHardRules` initially contains deterministic prompt-injection and suspicious-link indicators only; it returns stable reason codes and never returns a terminal no-reply action.

- [ ] **Step 3: Verify policy tests pass**

Run the Step 1 command. Expected: all pass.

- [ ] **Step 4: Write failing review-config tests**

Test the public keys and boundaries:

```js
assert.equal(validateReviewConfig('message_review_enabled', true), true)
assert.equal(validateReviewConfig('message_review_allow_threshold', 0.8), 0.8)
assert.throws(() => validateReviewConfig('message_review_allow_threshold', 1.1), /between 0 and 1/)
assert.throws(() => validateReviewConfig('unknown_key', true), /not editable/)
assert.throws(() => validateReviewConfig('message_review_context_count', 50), /between 0 and 20/)
```

Run `node --test src/modules/message-review/reviewConfig.test.js`. Expected: FAIL.

- [ ] **Step 5: Implement and wire review defaults**

Use these defaults:

```js
const REVIEW_DEFAULTS = {
  message_review_enabled: true,
  message_review_model: 'deepseek-v4-flash',
  message_review_allow_threshold: 0.85,
  message_review_context_count: 6,
  message_review_timeout_ms: 12000,
  message_review_merge_window_seconds: 30,
  message_review_assignment_timeout_seconds: 300
}
```

Add them to `configService.DEFAULTS`. Add an exported `updatePublicConfig(key, value, updatedBy)` that calls `validateReviewConfig` for review keys before delegating to `updateConfig`; keep the existing private internal method available to trusted callers.

- [ ] **Step 6: Verify config tests and existing config behavior**

Run:

```powershell
node --test src/modules/message-review/reviewConfig.test.js
```

Expected: pass.

### Task 4: Build the strict AI classifier

**Files:**
- Create: `rag-server/src/modules/message-review/reviewClassifier.js`
- Create: `rag-server/src/modules/message-review/reviewClassifier.test.js`

- [ ] **Step 1: Write failing dependency-injected classifier tests**

Create a harness with `invokeModel`, `getConfig`, and `getContext`. Assert:

```js
const result = await classifier.classify({ conversationId: 'c1', message: { content: { text: 'hello' } } })
assert.equal(result.recommendedAction, 'allow')
assert.equal(capturedMessages.some(item => JSON.stringify(item).includes('apiKey')), false)
```

Add tests for timeout rejection and malformed model output.

Run `node --test src/modules/message-review/reviewClassifier.test.js`. Expected: FAIL.

- [ ] **Step 2: Implement the classifier**

Expose:

```js
function createReviewClassifier({ invokeModel, getConfig, getContext, logger, setTimer = setTimeout, clearTimer = clearTimeout })
```

The classifier clamps context to 0–20 messages, passes only `{ role, content, createdAt, channel }`, races the model call against the configured timeout, then calls `parseClassifierOutput`.

- [ ] **Step 3: Verify classifier tests**

Run Step 1 command. Expected: pass.

### Task 5: Add the review table and repository

**Files:**
- Modify: `rag-server/src/config/database.js`
- Create: `rag-server/src/modules/message-review/reviewRepository.js`
- Create: `rag-server/src/modules/message-review/reviewRepository.test.js`

- [ ] **Step 1: Write failing repository tests with a recording Sequelize adapter**

Assert that:

- creating uses `primary_message_id` idempotency;
- merging only targets `status='pending'` and the time window;
- claiming contains `WHERE status='pending'` and returns conflict on zero affected rows;
- resolving contains `WHERE status='claimed' AND claimed_by=:operatorId`;
- agent list scope never emits unrestricted SQL.

Run `node --test src/modules/message-review/reviewRepository.test.js`. Expected: FAIL.

- [ ] **Step 2: Add the idempotent table migration**

Add a `CREATE TABLE IF NOT EXISTS message_review_items` block using the exact columns and indexes from the approved spec. Use `JSON NOT NULL` for `message_ids` and `rule_hits`, `CHAR(36)` IDs, and a unique index on `primary_message_id`.

- [ ] **Step 3: Implement repository operations**

Export:

```js
function createReviewRepository(sequelize) {
  return { createOrMerge, list, count, stats, detail, claim, release, resolveReply, resolveDismiss, hasOpenReviewForMessage }
}
```

Throw errors with `code='REVIEW_CONFLICT'` for zero-row conditional updates and `code='REVIEW_NOT_FOUND'` for missing detail.

- [ ] **Step 4: Verify repository tests**

Run Step 1 command. Expected: pass.

## Phase 3 — Backend workflow and HTTP API

### Task 6: Orchestrate inbound gating and assignment

**Files:**
- Create: `rag-server/src/modules/message-review/reviewService.js`
- Create: `rag-server/src/modules/message-review/reviewService.test.js`
- Modify: `rag-server/src/modules/messaging/inboundMessage.service.js`
- Modify: `rag-server/src/modules/messaging/inboundMessage.service.test.js`

- [ ] **Step 1: Write failing service tests**

Test these outcomes using injected dependencies:

```js
assert.deepEqual(await service.reviewInbound(message), { action: 'allow' })
assert.equal((await service.reviewInbound(suspiciousMessage)).action, 'review')
assert.equal(created.assignedTo, onlineOwner.id)
assert.equal((await service.reviewInbound(messageWithOfflineOwner)).item.assignedTo, null)
```

Also assert classifier failure creates medium-risk review and emits `review_classifier_failed` without logging full content.

- [ ] **Step 2: Implement `createReviewService`**

Expose methods:

```js
return {
  reviewInbound,
  list,
  stats,
  detail,
  claim,
  release,
  reply,
  dismiss,
  hasOpenReviewForMessage
}
```

`dismiss` rejects blank/unknown reason codes. `reply` invokes injected `sendReply`, resolves only after `{ success: true, messageId }`, and leaves the item claimed on failure.

- [ ] **Step 3: Verify service tests**

Run `node --test src/modules/message-review/reviewService.test.js`. Expected: pass.

- [ ] **Step 4: Extend the inbound processor test first**

Add a test with `reviewService.reviewInbound()` returning `{ action:'review', item:{ id:'r1' } }`. Assert `routeIncomingMessage` and `aiReplyQueue.add` are never called and the result is:

```js
{ reviewQueued: true, reviewId: 'r1', aiReplyQueued: false, jobMarker: null }
```

Run `node --test src/modules/messaging/inboundMessage.service.test.js`. Expected: FAIL.

- [ ] **Step 5: Gate routing/enqueue in `inboundMessage.service.js`**

Resolve `reviewService` as an injectable dependency and insert before `routeIncomingMessage`:

```js
const review = await reviewService.reviewInbound(message, context)
if (review.action === 'review') {
  await queueModule.removePendingAiReplyJobs(conversationId, 'message awaiting human review')
  return { reviewQueued: true, reviewId: review.item.id, aiReplyQueued: false, jobMarker: null }
}
```

- [ ] **Step 6: Verify inbound tests**

Run Step 4 command. Expected: all pass.

### Task 7: Add the worker defense-in-depth guard

**Files:**
- Modify: `rag-server/src/workers/aiReplyWorker.js`
- Modify: `rag-server/src/workers/aiReplyWorker.test.js`

- [ ] **Step 1: Write a failing stale-job test**

Given `reviewService.hasOpenReviewForMessage(message.id)` returns true, assert the worker does not call the AI generator or channel sender and reports skipped reason `message_review_pending`.

Run:

```powershell
node --test src/workers/aiReplyWorker.test.js
```

Expected: FAIL because the guard is absent.

- [ ] **Step 2: Implement the pre-generation guard**

Immediately after latest-job validation and before any model call:

```js
if (await reviewService.hasOpenReviewForMessage(job.data.message?.id)) {
  systemLogger.info('message.ai_reply_skipped', { conversationId, reason: 'message_review_pending' })
  return { skipped: true, reason: 'message_review_pending' }
}
```

- [ ] **Step 3: Verify worker tests**

Run Step 1 command. Expected: pass.

### Task 8: Expose role-safe review APIs

**Files:**
- Create: `rag-server/src/modules/message-review/reviewRoutes.js`
- Create: `rag-server/src/modules/message-review/reviewRoutes.test.js`
- Create: `rag-server/src/modules/message-review/index.js`
- Modify: `rag-server/src/app.js`
- Modify: `rag-server/package.json`

- [ ] **Step 1: Write failing route tests**

Use an injected auth middleware and service. Verify:

- agent `scope=all` gets 403;
- agent can list `mine` and `public`;
- supervisor can list `all`;
- claim conflict maps to 409;
- dismiss without `reasonCode` gets 400;
- reply failure maps to 502 without resolving;
- missing item maps to 404.

Run `node --test src/modules/message-review/reviewRoutes.test.js`. Expected: FAIL.

- [ ] **Step 2: Implement router factory**

Export:

```js
function createReviewRouter({ service, authenticate = createJwtAuth() })
```

Implement the approved seven endpoints. Normalize positive integer pagination; clamp limit to 100. Map `REVIEW_CONFLICT` to 409 and `REVIEW_NOT_FOUND` to 404.

- [ ] **Step 3: Compose production dependencies and mount**

`index.js` builds repository, classifier, and service from existing `sequelize`, `configService`, messaging context, seat status, queue helpers, logger, and the existing outbound send function extracted as a reusable service dependency. Mount:

```js
app.use('/api/v1/message-reviews', messageReviewRoutes)
```

- [ ] **Step 4: Add and run the backend review test script**

Add:

```json
"test:message-review": "node --test src/modules/message-review/*.test.js src/modules/messaging/inboundMessage.service.test.js src/workers/aiReplyWorker.test.js"
```

Run `npm run test:message-review`. Expected: all pass.

## Phase 4 — Frontend queue, configuration, and navigation

### Task 9: Add frontend domain modules and API clients

**Files:**
- Create: `platform-web/src/api/messageReviews.js`
- Create: `platform-web/src/api/aiConfig.js`
- Create: `platform-web/src/modules/messageReviews/reviewQueue.js`
- Create: `platform-web/src/modules/messageReviews/reviewQueue.test.js`
- Create: `platform-web/src/modules/aiConfig/aiConfigForm.js`
- Create: `platform-web/src/modules/aiConfig/aiConfigForm.test.js`
- Modify: `platform-web/package.json`

- [ ] **Step 1: Write failing queue-domain tests**

Test risk ordering, stable age ordering, 409 detection, and dismiss validation:

```js
assert.deepEqual(sortReviewItems(items).map(item => item.id), ['high-old', 'high-new', 'medium'])
assert.deepEqual(validateDismiss({ reasonCode: '' }), ['请选择不回复原因'])
assert.equal(isReviewConflict({ response: { status: 409 } }), true)
```

Run `node --test src/modules/messageReviews/reviewQueue.test.js`. Expected: FAIL.

- [ ] **Step 2: Implement queue functions and API client**

`messageReviews.js` exports `listReviews`, `getReviewStats`, `getReview`, `claimReview`, `releaseReview`, `replyReview`, and `dismissReview`. `reviewQueue.js` exports `sortReviewItems`, `normalizeReview`, `validateReply`, `validateDismiss`, and `isReviewConflict`.

- [ ] **Step 3: Write failing AI-config form tests**

Assert only approved keys appear, numeric strings normalize to numbers, booleans remain booleans, and invalid threshold/context/timeout values produce Chinese field errors.

Run `node --test src/modules/aiConfig/aiConfigForm.test.js`. Expected: FAIL.

- [ ] **Step 4: Implement AI-config form schema and client**

Use a frozen array of field definitions with `{ key, group, label, type, min, max, step }`. `aiConfig.js` uses existing `/v1/conversations/pool-config` GET and validated PUT endpoints.

- [ ] **Step 5: Add and run frontend scripts**

Add:

```json
"test:message-review": "node --test src/modules/messageReviews/reviewQueue.test.js",
"test:ai-config": "node --test src/modules/aiConfig/aiConfigForm.test.js"
```

Run both scripts. Expected: all pass.

### Task 10: Build the three-column review workbench

**Files:**
- Create: `platform-web/src/views/MessageReviews/MessageReviewView.vue`
- Create: `platform-web/src/views/MessageReviews/components/ReviewQueuePanel.vue`
- Create: `platform-web/src/views/MessageReviews/components/ReviewConversationPanel.vue`
- Create: `platform-web/src/views/MessageReviews/components/ReviewDecisionPanel.vue`

- [ ] **Step 1: Add source-contract tests before components**

Extend `reviewQueue.test.js` to read component source and assert:

```js
assert.match(viewSource, /ReviewQueuePanel/)
assert.match(viewSource, /ReviewConversationPanel/)
assert.match(viewSource, /ReviewDecisionPanel/)
assert.match(decisionSource, /不回复原因/)
assert.doesNotMatch(decisionSource, /自动不回复/)
```

Run the test. Expected: FAIL because components do not exist.

- [ ] **Step 2: Implement the page orchestrator**

`MessageReviewView.vue` owns active scope, filters, items, selected item/detail, stats, loading, and request version counters. It reloads list/detail after every mutation and handles 409 by showing `ElMessage.warning('该任务已被其他坐席处理')` before refreshing.

- [ ] **Step 3: Implement the three focused panels**

- Queue: mine/public/all tabs, risk/channel filters, high-risk-first list, claim button.
- Conversation: chronological context and highlighted reviewed message IDs.
- Decision: evidence, confidence, fixed dismiss reasons, reply textarea; buttons emit events only and never call APIs directly.

Use CSS grid `minmax(260px, 320px) minmax(360px, 1fr) minmax(300px, 380px)` on desktop and a single-column stacked layout below 900px.

- [ ] **Step 4: Verify source and domain tests**

Run `npm run test:message-review`. Expected: pass.

### Task 11: Build the AI configuration page

**Files:**
- Create: `platform-web/src/views/Settings/AiConfigView.vue`

- [ ] **Step 1: Add a failing source-contract test**

In `aiConfigForm.test.js`, assert the view imports the whitelist schema, renders the hard safety boundaries as text, and does not render inputs for `automatic_no_reply` or arbitrary config keys.

Run `npm run test:ai-config`. Expected: FAIL.

- [ ] **Step 2: Implement the admin page**

Load the current config, map through the whitelist only, render Review / AI Reply / Safety sections, validate before save, PUT changed fields sequentially, and show per-field errors. The safety section contains static text for the five non-configurable boundaries from the spec.

- [ ] **Step 3: Verify AI-config tests**

Run `npm run test:ai-config`. Expected: pass.

### Task 12: Add routes, role-aware navigation, and badge refresh

**Files:**
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/router/index.js`
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`

- [ ] **Step 1: Write failing navigation assertions**

Add expectations:

```js
assert.ok(buildSidebarMenu('agent').some(item => item.path === '/message-reviews'))
assert.ok(buildSidebarMenu('supervisor').some(item => item.path === '/message-reviews'))
assert.ok(buildSidebarMenu('admin').some(item => item.path === '/settings/ai'))
assert.equal(buildSidebarMenu('agent').some(item => item.path === '/settings/ai'), false)
```

Also read router source and require role metadata for `/settings/ai`.

Run `npm run test:channel-navigation`. Expected: FAIL.

- [ ] **Step 2: Add menu definitions and routes**

Add:

```js
{ type: 'item', key: 'message-reviews', path: '/message-reviews', label: '消息审核', icon: 'Warning' }
{ type: 'item', key: 'ai-config', path: '/settings/ai', label: 'AI 配置', icon: 'Setting', roles: ['admin'] }
```

Add matching lazy routes; `message-reviews` requires `agent/supervisor/admin`, and `settings/ai` requires `admin`.

- [ ] **Step 3: Add icon mappings and a non-blocking review badge**

Import `Warning` and `Setting` in `AppSidebar.vue`. Fetch stats on mount and every 60 seconds; display `mine + public` beside the review label. A stats failure must leave the menu usable and show no badge.

- [ ] **Step 4: Verify navigation tests**

Run `npm run test:channel-navigation`. Expected: all pass.

## Phase 5 — Full verification

### Task 13: Run complete automated verification

**Files:**
- No production edits unless a test exposes a defect.

- [ ] **Step 1: Run focused backend tests**

```powershell
cd E:\project\project\Rag\rag-server
npm run test:message-review
node --test src/routes/channelStatus.test.js
```

Expected: 0 failures.

- [ ] **Step 2: Run all backend tests**

```powershell
cd E:\project\project\Rag\rag-server
node --test src/**/*.test.js
```

Expected: 0 failures. If PowerShell glob expansion is inconsistent, use `rg --files src | Where-Object { $_ -match '\.test\.js$' }` and pass the resolved file list to `node --test`.

- [ ] **Step 3: Run focused frontend tests**

```powershell
cd E:\project\project\Rag\platform-web
npm run test:message-review
npm run test:ai-config
npm run test:channel-navigation
```

Expected: 0 failures.

- [ ] **Step 4: Run the production build**

```powershell
cd E:\project\project\Rag\platform-web
npm run build
```

Expected: exit 0 with no unresolved imports or Vue template errors.

### Task 14: Run API and browser acceptance

**Files:**
- Create only if needed for repeatability: `rag-server/scripts/verify-message-review-flow.js`

- [ ] **Step 1: Verify four API flows against an isolated test database or injected service harness**

The script must assert:

```js
assert.equal(normalMessage.action, 'allow')
assert.equal(noReplySuggestion.action, 'review')
assert.equal(humanReply.status, 'replied')
assert.equal(humanDismiss.status, 'dismissed')
assert.ok(humanDismiss.resolvedBy)
assert.ok(humanDismiss.resolutionReason)
```

Run `node scripts/verify-message-review-flow.js`. Expected: `4 review flows verified` and exit 0.

- [ ] **Step 2: Start the local backend and frontend**

Use the repository's local deployment script or separate terminals. Confirm `/api/v1/message-reviews/stats` returns authenticated JSON and `/message-reviews` loads without console errors.

- [ ] **Step 3: Verify the browser UI**

Check desktop and a width below 900 px:

- three columns render on desktop and stack on mobile;
- claim conflict refreshes instead of overwriting;
- AI evidence is visible;
- reply closes only after send success;
- no-reply cannot submit without reason;
- admin sees AI config; agent does not;
- WeCom pages hide WhatsApp-only chrome and shared/WhatsApp pages show the aggregate indicator.

- [ ] **Step 4: Record fresh evidence**

Save command outputs and screenshots under `output/playwright/message-review/`. Report exact test counts, build exit code, API flow count, and any remaining warnings. Do not claim completion if any required check fails.

## Plan self-review result

- Spec coverage: all 13 approved design sections map to Tasks 1–14.
- Placeholders: no implementation step contains TBD, TODO, “similar to”, or an unspecified error-handling instruction.
- Type consistency: statuses are consistently `pending/claimed/replied/dismissed`; AI actions are `allow/review/no_reply`; the terminal no-reply operation is named `dismiss`; configuration keys match the design specification.
- Scope control: no online training, double-model review, batch resolution, media reply, or replacement of existing messaging/auth systems is included.
- Repository note: `E:\project\project\Rag` currently has no `.git` metadata, so the implementation must preserve logical checkpoints but cannot perform the frequent commits requested by the planning workflow unless the user later supplies a Git repository.
