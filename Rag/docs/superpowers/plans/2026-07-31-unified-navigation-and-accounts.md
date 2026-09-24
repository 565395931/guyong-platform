# Unified Navigation and Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the left sidebar to Platform Messages and Customer Service Accounts, move review/business/settings navigation into the header, fix the active-color spill, and provide unified platform and multi-account views without breaking old bookmarked URLs.

**Architecture:** Pure navigation modules define role-filtered sidebar and header entries. Two composition views reuse the existing workbench, event inbox, WeCom connection view, and generic account manager through explicit props. Legacy platform routes redirect into the unified views with query parameters. The existing JWT role guard remains authoritative.

**Tech Stack:** Vue 3, Vue Router 4, Pinia, Element Plus, SCSS, Vite, Node test runner.

---

## Scope and delivery order

This plan is phase 1 of the approved desktop-bridge design. It can ship before desktop nodes exist. The account page initially exposes the unified account directory; node and bridge-log tabs are added by the control-plane plan after their APIs exist.

The workspace is not currently a Git repository. Run every verification checkpoint below. When Git is initialized, commit after each task with the suggested message instead of batching the whole phase.

## Task 1: Lock the two-item sidebar contract

**Files:**
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`

- [x] **Step 1: Replace the old test expectations with the approved information architecture**

Add tests that assert:

```js
test('admin sidebar has exactly the two approved modules', () => {
  assert.deepEqual(buildNavigation('admin').map((item) => item.label), [
    '平台消息',
    '客服账号管理'
  ])
})

test('agents only see the message module', () => {
  assert.deepEqual(buildNavigation('agent').map((item) => item.label), ['平台消息'])
})
```

Run:

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/navigation/channelNavigation.test.js
```

Expected: FAIL because the current definition still contains platform-specific and business entries.

- [x] **Step 2: Replace `MENU_DEFINITION` with two route items**

Keep `hasRequiredRole` and role filtering, and use this data shape:

```js
export const MENU_DEFINITION = [
  {
    kind: 'item',
    label: '平台消息',
    icon: 'ChatDotRound',
    path: '/platform-messages',
    requiredRoles: ['agent', 'supervisor', 'admin']
  },
  {
    kind: 'item',
    label: '客服账号管理',
    icon: 'Connection',
    path: '/customer-service-accounts',
    requiredRoles: ['supervisor', 'admin']
  }
]
```

- [x] **Step 3: Run the navigation test**

Expected: all navigation tests pass.

Suggested commit: `refactor(web): reduce sidebar to two modules`

## Task 2: Define role-filtered header navigation

**Files:**
- Create: `platform-web/src/modules/navigation/headerNavigation.js`
- Create: `platform-web/src/modules/navigation/headerNavigation.test.js`

- [x] **Step 1: Write failing tests for review, business tools, and settings**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHeaderNavigation } from './headerNavigation.js'

test('agent gets review and daily business tools but no admin settings', () => {
  const result = buildHeaderNavigation('agent')
  assert.equal(result.review.path, '/message-reviews')
  assert.ok(result.business.some((item) => item.path === '/orders'))
  assert.equal(result.settings.length, 0)
})

