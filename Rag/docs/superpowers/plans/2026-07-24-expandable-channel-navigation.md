# Expandable Customer Channel Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put WeCom and WhatsApp inside the existing application as first-class expandable sidebar menus, with channel-scoped conversation routes and a clearly named WeCom account-management route.

**Architecture:** Build a pure role-aware navigation model and render it through the existing Element Plus sidebar. Reuse the single `WorkbenchView` for unified, WeCom, and WhatsApp conversations by passing a fixed channel scope from route metadata into `ConversationList`; keep the existing WeCom account page and redirect its old route. No channel business logic or account state is duplicated.

**Tech Stack:** Vue 3, Vue Router 4, Pinia, Element Plus, ES modules, built-in `node:test`, Vite.

---

## Scope and file map

- Create `platform-web/src/modules/navigation/channelNavigation.js`: pure role-aware sidebar model and route-role helper.
- Create `platform-web/src/modules/navigation/channelNavigation.test.js`: navigation and role tests.
- Create `platform-web/src/modules/conversations/channelScope.js`: normalize route-provided fixed channel state.
- Create `platform-web/src/modules/conversations/channelScope.test.js`: channel scope tests.
- Modify `platform-web/src/components/Layout/AppSidebar.vue`: render items and expandable channel groups.
- Modify `platform-web/src/router/index.js`: semantic channel routes, compatibility redirect, and route-role guard.
- Modify `platform-web/src/views/Workbench/WorkbenchView.vue`: pass route channel scope into the conversation list and show the channel context in the panel heading.
- Modify `platform-web/src/components/Conversation/ConversationList.vue`: lock and reload the channel filter for channel-specific routes.
- Modify `platform-web/package.json`: add the navigation test script.

`E:\project\project\Rag` is not a Git repository. Run every checkpoint but skip commit commands and do not initialize Git.

### Task 1: Role-aware expandable navigation model

**Files:**
- Create: `platform-web/src/modules/navigation/channelNavigation.js`
- Create: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/package.json`

- [ ] **Step 1: Write the failing navigation tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSidebarMenu, hasRequiredRole } from './channelNavigation.js'

test('admin sees expandable WeCom conversations and accounts', () => {
  const wecom = buildSidebarMenu('admin').find(item => item.key === 'wecom')
  assert.equal(wecom.type, 'group')
  assert.deepEqual(wecom.children.map(item => item.path), [
    '/wecom/conversations',
    '/wecom/accounts'
  ])
})

test('agent sees WeCom conversations but not account administration', () => {
  const wecom = buildSidebarMenu('agent').find(item => item.key === 'wecom')
  assert.deepEqual(wecom.children.map(item => item.path), ['/wecom/conversations'])
})

test('WhatsApp is expandable without exposing the mock account page', () => {
  const whatsapp = buildSidebarMenu('admin').find(item => item.key === 'whatsapp')
  assert.deepEqual(whatsapp.children.map(item => item.path), ['/whatsapp/conversations'])
})

test('route roles are enforced explicitly', () => {
  assert.equal(hasRequiredRole(['admin', 'supervisor'], 'admin'), true)
  assert.equal(hasRequiredRole(['admin', 'supervisor'], 'agent'), false)
  assert.equal(hasRequiredRole(undefined, 'agent'), true)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/modules/navigation/channelNavigation.test.js`

Expected: FAIL with `Cannot find module './channelNavigation.js'`.

- [ ] **Step 3: Implement the navigation model**

Export `buildSidebarMenu(role)` and `hasRequiredRole(requiredRoles, role)`. The model must contain the existing operational entries and these channel groups:

```js
const menu = [
  { type: 'item', key: 'all-conversations', path: '/workbench', label: '统一会话', icon: 'ChatDotRound' },
  {
    type: 'group', key: 'wecom', label: '微信客服', icon: 'ChatLineRound',
    children: [
      { path: '/wecom/conversations', label: '微信会话', icon: 'ChatDotRound' },
      { path: '/wecom/accounts', label: '客服账号', icon: 'Connection', roles: ['admin', 'supervisor'] }
    ]
  },
  {
    type: 'group', key: 'whatsapp', label: 'WhatsApp', icon: 'ChatRound',
    children: [
      { path: '/whatsapp/conversations', label: 'WhatsApp 会话', icon: 'ChatDotRound' }
    ]
  }
]
```

