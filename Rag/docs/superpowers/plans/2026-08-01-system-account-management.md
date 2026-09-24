# System Account Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure administrator-only lifecycle management for system login accounts inside the unified workbench.

**Architecture:** Add an isolated backend `system-accounts` module with repository, service, JWT-protected routes and safety rules. Add a focused frontend API/rules module and one Element Plus management view, then expose it through the admin-only route and collapsible system navigation.

**Tech Stack:** Node.js, Express, Sequelize, bcryptjs, jsonwebtoken, Vue 3, Pinia, Vue Router, Element Plus, Node test runner, Playwright.

---

### Task 1: Backend account rules and service

**Files:**
- Create: `rag-server/src/modules/system-accounts/systemAccounts.service.js`
- Create: `rag-server/src/modules/system-accounts/systemAccounts.service.test.js`

- [ ] **Step 1: Write failing service tests**

Cover username/password/email validation, safe response projection, current-account protection, last-active-admin protection, password hashing and duplicate conflict messages using an injected repository.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `node --test src/modules/system-accounts/systemAccounts.service.test.js`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement the service**

Expose `createSystemAccountsService({ repository, hashPassword })` with `list`, `create`, `update`, `resetPassword`, and `remove`. Permit only roles `admin`, `supervisor`, `agent` and statuses `active`, `disabled`; never return `password`.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `node --test src/modules/system-accounts/systemAccounts.service.test.js`

Expected: all service tests pass.

### Task 2: Repository and protected routes

**Files:**
- Create: `rag-server/src/modules/system-accounts/systemAccounts.repository.js`
- Create: `rag-server/src/modules/system-accounts/systemAccounts.routes.js`
- Create: `rag-server/src/modules/system-accounts/systemAccounts.routes.test.js`
- Create: `rag-server/src/modules/system-accounts/index.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Write failing route tests**

Verify missing JWT returns 401, non-admin returns 403, and admin requests reach list/create/update/reset/delete handlers without leaking password data.

- [ ] **Step 2: Run the route tests and confirm RED**

Run: `node --test src/modules/system-accounts/systemAccounts.routes.test.js`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement persistence and routing**

Use the existing `User` model for filtering, uniqueness checks, active-admin counts and CRUD. Mount the router at `/api/v1/system-accounts`; authenticate using `JWT_SECRET` and require `req.user.role === 'admin'`.

- [ ] **Step 4: Run backend tests and confirm GREEN**

Run: `node --test src/modules/system-accounts/*.test.js`

Expected: all system-account backend tests pass.

### Task 3: Unified frontend management page

**Files:**
- Create: `platform-web/src/api/systemAccounts.js`
- Create: `platform-web/src/modules/systemAccounts/accountRules.js`
- Create: `platform-web/src/modules/systemAccounts/accountRules.test.js`
- Create: `platform-web/src/views/Settings/SystemAccountsView.vue`
- Modify: `platform-web/src/router/index.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`

- [ ] **Step 1: Write failing navigation and form-rule tests**

Assert only admins receive `/settings/accounts`, form normalization enforces username/password/email/role/status rules, and the sidebar registers the system-account icon.

- [ ] **Step 2: Run frontend tests and confirm RED**

Run: `node --test src/modules/navigation/channelNavigation.test.js src/modules/systemAccounts/accountRules.test.js`

Expected: FAIL before the new route/rules exist.

- [ ] **Step 3: Implement API, page, route and navigation**

Build a compact table with keyword/role/status filters, create/edit dialogs, password reset dialog, disable/delete confirmations, current-user action locks and API error preservation. Add the admin-only `/settings/accounts` route and sidebar item.

- [ ] **Step 4: Run frontend tests and build**

Run: `node --test`

Run: `npm run build`

Expected: all frontend tests and the Vite production build pass.

### Task 4: Runtime and browser verification

**Files:**
- Modify: `platform-web/scripts/qa-unified-navigation.cjs`
- Create screenshots under: `artifacts/ui-unification/`

- [ ] **Step 1: Extend browser QA**

Mock `/api/v1/system-accounts`, verify the sidebar entry, open the page through a normal click, exercise create/edit/reset/disable confirmation controls, and check desktop, 1024px and mobile viewport fit.

- [ ] **Step 2: Rebuild and restart the backend if required**

Run: `npm run build` in `platform-web` and restart the current `rag-server` process so `/api/v1/system-accounts` is mounted.

- [ ] **Step 3: Run final verification**

Run backend system-account tests, frontend `node --test`, `npm run build`, and `node scripts/qa-unified-navigation.cjs` against `http://127.0.0.1:3004`.

Expected: zero failures, no console errors, no horizontal overflow, and the account page is visible only to admin navigation.
