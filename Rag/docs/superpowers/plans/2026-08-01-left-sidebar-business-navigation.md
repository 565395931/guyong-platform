# 左侧业务导航重组实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore all major business functions to the left sidebar while keeping platform messages and customer-service accounts unified into two direct modules.

**Architecture:** `channelNavigation.js` becomes the single role-filtered source for three sidebar groups: customer work, business operations, and system settings. The sidebar owns the pending-review badge because it is the persistent destination for review work; the header keeps only page title, channel status, reminders, and user controls. Existing canonical routes, legacy redirects, platform/account views, and desktop-bridge read-only behavior remain unchanged.

**Tech Stack:** Vue 3, Pinia, Vue Router 4, Element Plus, SCSS, Node test runner, Playwright QA script.

---

## Task 1: Define the grouped sidebar contract

**Files:**
- Modify: `project/Rag/platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `project/Rag/platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `project/Rag/platform-web/src/components/Layout/AppSidebar.vue`
- Create: `project/Rag/platform-web/src/modules/navigation/sidebarGroups.test.js`

- [ ] **Step 1: Write failing tests for grouped role-filtered navigation**

Assert the exact visible labels and paths:

```js
const menu = buildSidebarMenu('admin')
assert.deepEqual(menu.map(item => item.label), ['客服工作', '业务运营', '系统设置'])
assert.deepEqual(menu[0].children.map(item => item.path), [
  '/platform-messages', '/customer-service-accounts', '/message-reviews'
])
assert.deepEqual(menu[1].children.map(item => item.path), [
  '/statistics', '/statistics/after-sales', '/campaigns', '/video', '/orders', '/catalog', '/customers'
])
assert.deepEqual(menu[2].children.map(item => item.path), ['/settings/ai', '/modules'])
assert.deepEqual(buildSidebarMenu('agent')[0].children.map(item => item.path), [
  '/platform-messages', '/message-reviews', '/statistics', '/statistics/after-sales', '/campaigns',
  '/video', '/orders', '/catalog', '/customers'
])
assert.equal(buildSidebarMenu('agent').some(item => item.key === 'system-settings'), false)
```

Add a source-level assertion that the sidebar menu renders `message-reviews` with a badge slot instead of relying on a header badge.

- [ ] **Step 2: Run the navigation tests and confirm the old flat contract fails**

Run from `E:\project\project\Rag\platform-web`:

```powershell
node --test src/modules/navigation/channelNavigation.test.js src/modules/navigation/sidebarGroups.test.js
```

Expected: FAIL because `MENU_DEFINITION` currently contains only two flat items.

- [ ] **Step 3: Replace the flat definition with three groups**

Use this data shape and keep `hasRequiredRole` as the only role filter:

```js
export const MENU_DEFINITION = [
  {
    type: 'group', key: 'customer-work', label: '客服工作', icon: 'Headset',
    roles: ['agent', 'supervisor', 'admin'],
    children: [
      { type: 'item', key: 'platform-messages', path: '/platform-messages', label: '平台消息', icon: 'ChatDotRound', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'customer-service-accounts', path: '/customer-service-accounts', label: '客服账号管理', icon: 'Connection', roles: ['supervisor', 'admin'] },
      { type: 'item', key: 'message-reviews', path: '/message-reviews', label: '消息审核', icon: 'Warning', badge: 'review', roles: ['agent', 'supervisor', 'admin'] }
    ]
  },
  {
    type: 'group', key: 'business-operations', label: '业务运营', icon: 'Briefcase',
    roles: ['agent', 'supervisor', 'admin'],
    children: [
      { type: 'item', key: 'statistics', path: '/statistics', label: '数据看板', icon: 'DataAnalysis', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'after-sales', path: '/statistics/after-sales', label: '售后分析', icon: 'TrendCharts', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'campaigns', path: '/campaigns', label: '主动营销', icon: 'Promotion', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'video', path: '/video', label: '视频生成', icon: 'VideoCamera', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'orders', path: '/orders', label: '订单管理', icon: 'ShoppingCart', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'catalog', path: '/catalog', label: '产品与报价', icon: 'Goods', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'customers', path: '/customers', label: '客户管理', icon: 'User', roles: ['agent', 'supervisor', 'admin'] }
    ]
  },
  {
    type: 'group', key: 'system-settings', label: '系统设置', icon: 'Setting', roles: ['admin'],
    children: [
      { type: 'item', key: 'ai-config', path: '/settings/ai', label: 'AI 配置', icon: 'Setting', roles: ['admin'] },
      { type: 'item', key: 'modules', path: '/modules', label: '功能模块', icon: 'Tickets', roles: ['admin'] }
    ]
  }
]
```

Update `AppSidebar.vue` to render group titles and child items, add `Headset` and `Briefcase` to `iconComponents`, and render the `review` badge only on the `message-reviews` child. Keep router navigation and mobile close behavior unchanged.

- [ ] **Step 4: Run grouped navigation tests**

```powershell
node --test src/modules/navigation/channelNavigation.test.js src/modules/navigation/sidebarGroups.test.js
```

Expected: all grouped role and badge-contract tests pass.

## Task 2: Move the review count into the persistent sidebar

