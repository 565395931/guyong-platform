# Multilingual Translation Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing translation helpers into a provider-neutral plugin that detects each customer message language, stores both languages, automatically replies in the latest customer language, supports human language modes, applies evidence-based politeness, and enriches customer profiles and reports.

**Architecture:** Keep channel adapters unchanged and place a translation orchestration boundary between persisted messages and outbound delivery. Existing `translationService.js` becomes the initial DashScope provider adapter; durable translation jobs, versioned translations, language profiles, glossary rules, and quality gates provide reliability and vendor independence.

**Tech Stack:** Node.js CommonJS, Express, Sequelize raw SQL, MySQL JSON, Zod, LangChain/OpenAI-compatible providers, `node:test`, Vue 3, Element Plus, Pinia, Vite.

**Execution note:** `E:\project\project\Rag` currently has no Git metadata, so each focused green test run is the checkpoint.

**Dependency:** Execute `2026-08-04-customer-conversation-workspace.md` first. Translation backend Tasks 1-7 can be developed independently, while Tasks 8-10 reuse its customer drawer, exact-conversation deep links, authorization middleware, Playwright setup, and report context.

---

### Task 1: Define the Provider-Neutral Translation Contract

**Files:**
- Create: `rag-server/src/modules/translation/translation.schema.js`
- Create: `rag-server/src/modules/translation/translation.schema.test.js`
- Create: `rag-server/src/modules/translation/translationProvider.js`
- Create: `rag-server/src/modules/translation/providers/dashscopeTranslationProvider.js`
- Modify: `rag-server/src/services/translationService.js`

- [ ] **Step 1: Write failing schema tests**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTranslationRequest, parseTranslationResult } = require('./translation.schema')

test('normalizes one-message language detection to BCP-47', () => {
  const input = parseTranslationRequest({
    operation: 'detect', sourceText: '¿Tienen stock?', sourceLanguage: 'auto',
    targetLanguage: 'zh-CN', contentType: 'customer_message',
    localeContext: { formality: 'neutral', scenario: 'sales', glossaryVersion: 0 },
    idempotencyKey: 'message:m1:detect'
  })
  assert.equal(input.targetLanguage, 'zh-CN')
})

test('rejects provider output with an unknown language or oversized text', () => {
  assert.throws(() => parseTranslationResult({ detectedLanguage: 'not-a-language', translatedText: 'x' }), /language/i)
  assert.throws(() => parseTranslationResult({ detectedLanguage: 'es', translatedText: 'x'.repeat(20001) }), /too_big/i)
})
```

- [ ] **Step 2: Run and verify RED**

Run from `rag-server`: `node --test src/modules/translation/translation.schema.test.js`

- [ ] **Step 3: Implement strict schemas and error codes**

```js
const { z } = require('zod')
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/)
const requestSchema = z.object({
  operation: z.enum(['detect','translate','localize','quality_check']),
  sourceText: z.string().trim().min(1).max(20000),
  sourceLanguage: z.union([language, z.literal('auto')]),
  targetLanguage: language,
  contentType: z.enum(['customer_message','ai_reply','human_reply']),
  localeContext: z.object({
    region: z.string().max(16).nullable().optional(),
    formality: z.enum(['formal','neutral','casual']),
    scenario: z.enum(['sales','followup','order','support']),
    glossaryVersion: z.number().int().nonnegative()
  }),
  idempotencyKey: z.string().min(8).max(200)
})

const resultSchema = z.object({
  detectedLanguage: language,
  translatedText: z.string().max(20000),
  confidence: z.number().min(0).max(1),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  qualityFlags: z.array(z.string().max(100)).max(20),
  glossaryHits: z.array(z.string().max(200)).max(100),
  version: z.number().int().positive(),
  processedAt: z.string().datetime()
})

module.exports = {
  parseTranslationRequest: value => requestSchema.parse(value),
  parseTranslationResult: value => resultSchema.parse(value)
}
```

- [ ] **Step 4: Define the provider interface and DashScope adapter**

```js
function assertTranslationProvider(provider) {
  for (const name of ['detect','translate','localize','qualityCheck']) {
    if (typeof provider?.[name] !== 'function') throw new TypeError(`Translation provider missing ${name}`)
  }
  return provider
}
module.exports = { assertTranslationProvider }
```

Move direct `ChatOpenAI` construction behind `dashscopeTranslationProvider.js`. Keep existing exported functions in `translationService.js` as compatibility wrappers that call the default provider through the new service.

- [ ] **Step 5: Run schema and legacy compatibility tests**

Add tests proving `detectLanguage`, `translateToChinese`, `translateFromChinese`, and `processTranslation` retain their current return shapes while the new contract returns provider metadata.

### Task 2: Add Versioned Translation, Language Profile, Glossary, and Job Storage

**Files:**
- Modify: `rag-server/src/config/database.js`
- Create: `rag-server/src/modules/translation/translation.repository.js`
- Test: `rag-server/src/modules/translation/translation.repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Assert SQL uses parameter replacements and these unique keys:

