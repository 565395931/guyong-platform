# AI Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, editable DashScope credentials, connection testing, model discovery, balance capability reporting, and model selectors to AI configuration.

**Architecture:** A provider registry owns third-party API differences. An encrypted credential store exposes only sanitized metadata and supplies runtime clients without sending secrets to browsers.

**Tech Stack:** Node.js, Express, OpenAI SDK-compatible HTTP, MySQL configuration storage, Vue 3, Element Plus, node:test.

---

### Task 1: Provider domain and credential security

**Files:**
- Create: `rag-server/src/modules/ai-provider/credentialCipher.js`
- Create: `rag-server/src/modules/ai-provider/providerRegistry.js`
- Test: `rag-server/src/modules/ai-provider/*.test.js`

- [ ] Write failing tests for AES-GCM round trips, tamper rejection, sanitized metadata, model normalization, and unsupported balance.
- [ ] Run `node --test src/modules/ai-provider/*.test.js` and verify failure due to missing modules.
- [ ] Implement the minimum provider modules and rerun until green.

### Task 2: Persistence and admin API

**Files:**
- Create: `rag-server/src/modules/ai-provider/providerService.js`
- Modify: `rag-server/src/routes/conversations.js`
- Test: `rag-server/src/modules/ai-provider/providerService.test.js`

- [ ] Test environment fallback, encrypted override, clear behavior, test credential selection, cached model retention, and safe status output.
- [ ] Implement service dependency injection and admin endpoints.
- [ ] Run provider and message-review test suites.

### Task 3: Runtime credential routing

**Files:**
- Modify: `rag-server/src/modules/rag/langchainService.js`
- Modify: `rag-server/src/services/translationService.js`
- Modify: `rag-server/src/modules/message-review/index.js`

- [ ] Add tests proving runtime settings never expose credentials in public projections.
- [ ] Route client construction through current provider runtime settings while retaining environment fallback.
- [ ] Run server tests.

### Task 4: AI configuration UI

**Files:**
- Modify: `platform-web/src/api/aiConfig.js`
- Modify: `platform-web/src/modules/aiConfig/aiConfigForm.js`
- Modify: `platform-web/src/modules/aiConfig/aiConfigForm.test.js`
- Modify: `platform-web/src/views/Settings/AiConfigView.vue`

- [ ] Write failing frontend tests for model selector metadata and provider controls.
- [ ] Add the provider band, masked credential editing, connection test, clear confirmation, model sync, balance state, and searchable custom model selectors.
- [ ] Run `npm run test:ai-config` and `npm run build`.

### Task 5: Full verification

- [ ] Run `node --test src/modules/ai-provider/*.test.js src/modules/message-review/*.test.js` in `rag-server`.
- [ ] Run `npm run test:ai-config` and `npm run build` in `platform-web`.
- [ ] Inspect the final diff for secret leakage and unrelated changes.