test('admin gets platform and system settings', () => {
  const result = buildHeaderNavigation('admin')
  assert.ok(result.settings.some((item) => item.path === '/settings/ai'))
  assert.ok(result.settings.some((item) => item.path === '/modules'))
})
```

- [x] **Step 2: Implement the pure navigation builder**

Business entries: statistics, campaigns, video, orders, catalog, and customers. Settings entries: AI configuration and functional modules. Filter every entry with the existing `hasRequiredRole` helper.

- [x] **Step 3: Verify both navigation modules**

```powershell
node --test src/modules/navigation/channelNavigation.test.js src/modules/navigation/headerNavigation.test.js
```

Expected: all tests pass.

Suggested commit: `feat(web): add role-aware header navigation`

## Task 3: Add canonical unified routes and preserve old URLs

**Files:**
- Modify: `platform-web/src/router/index.js`
- Create: `platform-web/src/modules/navigation/legacyRouteRedirects.js`
- Create: `platform-web/src/modules/navigation/legacyRouteRedirects.test.js`

- [x] **Step 1: Test deterministic legacy redirects**

Create a pure helper and test representative routes:

```js
assert.deepEqual(resolveLegacyRoute('/whatsapp/conversations'), {
  path: '/platform-messages', query: { channel: 'whatsapp', view: 'conversations' }
})
assert.deepEqual(resolveLegacyRoute('/taobao/accounts'), {
  path: '/customer-service-accounts', query: { channel: 'taobao' }
})
```

Cover WeCom, WhatsApp, Douyin, Pinduoduo, Taobao, and 1688.

- [x] **Step 2: Register the canonical routes**

Add:

```js
{
  path: 'platform-messages',
  name: 'PlatformMessages',
  component: () => import('@/views/PlatformMessages/PlatformMessagesView.vue'),
  meta: { title: '平台消息', requiredRoles: ['agent', 'supervisor', 'admin'] }
},
{
  path: 'customer-service-accounts',
  name: 'CustomerServiceAccounts',
  component: () => import('@/views/Settings/CustomerServiceAccountsView.vue'),
  meta: { title: '客服账号管理', requiredRoles: ['supervisor', 'admin'] }
}
```

Change `/` and successful-login redirects to `/platform-messages`. Keep all old route names, but replace their components with redirect functions using `resolveLegacyRoute`.

- [x] **Step 3: Update role-guard fallbacks**

Every denied authenticated route must redirect to `/platform-messages`, not `/workbench`.

- [x] **Step 4: Run route-helper and navigation tests**

Expected: all pass.

Suggested commit: `feat(web): add canonical unified platform routes`

## Task 4: Make channel scoping prop-driven and query-compatible

**Files:**
- Modify: `platform-web/src/views/Workbench/WorkbenchView.vue`
- Modify: `platform-web/src/views/Channels/ChannelEventsView.vue`
- Modify: `platform-web/src/modules/conversations/channelScope.js`
- Modify: `platform-web/src/modules/conversations/channelScope.test.js`

- [x] **Step 1: Add failing scope precedence tests**

The precedence must be explicit prop, then query, then route metadata, then all channels:

```js
assert.equal(resolveChannelScope({ prop: 'taobao', query: 'whatsapp', meta: 'wecom_kf' }), 'taobao')
assert.equal(resolveChannelScope({ query: 'whatsapp', meta: 'wecom_kf' }), 'whatsapp')
assert.equal(resolveChannelScope({ meta: 'wecom_kf' }), 'wecom_kf')
assert.equal(resolveChannelScope({}), '')
```

- [x] **Step 2: Extend both reusable views with props**

Use:

```js
const props = defineProps({
  channelCode: { type: String, default: '' },
  accountId: { type: [String, Number], default: '' },
  embedded: { type: Boolean, default: false }
})
```

Resolve the channel through the pure helper. Include `accountId` in list/event requests when present. When `embedded` is true, remove page-level padding and headings so the composition view owns the layout.

- [x] **Step 3: Run the channel-scope test**

Expected: all pass.

Suggested commit: `refactor(web): make message views embeddable`

## Task 5: Build the unified Platform Messages view

**Files:**
- Create: `platform-web/src/modules/platformMessages/platformFilters.js`
- Create: `platform-web/src/modules/platformMessages/platformFilters.test.js`
- Create: `platform-web/src/views/PlatformMessages/PlatformMessagesView.vue`
- Modify: `platform-web/src/api/channels.js`

- [x] **Step 1: Test supported view/channel normalization**

Allow `conversations` and `events`; fall back to `conversations`. Normalize platform aliases so `1688` becomes `alibaba1688`. Reject unknown channel values by returning an empty string.

- [x] **Step 2: Add the account option API helper**

Reuse `GET /v1/channel-accounts` and normalize its response to `{ id, name, channel, status }`. Do not add a second account endpoint.

- [x] **Step 3: Implement the full-width work surface**

The top toolbar contains:

- a platform segmented control: All, WeCom, WhatsApp, Douyin, Pinduoduo, Taobao/Qianniu, 1688;
- an account selector filtered by selected platform;
- a view segmented control: Conversations and Business Events;
- a refresh icon button with tooltip.

Render:

```vue
<WorkbenchView
  v-if="selectedView === 'conversations'"
  :channel-code="selectedChannel"
  :account-id="selectedAccountId"
  embedded
/>
<ChannelEventsView
  v-else
  :channel-code="selectedChannel"
  :account-id="selectedAccountId"
  embedded