```sql
UNIQUE KEY uk_message_translation_version (message_id, target_language, version),
UNIQUE KEY uk_translation_job_idempotency (idempotency_key),
UNIQUE KEY uk_customer_language_profile (customer_id),
UNIQUE KEY uk_glossary_term (scope_type, scope_id, source_language, target_language, source_term, version)
```

- [ ] **Step 2: Add additive migrations**

Create `message_translations`, `customer_language_profiles`, `translation_glossary_entries`, and `translation_jobs` with the approved fields. Add source/final text hashes for deduplication, `expected_version`, `lease_until`, bounded error codes, and indexes for pending jobs and customer language filters.

- [ ] **Step 3: Implement repository methods**

```js
createJobIfMissing(input, transaction)
claimJobs({ workerId, limit, leaseUntil }, transaction)
completeJob(input, transaction)
retryJob(input, transaction)
appendTranslationVersion(input, transaction)
selectFinalVersion(input, transaction)
getMessageTranslations(messageId, scope, transaction)
getLanguageProfile(customerId, scope, transaction)
upsertLanguageObservation(input, transaction)
lockLanguageProfile(input, transaction)
listGlossaryEntries(input, transaction)
```

`appendTranslationVersion` inserts a new immutable row; `selectFinalVersion` atomically clears the previous final flag and selects one version after checking `expectedVersion`.

`listGlossaryEntries` merges scopes in this exact priority order: system, enterprise, product, customer; later scopes override identical normalized source terms. Return the resolved `glossaryVersion` with every translation.

- [ ] **Step 4: Run repository tests**

Run: `node --test src/modules/translation/translation.repository.test.js`

Expected: migration, parameterization, version, lease, and idempotency assertions pass.

### Task 3: Implement the Translation Orchestrator and Provider Fallback

**Files:**
- Create: `rag-server/src/modules/translation/translation.service.js`
- Test: `rag-server/src/modules/translation/translation.service.test.js`
- Create: `rag-server/src/modules/translation/translation.worker.js`
- Test: `rag-server/src/modules/translation/translation.worker.test.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Write failing orchestration tests**

Cover primary success, primary timeout → fallback success, all providers fail, duplicate idempotency key, provider returning source text for a Chinese-to-foreign request, stale version, and expired worker lease.

- [ ] **Step 2: Implement deterministic provider selection**

```js
function createTranslationService({ providers, repository, glossary, clock = () => new Date() }) {
  async function execute(request) {
    const input = parseTranslationRequest(request)
    const errors = []
    for (const provider of providers) {
      try {
        const result = await providerRun(provider, input, glossary)
        return parseTranslationResult(result)
      } catch (error) {
        errors.push({ provider: provider.name, code: classifyTranslationError(error) })
      }
    }
    throw Object.assign(new Error('All translation providers failed'), { code: 'PROVIDERS_EXHAUSTED', errors })
  }
  return { execute }
}
```

Provider order comes from existing configuration; timeouts are bounded. Never fall back to sending the source text when target language differs.

- [ ] **Step 3: Implement the leased worker**

Claim pending jobs with the repository, execute the orchestrator, append a version, update the message/profile where required, and mark complete. Retry only timeout, rate-limit, and transient provider failures with capped exponential backoff. Permanent schema or safety failures become `needs_human`.

Add a daily retention pass that deletes expired provider payloads and diagnostic evidence while preserving the minimum audit metadata, hashes, final text required for message history, and legally configured retention fields.

- [ ] **Step 4: Start and stop the worker with the app**

Follow the existing customer operations timer lifecycle. Do not create real intervals in `NODE_ENV=test`; call `.unref()` when available.

- [ ] **Step 5: Run service and worker tests**

Run: `node --test src/modules/translation/translation.service.test.js src/modules/translation/translation.worker.test.js`

### Task 4: Make the Latest Inbound Message the Current Reply Language

**Files:**
- Create: `rag-server/src/modules/translation/languageProfile.service.js`
- Test: `rag-server/src/modules/translation/languageProfile.service.test.js`
- Modify: `rag-server/src/services/languageGuard.js`
- Modify: `rag-server/src/modules/messaging/messaging.service.js`
- Test: `rag-server/src/modules/messaging/inboundMessage.service.test.js`

- [ ] **Step 1: Write one-message and long-term-language tests**

```js
test('one Spanish inbound message immediately sets current reply language', async () => {
  await service.observe({ customerId: 'c1', messageId: 'm1', language: 'es', confidence: 0.98 })
  const profile = await service.get('c1')
  assert.equal(profile.currentReplyLanguage, 'es')
})

