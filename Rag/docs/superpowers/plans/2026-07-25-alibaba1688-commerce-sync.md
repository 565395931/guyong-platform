# 1688 订单与退款同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 1688 开放平台加密场景 API 安全接入多个店铺的订单和退款事件，并在统一前端管理账号和查看业务消息。

**Architecture:** 新增 `alibaba1688_commerce` 账号配置、param2 固定网关客户端、隐私清洗适配器和独立同步 worker，复用事件收件箱与持久游标。前端复用渠道事件页，聊天能力保持关闭。

**Tech Stack:** Node.js CommonJS、Express、Sequelize/MySQL、`json-bigint`、Vue 3、Element Plus、Node test runner、Vite。

---

### Task 1: 能力目录和账号凭据

**Files:**
- Modify: `rag-server/src/modules/channel-capabilities/channelCapabilities.js`
- Modify: `rag-server/src/modules/channel-capabilities/channelDefinitions.seed.js`
- Create: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688AccountConfig.js`
- Test: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688AccountConfig.test.js`
- Modify: `rag-server/src/routes/channelAccounts.js`
- Modify: `rag-server/src/routes/channelAccounts.presenter.js`

- [x] Write tests that require `appKey/appSecret/accessToken/sellerMemberId`, force `alibaba1688_commerce`, seed active `alibaba1688`, and reject credential echo.
- [x] Run the account test and confirm it fails because the module and capability do not exist.
- [x] Implement normalization, validation, encrypted parsing, route preparation, seed correction and masked `sellerMemberId` presentation.
- [x] Run the account, capability, seed, presenter and route contract tests and confirm they pass.

### Task 2: param2 signature and fixed gateway client

**Files:**
- Create: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688Signature.js`
- Create: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688Client.js`
- Test: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688Client.test.js`

- [x] Write deterministic tests for uppercase HMAC-SHA1, sorted form parameters, fixed HTTPS URL, ten-second timeout, JSON big integers and error redaction.
- [x] Run the client test and confirm it fails because the client does not exist.
- [x] Implement a whitelist-only client for the two approved version-1 APIs; include `access_token`, exclude `_aop_signature` from its own signature, and use `json-bigint` with identifiers stored as strings.
- [x] Run the client test and confirm transport bodies, signature inputs and errors satisfy the contract.

### Task 3: Privacy-clean order and refund normalization

**Files:**
- Create: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688Adapter.js`
- Test: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688Adapter.test.js`
- Modify: `rag-server/src/modules/channel-adapters/index.js`

- [x] Write tests for `baseInfo.idOfStr + modifyTime`, `refundId + gmtModified`, long IDs, `buyerOpenUid`, recursive PII removal and unsupported chat.
- [x] Run the adapter test and confirm the missing module failure.
- [x] Implement stable order and after-sales events, China/explicit-zone timestamp parsing, recursive privacy sanitization and `capability_not_supported` message sending.
- [x] Register `alibaba1688_commerce` and run adapter registry regressions.

### Task 4: Incremental synchronization and worker

**Files:**
- Create: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688SyncService.js`
- Test: `rag-server/src/modules/channel-adapters/alibaba1688-commerce/alibaba1688SyncService.test.js`
- Create: `rag-server/src/workers/alibaba1688SyncWorker.js`
- Test: `rag-server/src/workers/alibaba1688SyncWorker.test.js`
- Modify: `rag-server/src/app.js`

- [x] Write tests for 30-minute windows, `pageSize=20`, order page 1, refund page 0, 100-page limit, total consistency, inbox failure, cursor retention, resource isolation and worker overlap.
- [x] Run the sync and worker tests and confirm the missing module failures.
- [x] Implement complete-page buffering, strict response parsing, post-write cursor advancement and per-account failure isolation.
- [x] Start a 60-second unref worker only after `connectDB()` resolves, then run sync and worker tests.

### Task 5: Front-end routes, menu, account form and event copy

**Files:**
- Create: `platform-web/src/modules/channels/alibaba1688AccountForm.js`
- Test: `platform-web/src/modules/channels/alibaba1688AccountForm.test.js`
- Modify: `platform-web/src/modules/channels/channelCapabilities.js`
- Modify: `platform-web/src/modules/channels/channelEvents.js`
- Modify: `platform-web/src/views/Channels/ChannelEventsView.vue`
- Modify: `platform-web/src/views/Settings/AccountManage.vue`
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/router/index.js`

- [x] Write failing form, capability, empty-state, menu, role and route tests for `/1688/events` and `/1688/accounts`.
- [x] Implement the forced-adapter create request and password fields for App Secret and Access Token, clearing both after submit.
- [x] Add expandable 1688 navigation, account display, credential status, masked member ID and order/refund event presentation.
- [x] Confirm no chat controls appear, then run all front-end tests and `npm run build`.

### Task 6: MySQL contract, browser verification and operations

**Files:**
- Create: `rag-server/scripts/verify-alibaba1688-commerce-contract.js`
- Create: `docs/operations/alibaba1688-commerce.md`
- Modify: `docs/superpowers/plans/2026-07-25-alibaba1688-commerce-sync.md`

- [x] Restart local services and verify the `alibaba1688` seed, worker and existing schemas.
- [x] Run a real-MySQL contract with injected official-shaped order/refund responses and verify pagination, duplicate writes, API errors, cursor retention and account isolation.
- [ ] Verify desktop/mobile menu, account form, credential redaction, long IDs, detail drawer and the absence of chat controls in the real browser.
- [x] Run full back-end and front-end tests plus the production build, document authorization requirements, and mark every completed checkbox.