/>
```

Synchronize channel/view/account to `route.query` with `router.replace`, so refresh and shared links preserve context.

- [x] **Step 4: Make unsupported capabilities visible and fail closed**

For commerce channels whose official adapter exposes no chat capability, keep the conversation area read-only and show status text `需要在线桌面节点` beside the composer. Do not simulate a successful send.

- [x] **Step 5: Verify module tests and production build**

```powershell
node --test src/modules/platformMessages/platformFilters.test.js src/modules/conversations/channelScope.test.js
npm run build
```

Expected: tests pass and Vite build exits 0.

Suggested commit: `feat(web): unify platform messages workspace`

## Task 6: Build the unified Customer Service Accounts view

**Files:**
- Modify: `platform-web/src/views/Settings/AccountManage.vue`
- Modify: `platform-web/src/views/Settings/PlatformAccountsView.vue`
- Create: `platform-web/src/modules/accounts/accountDirectory.js`
- Create: `platform-web/src/modules/accounts/accountDirectory.test.js`
- Create: `platform-web/src/views/Settings/CustomerServiceAccountsView.vue`

- [x] **Step 1: Test account filtering without single-account assumptions**

Test that two WhatsApp accounts remain separate rows and that filtering by channel never collapses accounts by platform:

```js
const rows = normalizeAccountRows([
  { id: 11, channel: 'whatsapp', account_name: 'WA Sales A' },
  { id: 12, channel: 'whatsapp', account_name: 'WA Sales B' }
])
assert.deepEqual(rows.map((row) => row.id), [11, 12])
```

- [x] **Step 2: Make both existing account views embeddable**

Add `channelCode` and `embedded` props. Replace direct reads of `route.meta.channelCode` with prop-first resolution. Preserve all existing create, edit, disable, session, and connection operations.

- [x] **Step 3: Compose one account directory**

The page toolbar has platform filters and a create-account command. Render `PlatformAccountsView` for `wecom_kf`; render `AccountManage` for all other platforms or the All filter. The All filter must show a single table with channel, account name, connection mode, assigned desktop node, online state, and actions.

Until the control-plane plan adds node assignment, derive `connectionMode` as `official_api` for currently supported API adapters and `desktop_bridge_required` for commerce chat. Do not write fake node IDs.

- [x] **Step 4: Verify account tests and build**

```powershell
node --test src/modules/accounts/accountDirectory.test.js
npm run build
```

Expected: pass.

Suggested commit: `feat(web): unify customer service account management`

## Task 7: Move review and secondary modules into the header

**Files:**
- Modify: `platform-web/src/components/Layout/AppHeader.vue`
- Modify: `platform-web/src/api/messageReviews.js`
- Create: `platform-web/src/modules/navigation/reviewBadge.js`
- Create: `platform-web/src/modules/navigation/reviewBadge.test.js`

- [x] **Step 1: Test badge count normalization**

The badge displays `99+` over 99, zero when the API is unavailable, and never throws for a missing stats object.

- [x] **Step 2: Add the header commands**

In desktop layout, render a direct Review button with badge, a Business dropdown, and a Settings dropdown. Use Element Plus icons and tooltips. Keep reminder, status, and user controls on the right. On narrow screens, collapse Business and Settings into one More dropdown.

- [x] **Step 3: Fetch the pending review count safely**

Poll the existing review stats endpoint every 30 seconds while authenticated and refresh immediately after a `message_review_updated` socket event. Clear the interval and listener on unmount.

- [x] **Step 4: Verify header helper tests and build**

Expected: pass.

Suggested commit: `feat(web): move review and tools into app header`

## Task 8: Fix sidebar color spill and verify responsive behavior

**Files:**
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`
- Modify: `platform-web/src/components/Layout/AppLayout.vue`

- [x] **Step 1: Isolate active backgrounds**

Set the sidebar root and scroll container to the same background, apply `overflow: hidden` to the root, and scope active color to `.el-menu-item.is-active` only. Remove any active rule targeting a parent submenu or a full-width pseudo-element.

- [x] **Step 2: Stabilize dimensions**

Use a fixed `56px` item height and a single `1px` active indicator inside the item box. The collapsed sidebar must keep a fixed width and icon center; labels must not affect width.

- [x] **Step 3: Run all focused frontend tests**

```powershell
node --test src/modules/navigation/*.test.js src/modules/conversations/channelScope.test.js src/modules/platformMessages/platformFilters.test.js src/modules/accounts/accountDirectory.test.js
npm run build
```

Expected: all pass.

- [x] **Step 4: Perform browser verification at three viewports**

Start the existing HTTPS development server and inspect:

- 1440x900: exactly two sidebar modules for admin; no color bleed below active item;
- 1024x768: header commands fit without overlap;
- 390x844: drawer sidebar, compact header menu, no clipped text.

Exercise old URLs, platform/account filtering, review badge navigation, sidebar collapse, and page refresh with query state. Save screenshots under `project/Rag/artifacts/ui-unification/`.

Suggested commit: `fix(web): isolate sidebar active styling`

## Completion criteria

- Admin/supervisor sidebar has exactly Platform Messages and Customer Service Accounts; agents only see Platform Messages.
- All old platform conversation/account URLs redirect with preserved platform context.
- Multiple WhatsApp accounts appear independently and are manageable from one page.
- Review is a prominent header command; business tools and settings no longer crowd the sidebar.
- Unsupported commerce chat is clearly read-only until a desktop node is connected.
- Focused tests and `npm run build` pass.
- Desktop and mobile screenshots show no active-color spill, overlap, or clipped labels.