Append the existing data dashboard, campaign, video, orders, catalog, customers, and modules entries as normal items. Filter role-restricted children and omit any group left without children.

- [ ] **Step 4: Add and run the script**

Add to `package.json`:

```json
"test:channel-navigation": "node --test src/modules/navigation/channelNavigation.test.js src/modules/conversations/channelScope.test.js"
```

For this task run the single existing test file directly until Task 3 adds the second file:

Run: `node --test src/modules/navigation/channelNavigation.test.js`

Expected: 4 tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 2: Sidebar rendering and semantic routes

**Files:**
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`
- Modify: `platform-web/src/router/index.js`

- [ ] **Step 1: Render the pure menu model**

Replace hard-coded menu items with one `v-for`. Render `item.type === 'group'` as `el-sub-menu` and normal items as `el-menu-item`. Resolve icon names inside the component so the pure model remains importable by Node tests:

```js
const iconComponents = {
  ChatDotRound, ChatLineRound, ChatRound, DataAnalysis, Promotion,
  VideoCamera, ShoppingCart, Goods, Connection, User, Tickets
}
const menuItems = computed(() => buildSidebarMenu(userStore.userInfo?.role))
```

The submenu index must use the stable group key (`channel-wecom`, `channel-whatsapp`), while children use their route path. Preserve the existing active item, hover, collapsed sidebar, theme, and collapse controls.

- [ ] **Step 2: Add semantic routes and the compatibility redirect**

Use the same `WorkbenchView` lazy import for both conversation routes:

```js
{
  path: 'wecom/conversations',
  name: 'WecomConversations',
  component: () => import('@/views/Workbench/WorkbenchView.vue'),
  meta: { title: '微信客服 / 微信会话', fixedChannel: 'wecom_kf' }
},
{
  path: 'wecom/accounts',
  name: 'WecomAccounts',
  component: () => import('@/views/Settings/PlatformAccountsView.vue'),
  meta: { title: '微信客服 / 客服账号', requiredRoles: ['admin', 'supervisor'] }
},
{
  path: 'platform-accounts',
  redirect: '/wecom/accounts'
},
{
  path: 'whatsapp/conversations',
  name: 'WhatsappConversations',
  component: () => import('@/views/Workbench/WorkbenchView.vue'),
  meta: { title: 'WhatsApp / 会话', fixedChannel: 'whatsapp' }
}
```

Keep `/workbench` with title `统一会话` and no `fixedChannel`.

- [ ] **Step 3: Enforce route-role metadata**

In `beforeEach`, safely parse `platform_user` and apply `hasRequiredRole` after authentication:

```js
if (to.meta.requiredRoles) {
  let role = ''
  try { role = JSON.parse(localStorage.getItem('platform_user') || 'null')?.role || '' } catch {}
  if (!hasRequiredRole(to.meta.requiredRoles, role)) return next('/workbench')
}
```

Do not weaken the existing API authorization.

- [ ] **Step 4: Run focused tests and build**

Run: `node --test src/modules/navigation/channelNavigation.test.js`

Expected: 4 tests pass.

Run: `npm run build`

Expected: Vite exits 0 and resolves all menu icon imports and routes.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 3: Fixed channel scope for the shared conversation workbench

**Files:**
- Create: `platform-web/src/modules/conversations/channelScope.js`
- Create: `platform-web/src/modules/conversations/channelScope.test.js`
- Modify: `platform-web/src/views/Workbench/WorkbenchView.vue`
- Modify: `platform-web/src/components/Conversation/ConversationList.vue`

- [ ] **Step 1: Write the failing channel-scope tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveChannelScope } from './channelScope.js'

test('locks WeCom conversation routes to the official channel code', () => {
  assert.deepEqual(resolveChannelScope('wecom_kf'), {
    fixedChannel: 'wecom_kf', selectedChannels: ['wecom_kf'],
    label: '微信客服', filterLocked: true
  })
})

test('keeps the unified workbench unrestricted', () => {
  assert.deepEqual(resolveChannelScope(''), {
    fixedChannel: '', selectedChannels: [], label: '全部渠道', filterLocked: false
  })
})

test('rejects unknown route channel codes', () => {
  assert.deepEqual(resolveChannelScope('unknown'), {
    fixedChannel: '', selectedChannels: [], label: '全部渠道', filterLocked: false
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/modules/conversations/channelScope.test.js`