test('one switched message does not overwrite locked preferred language', async () => {
  repo.profile = { preferredLanguage: 'en', preferredLockedBy: 7 }
  await service.observe({ customerId: 'c1', messageId: 'm2', language: 'es', confidence: 0.98 })
  assert.equal(repo.profile.currentReplyLanguage, 'es')
  assert.equal(repo.profile.preferredLanguage, 'en')
})
```

- [ ] **Step 2: Implement language observation rules**

Every valid text inbound updates `current_reply_language`. Maintain language counts and last-used time. Update unlocked `preferred_language` only when a language wins the configured historical threshold; never infer region solely from language.

- [ ] **Step 3: Replace ad hoc DB lookup in `languageGuard`**

`resolveCustomerLanguage` first loads the language profile, then falls back to the latest message for legacy rows. Preserve the heuristic fallback but return `confidence` and `source`.

- [ ] **Step 4: Integrate after inbound persistence**

The message transaction enqueues `detect` and `translate-to-zh-CN` jobs keyed by message ID. The original `content.text` remains unchanged; completed translations write versioned rows and a compatibility `content.translatedText` projection.

- [ ] **Step 5: Run language profile and inbound tests**

Expected: a single new language takes effect for the next reply; preferred lock, mixed-language fallback, duplicate inbound, and translation failure all behave deterministically.

### Task 5: Add Glossary, Politeness Localization, and Entity Quality Gates

**Files:**
- Create: `rag-server/src/modules/translation/translationQuality.js`
- Test: `rag-server/src/modules/translation/translationQuality.test.js`
- Create: `rag-server/src/modules/translation/culturalLocalization.service.js`
- Test: `rag-server/src/modules/translation/culturalLocalization.service.test.js`

- [ ] **Step 1: Write failing entity-preservation tests**

```js
assert.deepEqual(compareEntities(
  '价格是 USD 1,250，8月20日发货，型号 A-17。',
  'The price is USD 1,250, shipping on August 20, model A-17.'
).flags, [])
assert.ok(compareEntities('退款 100 元', 'Refund 10 yuan').flags.includes('amount_mismatch'))
assert.ok(compareEntities('不包含运费', 'Includes shipping').flags.includes('negation_risk'))
```

- [ ] **Step 2: Implement deterministic quality checks**

Extract currencies, normalized numbers, dates, addresses when structured, product model tokens, URLs, and negation markers. Return `blockingFlags` for amount/date/model/negation mismatches and `warningFlags` for ambiguous names or addresses.

- [ ] **Step 3: Implement evidence-based localization**

Build a structured prompt from confirmed region, language, formality, scenario, glossary, and customer preference. Customer message text is enclosed as data and cannot alter system rules. If region is unknown, apply only language-generic courtesy. Output strict JSON `{ text, rationale, confidence, appliedRules }`.

- [ ] **Step 4: Run quality and localization tests**

Include prompt-injection strings, sensitive nationality stereotypes, unknown region, customer-confirmed terminology, and formal/casual differences. Sensitive or stereotype fields must be rejected.

### Task 6: Route AI Automatic Replies Through the Plugin Quality Gate

**Files:**
- Modify: `rag-server/src/modules/conversation-pool/ai-auto-reply.service.js`
- Modify: `rag-server/src/modules/messaging/messaging.service.js`
- Modify: `rag-server/src/services/languageGuard.js`
- Test: `rag-server/src/modules/translation/aiAutoReplyTranslation.test.js`

- [ ] **Step 1: Write failing automatic-reply tests**

Cover: one Spanish customer message → Spanish outbound; system stores Chinese canonical and Spanish final; quality failure → `needs_human` and no adapter call; AI-mode disabled → suggestion only; duplicate job → one outbound.

- [ ] **Step 2: Replace direct translation calls with an outbound command**

```js
const command = await translationOutbound.prepare({
  conversationId,
  sourceText: chineseCanonicalReply,
  sourceLanguage: 'zh-CN',
  mode: 'follow_customer',
  contentType: 'ai_reply',
  idempotencyKey: `ai-reply:${replyJobId}:translate`
})
if (command.status !== 'ready') return markReplyNeedsHuman(replyJobId, command.reason)
await outboundDispatcher.send({ ...message, content: { text: command.finalText, translatedText: chineseCanonicalReply } })
```

Only `ready` commands reach a channel adapter. Preserve the existing AI conversation mode and review policy; translation does not grant send permission.

- [ ] **Step 3: Persist both language versions and audit**

Store the Chinese canonical text, machine candidate, localized candidate, final target text, provider/model, glossary version, quality flags, and outbound channel message ID. Do not write full prompts or secrets to logs.

- [ ] **Step 4: Run AI reply translation tests and existing review tests**

Run: `node --test src/modules/translation/aiAutoReplyTranslation.test.js src/modules/message-review/*.test.js src/workers/aiReplyReviewGuard.test.js`

Expected: all tests pass and no failed/blocked translation reaches the fake adapter.

### Task 7: Add Human Reply Modes, Preview, Correction, and Retry APIs

**Files:**
- Create: `rag-server/src/modules/translation/translation.routes.js`
- Test: `rag-server/src/modules/translation/translation.routes.test.js`
- Modify: `rag-server/src/routes/conversations.js`
- Modify: `rag-server/src/modules/messaging/messaging.service.js`

- [ ] **Step 1: Write failing API tests**

Test `follow_customer`, `original`, and `specified_language`; one-message language selection; preview without send; final edited translation; translation retry; optimistic version conflict; unauthorized conversation; unsupported file translation; and idempotent send replay.

- [ ] **Step 2: Define request schemas**

```js
const modeSchema = z.object({
  mode: z.enum(['follow_customer','original','specified_language']),
  targetLanguage: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).optional(),
  scope: z.enum(['next_message','conversation']),
  expectedVersion: z.number().int().nonnegative()
}).superRefine((value, ctx) => {
  if (value.mode === 'specified_language' && !value.targetLanguage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'targetLanguage is required' })
  }
})
```

- [ ] **Step 3: Add approved endpoints**

Implement language context, language mode, translation preview, retry, final correction, customer language profile, and glossary routes. Every endpoint rechecks object authorization. Preview creates a candidate version but never dispatches. Correction requires reason and creates an audit event.

- [ ] **Step 4: Refactor the existing message send route**

Accept `languageMode`, `targetLanguage`, `translationVersion`, `expectedVersion`, and `Idempotency-Key`. For `follow_customer`, load the latest current language even if only one inbound exists. For `original`, still enqueue a Chinese counterpart after send. For `specified_language`, validate the language against the allowlist.

- [ ] **Step 5: Run route tests**

Expected: preview/send separation, version checks, role isolation, correction audit, failure no-send, and replay tests pass.

### Task 8: Upgrade the Composer and Message Bubbles to Full Bilingual UX

**Files:**
- Create: `platform-web/src/modules/translation/translationUi.js`
- Test: `platform-web/src/modules/translation/translationUi.test.js`
- Modify: `platform-web/src/api/messages.js`
- Modify: `platform-web/src/components/Chat/ChatInput.vue`
- Modify: `platform-web/src/components/Chat/ChatWindow.vue`
- Modify: `platform-web/src/components/Chat/MessageBubble.vue`

- [ ] **Step 1: Write failing UI normalization tests**

```js
assert.deepEqual(normalizeLanguageMode({ currentReplyLanguage: 'es' }), {
  mode: 'follow_customer', targetLanguage: 'es', label: '跟随客户 · 西班牙语'
})
assert.equal(canSendTranslation({ status: 'failed' }), false)
assert.equal(canSendTranslation({ status: 'ready', blockingFlags: [] }), true)
```

- [ ] **Step 2: Add a compact segmented language control**

Replace the separate “翻译并发送” command with a segmented/menu control: 跟随客户、原文、指定语言. Show the detected target language and a non-blocking notice when it changed after the latest customer message. Preserve the primary send button and keyboard behavior.

- [ ] **Step 3: Add debounced translation preview**

For Chinese text in follow/specify mode, request preview after a short debounce and show the final target text below the editor. Allow editing the candidate. Amount/date/model blocking flags disable send and explain the mismatch. Preserve drafts across 409 or provider failures.

- [ ] **Step 4: Normalize both language directions in messages**

Display customer original + Chinese translation; display AI/agent Chinese canonical + actual sent text. Add status text for translating, low confidence, failed, corrected, and final. Keep original messages immutable and use plain text rendering.

- [ ] **Step 5: Run UI module tests and build**

Run: `node --test src/modules/translation/translationUi.test.js` and `npm run build` from `platform-web`.

Expected: tests pass and no text/button overflows at narrow widths.

### Task 9: Add Language Profile, Glossary Administration, and Report Metrics

**Files:**
- Create: `platform-web/src/components/CustomerWorkspace/CustomerLanguageProfile.vue`
- Create: `platform-web/src/modules/customers/customerLanguageProfile.js`
- Test: `platform-web/src/modules/customers/customerLanguageProfile.test.js`
- Modify: `platform-web/src/components/CustomerWorkspace/CustomerOverview.vue`
- Modify: `platform-web/src/views/Customers/CustomerProfileView.vue`
- Modify: `platform-web/src/views/Customers/CustomersView.vue`
- Modify: `platform-web/src/views/Settings/AiConfigView.vue`
- Modify: `platform-web/src/api/customers.js`
- Modify: `rag-server/src/modules/customer-operations/customerReports.service.js`
- Test: `rag-server/src/modules/customer-operations/customerReports.service.test.js`
- Modify: `rag-server/src/services/configService.js`
- Modify: `rag-server/src/modules/translation/translation.routes.js`

- [ ] **Step 1: Write failing language-profile tests**

Test current vs preferred language, locked preferred language, used-language percentages, region source, formality, courtesy evidence, glossary version, and role-aware edit permissions.

- [ ] **Step 2: Add profile and drawer sections**

Show current reply language, preferred language, language history, region/source, formality, address preference, courtesy suggestions, terminology, confidence, and audit changes. Agents may correct visible customers; only supervisors/admins may lock region or enterprise terminology.

- [ ] **Step 3: Extend customer list and report filters**

Extend the report service and API with preferred language, region, confidence, pending translation, failed translation, low confidence, and human takeover filters. Aggregate language distribution and translation quality metrics using only currently authorized customer/message rows. Clicking a metric filters the action list and preserves exact-conversation deep links.

- [ ] **Step 4: Add privileged glossary/provider settings**

Add admin-only configuration routes for translation provider order, bounded timeout, retention, and fallback policy through `configService`; add supervisor/admin glossary routes with scope checks. Place the controls inside `Settings/AiConfigView.vue`. Do not add a left sidebar item and never expose credentials in GET responses.

- [ ] **Step 5: Run profile/report/navigation tests and build**

Run: `node --test src/modules/customers/customerLanguageProfile.test.js src/modules/customers/customerReport.test.js src/modules/navigation/channelNavigation.test.js` and `npm run build`.

### Task 10: Translation Integration, E2E, Security, and Coverage Gate

**Files:**
- Create: `platform-web/e2e/multilingual-chat.spec.js`
- Modify: `platform-web/playwright.config.js`
- Modify: `platform-web/package.json`
- Test: all translation files above

- [ ] **Step 1: Add backend integration scenarios**

Use fake providers and a disposable database to cover Spanish one-message reply, mid-conversation switch, mixed language, locked preferred language, prompt injection, entity mismatch, primary/fallback providers, all-provider failure, duplicate message, duplicate AI reply, role isolation, and glossary versioning.

- [ ] **Step 2: Add Playwright bilingual chat scenarios**

Cover inbound original/Chinese display; AI Chinese canonical/Spanish final; human follow/original/specified modes; editable preview; failed translation preserving draft; language profile update; report language filtering; and mobile composer layout.

- [ ] **Step 3: Run the complete translation verification loop**

Run from `rag-server`:

```powershell
node --test src/modules/translation/*.test.js src/modules/messaging/inboundMessage.service.test.js src/modules/message-review/*.test.js src/workers/aiReplyReviewGuard.test.js
npm audit --audit-level=high
```

Run from `platform-web`:

```powershell
node --test src/modules/translation/*.test.js src/modules/customers/customerLanguageProfile.test.js src/modules/customers/customerReport.test.js src/modules/navigation/channelNavigation.test.js
npm run build
npx playwright test e2e/multilingual-chat.spec.js
npm audit --audit-level=high
```

Expected: all focused tests, build, E2E, and dependency audits pass. Live-provider tests are optional and must never log full customer messages or secrets.

- [ ] **Step 4: Enforce new-file coverage and no-sidebar regression**

Run Node coverage for translation services, repositories, schemas, language profile logic, and frontend normalization. Require at least 80% line coverage for new files. Confirm the existing sidebar and navigation definitions are unchanged.
