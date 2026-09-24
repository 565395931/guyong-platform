# 淘宝 / 千牛订单与退款同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Complete each task with RED, GREEN, specification review and code-quality review.

**Goal:** 通过淘宝开放平台官方 API 安全接入多个店铺的订单和退款事件，并在统一前端管理账号与查看业务消息。

**Architecture:** 新增 `taobao_commerce` 适配器、固定网关客户端和独立同步 worker，复用现有事件收件箱与持久游标。前端复用渠道事件页，聊天能力始终关闭。

### Task 1: 能力目录和账号凭据

**Files:**
- Modify: `rag-server/src/modules/channel-capabilities/channelCapabilities.js`
- Modify: `rag-server/src/modules/channel-capabilities/channelDefinitions.seed.js`
- Create: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoAccountConfig.js`
- Test: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoAccountConfig.test.js`
- Modify: `rag-server/src/routes/channelAccounts.js`
- Modify: `rag-server/src/routes/channelAccounts.presenter.js`

- [x] Write failing capability, credential validation, forced-adapter and redaction tests.
- [x] Implement `appKey/appSecret/sessionKey/sellerNick` validation and encrypted config parsing.
- [x] Seed active `taobao` with adapter `taobao_commerce` idempotently.
- [x] Return only `credentialStatus` and `sellerNickMask`; run related tests.

### Task 2: TOP signer and fixed gateway client

**Files:**
- Create: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoSignature.js`
- Create: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoClient.js`
- Test: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoClient.test.js`

- [x] Write deterministic MD5 signature, form POST, timestamp and error-redaction tests.
- [x] Sign every non-null parameter except `sign` using sorted TOP parameters.
- [x] POST only to `https://eco.taobao.com/router/rest` with a ten-second timeout.
- [x] Parse JSON without losing large order/refund IDs and map stable redacted errors.

### Task 3: Order and refund normalization

**Files:**
- Create: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoAdapter.js`
- Test: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoAdapter.test.js`
- Modify: `rag-server/src/modules/channel-adapters/index.js`

- [x] Write failing stable-ID, China-time, large-ID and unsupported-chat tests.
- [x] Normalize orders from `tid + modified` and refunds from `refund_id + modified`.
- [x] Preserve `buyer_open_uid/ouid` in payload and fail closed on unstable identifiers.
- [x] Register the adapter without regressing Pinduoduo, Douyin or WAHA.

### Task 4: Reverse pagination and automatic sync

**Files:**
- Create: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoSyncService.js`
- Test: `rag-server/src/modules/channel-adapters/taobao-commerce/taobaoSyncService.test.js`
- Create: `rag-server/src/workers/taobaoSyncWorker.js`
- Test: `rag-server/src/workers/taobaoSyncWorker.test.js`
- Modify: `rag-server/src/app.js`

- [x] Write failing 30-minute window, reverse-pagination, cursor and overlap tests.
- [x] Request only approved order/refund fields with `page_size=100`.
- [x] Discover total pages, then fetch from the last page back to page one, maximum 100 pages.
- [x] Advance each resource cursor only after all records are stored; isolate bad accounts.
- [x] Start the 60-second worker only after `connectDB()` resolves.

### Task 5: Shared front-end routes, menu and account form

**Files:**
- Create: `platform-web/src/modules/channels/taobaoAccountForm.js`
- Test: `platform-web/src/modules/channels/taobaoAccountForm.test.js`
- Modify: `platform-web/src/modules/channels/channelCapabilities.js`
- Modify: `platform-web/src/modules/channels/channelEvents.js`
- Modify: `platform-web/src/views/Channels/ChannelEventsView.vue`
- Modify: `platform-web/src/views/Settings/AccountManage.vue`
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/router/index.js`

- [x] Write failing form, route, menu and channel-specific event-copy tests.
- [x] Add expandable “淘宝 / 千牛” routes with role-protected account management.
- [x] Add password fields for App Secret and Session Key and clear them after submit.
- [x] Show order/refund and customer-identity capabilities without chat controls.
- [x] Run all front-end tests and production build.

### Task 6: Local contract verification and operations

**Files:**
- Create: `docs/operations/taobao-commerce.md`
- Modify: `docs/superpowers/plans/2026-07-25-taobao-commerce-sync.md`

- [x] Restart local services and verify seed, worker and existing schemas.
- [x] Run a real-MySQL contract flow with injected TOP-shaped order/refund responses.
- [x] Verify reverse pagination, duplicate writes, API errors, cursor retention and account isolation.
- [x] Verify desktop/mobile menu, account form, credential redaction and detail drawer in a real browser.
- [x] Run full back-end and front-end regressions and document production authorization requirements.