Expected: FAIL with `Cannot find module './channelScope.js'`.

- [ ] **Step 3: Implement the scope resolver**

Allow only `wecom_kf` and `whatsapp`, with labels `微信客服` and `WhatsApp`. Unknown or empty input resolves to the unrestricted scope shown in the test.

- [ ] **Step 4: Pass route scope through the workbench**

In `WorkbenchView.vue`, use `useRoute()` and a computed scope:

```js
const route = useRoute()
const channelScope = computed(() => resolveChannelScope(route.meta.fixedChannel))
```

Pass `:fixed-channel="channelScope.fixedChannel"` and `:channel-label="channelScope.label"` to `ConversationList`. Change the left panel heading to `{{ channelScope.fixedChannel ? channelScope.label + '会话' : '会话列表' }}`.

- [ ] **Step 5: Lock and reactively reload `ConversationList`**

Define props:

```js
const props = defineProps({
  fixedChannel: { type: String, default: '' },
  channelLabel: { type: String, default: '全部渠道' }
})
const selectedChannels = ref(resolveChannelScope(props.fixedChannel).selectedChannels)
```

Add `微信客服` (`wecom_kf`) as an enabled option. Disable the channel selector and global-search switch when `fixedChannel` is present. The fixed route must always send `params.channel=props.fixedChannel`; the unrestricted route may continue using the user's selected channel.

Watch `props.fixedChannel`. On change, cancel current search/load requests, set the correct channel selection, clear global search and the selected conversation, then call `loadConversations()`. This prevents Vue Router component reuse from carrying WhatsApp data into the WeCom route.

Prefix the empty-state text with the fixed channel label, for example `微信客服 · 待人工池暂无会话`.

- [ ] **Step 6: Run the complete focused script**

Run: `npm run test:channel-navigation`

Expected: 7 tests pass.

Run: `npm run build`

Expected: Vite exits 0.

- [ ] **Step 7: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 4: Browser acceptance and full regression

**Files:**
- Verify only; no new production files expected.

- [ ] **Step 1: Start or refresh local services**

Keep the existing MySQL-backed backend on port `3001`. Rebuild and serve the frontend through the existing local preview configuration on port `3004`.

- [ ] **Step 2: Verify the expandable navigation as admin**

Using the existing local admin session, verify:

- “统一会话” is a normal top-level item.
- “微信客服” expands to “微信会话” and “客服账号”.
- “WhatsApp” expands to “WhatsApp 会话” only.
- `/platform-accounts` redirects to `/wecom/accounts`.
- Switching from WhatsApp conversations to WeCom conversations changes the fixed channel request and clears the current conversation.

- [ ] **Step 3: Verify role filtering without changing production data**

Use the pure navigation tests for `agent`, `supervisor`, and `admin`. Do not create a production WeCom connection or modify “客服1号”.

- [ ] **Step 4: Verify responsive behavior**

At 1280x720 and 820x900 verify submenu text does not overlap, the collapsed sidebar can open channel children, and both WeCom pages remain inside the same app shell.

- [ ] **Step 5: Run the complete regression suite**

Frontend:

```powershell
npm run test:channel-navigation
npm run test:platform-connections
npm run test:catalog
npm run build
```

Backend:

```powershell
npm run test:platform-connections
npm run test:catalog
node --test src/modules/messaging/inboundMessage.service.test.js src/modules/cloud-gateway/cloudGateway.test.js src/routes/channelAccounts.presenter.test.js
node --check src/app.js
```

Expected: all commands exit 0. Existing Sass and bundle-size warnings may remain, but no test or build failure is allowed.

- [ ] **Step 6: Leave one user-facing page open**

Keep `http://127.0.0.1:3004/wecom/accounts` open in the in-app browser and report the exact URL. Confirm the database contains no UI test connections.