**Files:**
- Create: `project/Rag/platform-web/src/modules/navigation/reviewCount.js`
- Create: `project/Rag/platform-web/src/modules/navigation/reviewCount.test.js`
- Modify: `project/Rag/platform-web/src/components/Layout/AppSidebar.vue`
- Modify: `project/Rag/platform-web/src/components/Layout/AppHeader.vue`

- [ ] **Step 1: Write failing tests for a reusable review counter**

The pure module must normalize counts, expose a zero-safe fetcher, and calculate the display value without throwing:

```js
assert.equal(normalizeReviewCount({ mine: 2, public: 3 }), 5)
assert.equal(normalizeReviewCount(), 0)
assert.equal(normalizeReviewCount({ mine: 'bad', public: 1 }), 1)
assert.equal(formatReviewCount(0), 0)
assert.equal(formatReviewCount(100), '99+')
```

- [ ] **Step 2: Implement the counter module and sidebar lifecycle**

Move the existing `getReviewStats` polling and `message_review_updated` listener into a small composable-style factory exported by `reviewCount.js`. It must return `{ count, start, stop }`, poll every 30 seconds, call `getReviewStats()` defensively, and stop both the timer and WebSocket listener on unmount. `AppSidebar.vue` starts it on mount and binds `formatReviewCount(count)` to the `message-reviews` child badge.

- [ ] **Step 3: Remove review/business/settings navigation from `AppHeader.vue`**

Delete the desktop review button, Business dropdown, Settings dropdown, mobile tools dropdown, `buildHeaderNavigation` and review-count imports, polling state, and navigation helpers that only served those menus. Keep the mobile menu button, page title, reminder popover, channel status indicator, and user dropdown. The header’s left/right layout must not change for the retained controls.

- [ ] **Step 4: Run counter and header tests**

```powershell
node --test src/modules/navigation/reviewCount.test.js src/modules/navigation/headerNavigation.test.js src/modules/navigation/sidebarGroups.test.js
```

Expected: counter tests pass, header tests assert retained controls and no business/system dropdown contract.

## Task 3: Style grouped navigation without color bleed

**Files:**
- Modify: `project/Rag/platform-web/src/components/Layout/AppSidebar.vue`
- Modify: `project/Rag/platform-web/src/components/Layout/AppLayout.vue`
- Modify: `project/Rag/platform-web/src/modules/navigation/AppSidebarStyle.test.js`

- [ ] **Step 1: Extend style tests before changing SCSS**

Assert source-level contracts for `.app-sidebar { overflow: hidden }`, `.app-sidebar__menu { min-height: 0; overflow-y: auto }`, 44px or 48px stable child rows, group-title styling, and active styling scoped only to `.el-menu-item.is-active`.

- [ ] **Step 2: Apply grouped sidebar SCSS**

Use a single dark background on the root and menu, `overflow: hidden` on the root, and `min-height: 0; overflow-y: auto` on the menu. Keep child rows at 48px, group labels at 28px, and make the active background/1px indicator apply only to `.el-menu-item.is-active`; group titles may change text color but must not receive the active fill or pseudo-element. Keep collapsed width 64px and center icons without allowing labels to resize it.

- [ ] **Step 3: Verify style tests and build**

```powershell
node --test src/modules/navigation/AppSidebarStyle.test.js src/modules/conversations/embeddableViews.test.js
npm run build
```

Expected: tests pass and Vite exits 0.

## Task 4: Browser regression for the corrected information architecture

**Files:**
- Modify: `project/Rag/platform-web/scripts/qa-unified-navigation.cjs`
- Create: `project/Rag/platform-web/src/modules/navigation/sidebarGroups.browser.test.js`

- [ ] **Step 1: Update the browser assertions**

At 1440x900 assert three group titles, all admin child labels, no `.app-header__tools`, no header Business/System text, and the review badge beside the sidebar item. At 1024x768 assert the retained header controls do not overlap and the workbench center is at least 240px. At 390x844 open the drawer and assert the same three groups and no clipped labels.

- [ ] **Step 2: Exercise retained navigation behavior**

Click platform messages, customer-service accounts, message reviews, orders, and AI configuration as an admin. Exercise the legacy WhatsApp conversation redirect, reload query state, sidebar collapse/expand, and mobile drawer close. Use the existing mocked API route layer; do not mutate the database.

- [ ] **Step 3: Run the final focused suite and browser QA**

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/navigation/*.test.js src/modules/conversations/*.test.js src/modules/platformMessages/*.test.js src/modules/accounts/*.test.js src/modules/workbench/*.test.js
npm run build
$env:NODE_PATH='C:\Users\22383\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:QA_TARGET_URL='http://127.0.0.1:3004'
& 'C:\Users\22383\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/qa-unified-navigation.cjs
```

Expected: focused tests pass, build exits 0, QA prints `{ "ok": true }`, and screenshots are saved under `E:\project\project\Rag\artifacts\ui-unification`.

## Completion criteria

- Admin sees three left-sidebar groups with every major business entry directly visible.
- Platform messages and customer-service accounts remain unified rather than duplicated per platform.
- The header has no business or system dropdown; status, reminders, and user controls remain functional.
- Review count is visible beside the left-sidebar review entry and refreshes from the existing API/WebSocket sources.
- Agent, supervisor, and admin visibility matches the role matrix.
- Desktop and mobile browser QA show no active-color spill, overlap, clipping, or horizontal overflow.
