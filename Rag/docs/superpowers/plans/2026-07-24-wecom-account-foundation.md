# Enterprise WeCom Account Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock channel-account screen with a real enterprise WeCom connection and multi-customer-service-account management vertical slice that verifies credentials through the official API and syncs `open_kfid` records into MySQL with safe default protection.

**Architecture:** Add a focused `platform-connections` module to `rag-server`, separate enterprise-level credentials from account-level `channel_accounts`, and expose admin-only connection/verification APIs. Add a production API client for the official WeCom token and customer-service account-list endpoints. Replace the hidden mock frontend with a routed, table-based “平台账号” page that manages connections and displays synced accounts.

**Tech Stack:** Node.js CommonJS, Express, Sequelize/MySQL, Axios, AES-256-GCM, built-in `node:test`, Vue 3, Element Plus, Axios, Vite.

---

## Scope and file map

Server files:

- Create `rag-server/src/modules/platform-connections/credentialCipher.js` and test: environment-keyed AES-256-GCM credential encryption.
- Create `platformConnections.validation.js` and test: normalize connection and policy inputs.
- Create `platformConnections.schema.js` and test: connection, allowlist, audit tables plus idempotent account columns.
- Create `platformConnections.repository.js` and test: parameterized persistence and account synchronization.
- Create `wecomClient.js` and test: official access-token and account-list client.
- Create `platformConnections.service.js` and test: connection lifecycle, verification, account sync, masking and protection policy.
- Create `platformConnections.routes.js` and test: admin APIs.
- Create `index.js`: production dependency wiring.
- Modify `rag-server/src/config/database.js`: initialize the new schema.
- Modify `rag-server/src/app.js`: mount `/api/v1/platform-connections`.
- Modify `rag-server/package.json`: add `test:platform-connections`.

Frontend files:

- Create `platform-web/src/api/platformConnections.js`.
- Create `platform-web/src/modules/platformConnections/connectionForm.js` and test.
- Create `platform-web/src/views/Settings/PlatformAccountsView.vue`.
- Create `platform-web/src/views/Settings/components/ConnectionTable.vue`.
- Create `platform-web/src/views/Settings/components/ConnectionDrawer.vue`.
- Create `platform-web/src/views/Settings/components/WecomAccountTable.vue`.
- Modify `platform-web/src/router/index.js` and `platform-web/src/components/Layout/AppSidebar.vue`.
- Modify `platform-web/package.json`: add `test:platform-connections`.

Repository note: `E:\project\project\Rag` is not a Git repository. Run every test and build checkpoint, but do not run `git init`. Commit steps are recorded for future use and skipped in this workspace.

### Task 1: Credential and validation contracts

**Files:**
- Create: `rag-server/src/modules/platform-connections/credentialCipher.js`
- Create: `rag-server/src/modules/platform-connections/credentialCipher.test.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.validation.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.validation.test.js`
- Modify: `rag-server/package.json`

- [ ] **Step 1: Write failing cipher and validation tests**

Tests must assert that encrypting the same object twice yields different ciphertext, decrypt restores the object, a missing/invalid 32-byte base64 key throws, connection input trims `corpId`, and credentials are required only for create/replace operations.

```js
test('encrypts credentials with a random nonce', () => {
  const cipher = createCredentialCipher({ key: Buffer.alloc(32, 7).toString('base64') })
  const first = cipher.encrypt({ secret: 'test-secret' })
  const second = cipher.encrypt({ secret: 'test-secret' })
  assert.notEqual(first, second)
  assert.deepEqual(cipher.decrypt(first), { secret: 'test-secret' })
})

test('normalizes a WeCom enterprise connection', () => {
  assert.deepEqual(normalizeConnectionInput({
    connectionName: ' 孤勇者企业微信 ', corpId: ' ww123 ', secret: ' secret ',
    callbackToken: ' token ', encodingAesKey: ' aes-key '
  }), {
    connection_name: '孤勇者企业微信', channel_code: 'wecom_kf', corp_id: 'ww123',
    secret: 'secret', callback_token: 'token', encoding_aes_key: 'aes-key'
  })
})
```

- [ ] **Step 2: Run the focused tests and confirm missing modules fail**

Run: `node --test src/modules/platform-connections/credentialCipher.test.js src/modules/platform-connections/platformConnections.validation.test.js`

Expected: both tests fail with `Cannot find module`.

- [ ] **Step 3: Implement AES-256-GCM and input normalization**

Ciphertext format is `v1.<iv-base64url>.<tag-base64url>.<body-base64url>`. `PLATFORM_CREDENTIAL_KEY` must decode to exactly 32 bytes. Never fall back to a built-in key.

Validation exports:

```js
normalizeConnectionInput(input, { requireCredentials = true })
normalizeAccountPolicy(input)
```

`normalizeAccountPolicy` accepts `protectionLevel` from `locked|test|none`, booleans for `aiEnabled` and `allowlistEnabled`, and rejects `aiEnabled=true` with `locked`.

- [ ] **Step 4: Run the tests**

Run: `npm run test:platform-connections`

Expected: all Task 1 tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 2: Idempotent MySQL schema

**Files:**
- Create: `rag-server/src/modules/platform-connections/platformConnections.schema.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.schema.test.js`
- Modify: `rag-server/src/config/database.js`

- [ ] **Step 1: Write a failing fake-Sequelize schema test**

Assert creation of `platform_connections`, `channel_account_allowlists`, `channel_sync_states`, and `channel_operation_logs`, and assert account-column checks for `connection_id`, `external_account_id`, `protection_level`, `ai_enabled`, `allowlist_enabled`, `sync_status`, `last_inbound_at`, and `last_outbound_at`.

- [ ] **Step 2: Run the schema test and confirm failure**

Run: `node --test src/modules/platform-connections/platformConnections.schema.test.js`

Expected: missing module failure.

- [ ] **Step 3: Implement `ensurePlatformConnectionsSchema(sequelize)`**

Create `platform_connections` with integer primary key, unique active business key `channel_code/corp_id`, encrypted credential columns, callback key, status, health fields, timestamps and indexes. Use `information_schema.COLUMNS` before each `ALTER TABLE channel_accounts ADD COLUMN` so startup is repeatable across MySQL versions.

Create these uniqueness rules:

```sql
UNIQUE KEY uk_platform_connection_channel_corp (channel_code, corp_id)
UNIQUE KEY uk_channel_account_connection_external (connection_id, external_account_id)
UNIQUE KEY uk_account_allowlist_identity (account_id, external_user_id)
```

Existing WhatsApp account rows keep `connection_id=NULL` and continue working.

- [ ] **Step 4: Wire schema initialization after the existing Sequelize sync**

Call `ensurePlatformConnectionsSchema(sequelize)` after catalog schema initialization and before reporting database readiness.

- [ ] **Step 5: Run schema and catalog regression tests**

Run: `npm run test:platform-connections && npm run test:catalog`

Expected: all tests pass.

- [ ] **Step 6: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 3: Repository and protected account synchronization

**Files:**
- Create: `rag-server/src/modules/platform-connections/platformConnections.repository.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Use a fake Sequelize object to assert named replacements and transaction propagation for connection creation, encrypted credential replacement, verification status, list/get, account upsert and audit writes. Assert no query concatenates `corp_id`, `open_kfid` or account name.

- [ ] **Step 2: Run and confirm missing repository failure**

Run: `node --test src/modules/platform-connections/platformConnections.repository.test.js`

- [ ] **Step 3: Implement repository methods**

Export `createPlatformConnectionsRepository(sequelize)` with:

```js
transaction, listConnections, getConnection, findByCorpId, createConnection,
replaceCredentials, updateConnectionStatus, listAccounts, getAccount,
upsertWecomAccounts, updateAccountPolicy, writeOperationLog
```

`upsertWecomAccounts` uses `(connection_id, external_account_id)` and never deletes an account missing from a later sync; it marks it `sync_status='missing'` so history remains auditable.

- [ ] **Step 4: Run repository tests**

Expected: repository tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 4: Official WeCom account discovery client

**Files:**
- Create: `rag-server/src/modules/platform-connections/wecomClient.js`
- Create: `rag-server/src/modules/platform-connections/wecomClient.test.js`

- [ ] **Step 1: Write failing client tests with a fake HTTP client**

Assert the client requests `/cgi-bin/gettoken` with `corpid` and `corpsecret`, requests `/cgi-bin/kf/account/list` with `access_token`, maps `account_list` entries to `{ externalAccountId, name, avatar }`, and throws a safe error containing `errcode` but not the Secret.

- [ ] **Step 2: Run and confirm missing client failure**

Run: `node --test src/modules/platform-connections/wecomClient.test.js`

- [ ] **Step 3: Implement the production client**

Export:

```js
createWecomClient({ httpClient = axios.create({ baseURL: 'https://qyapi.weixin.qq.com', timeout: 15000 }) })
```

Methods:

```js
getAccessToken({ corpId, secret })
listCustomerServiceAccounts({ accessToken })
verifyAndListAccounts({ corpId, secret })
```

Never log request query parameters or raw response objects.

- [ ] **Step 4: Run client tests**

Expected: all client tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 5: Connection lifecycle service and policy guard

**Files:**
- Create: `rag-server/src/modules/platform-connections/platformConnections.service.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.service.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

Tests cover:

- creating a connection encrypts all credential fields and returns no ciphertext;
- listing masks CorpID and never returns credentials;
- verifying decrypts credentials, calls the official client, marks the connection verified and synchronizes all `open_kfid` values in one transaction;
- every new account defaults to `locked`, AI off and allowlist on;
- the configured protected name `客服1号` receives `locked_reason='production_baseline'`;
- `客服1号` cannot transition out of `locked`;
- a non-baseline account may transition to `test`, but `test` requires allowlist enabled.

- [ ] **Step 2: Run and confirm missing service failure**

Run: `node --test src/modules/platform-connections/platformConnections.service.test.js`

- [ ] **Step 3: Implement `createPlatformConnectionsService`**

Dependencies:

```js
{ repository, credentialCipher, wecomClient, protectedAccountNames = ['客服1号'], now = () => new Date() }
```

Public methods:

```js
listConnections, createConnection, replaceCredentials, verifyConnection,
listAccounts, updateAccountPolicy
```

All mutation methods write `channel_operation_logs`. Verification failures store `health_status='error'` and a sanitized message, then rethrow a domain error with HTTP-safe text.

- [ ] **Step 4: Run service tests**

Expected: service tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 6: Admin REST API and production wiring

**Files:**
- Create: `rag-server/src/modules/platform-connections/platformConnections.routes.js`
- Create: `rag-server/src/modules/platform-connections/platformConnections.routes.test.js`
- Create: `rag-server/src/modules/platform-connections/index.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Write failing route tests**

Using an injected authentication middleware and fake service, assert these routes and permissions:

```text
GET    /                         admin, supervisor
POST   /                         admin
PATCH  /:id/credentials          admin
POST   /:id/verify               admin
GET    /:id/accounts             admin, supervisor
PATCH  /accounts/:accountId/policy admin, supervisor
```

Assert agents receive 403, validation errors 400, missing records 404, duplicate corp IDs 409, and secrets/ciphertext never appear in JSON.

- [ ] **Step 2: Run and confirm missing route failure**

- [ ] **Step 3: Implement router and dependency wiring**

JWT authentication requires `JWT_SECRET`; no default is introduced. Production wiring reads `PLATFORM_CREDENTIAL_KEY`, constructs the repository, cipher, client and service, and exports the router.

- [ ] **Step 4: Mount the router**

In `app.js` mount:

```js
app.use('/api/v1/platform-connections', platformConnectionsRoutes)
```

- [ ] **Step 5: Run server regression tests**

Run:

```powershell
npm run test:platform-connections
npm run test:catalog
node --test src/modules/messaging/inboundMessage.service.test.js src/modules/cloud-gateway/cloudGateway.test.js
node --check src/app.js
```

Expected: every command exits 0.

- [ ] **Step 6: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 7: Frontend API and form contract

**Files:**
- Create: `platform-web/src/api/platformConnections.js`
- Create: `platform-web/src/modules/platformConnections/connectionForm.js`
- Create: `platform-web/src/modules/platformConnections/connectionForm.test.js`
- Modify: `platform-web/package.json`

- [ ] **Step 1: Write failing form tests**

Assert trimming, `wecom_kf` defaults, required CorpID/Secret/Token/AES key, safe policy combinations, and that existing masked secrets are not submitted as replacements.

- [ ] **Step 2: Run and confirm missing module failure**

Run: `node --test src/modules/platformConnections/connectionForm.test.js`

- [ ] **Step 3: Implement form helpers and API methods**

API exports:

```js
getPlatformConnections, createPlatformConnection, replacePlatformCredentials,
verifyPlatformConnection, getConnectionAccounts, updateAccountPolicy
```

Form exports:

```js
normalizeConnectionForm, validateConnectionForm, normalizePolicyForm, validatePolicyForm
```

- [ ] **Step 4: Run frontend form tests**

Run: `npm run test:platform-connections`

Expected: tests pass.

- [ ] **Step 5: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 8: Real “平台账号” management page

**Files:**
- Create: `platform-web/src/views/Settings/PlatformAccountsView.vue`
- Create: `platform-web/src/views/Settings/components/ConnectionTable.vue`
- Create: `platform-web/src/views/Settings/components/ConnectionDrawer.vue`
- Create: `platform-web/src/views/Settings/components/WecomAccountTable.vue`
- Modify: `platform-web/src/router/index.js`
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`

- [ ] **Step 1: Add `/platform-accounts` route and sidebar item, then verify the missing view fails the build**

Menu label is “平台账号”, using the existing Element Plus `Connection` icon. Access is visible to `admin` and `supervisor`; mutations remain server-authorized.

- [ ] **Step 2: Implement the page shell**

Use an operational table layout:

- enterprise connection table at the top;
- selected connection’s synced accounts below;
- “添加企业主体” opens a drawer;
- “验证并同步账号” shows loading and refreshes both tables;
- connection status, masked CorpID, account count, last callback, last sync and error are visible.

- [ ] **Step 3: Implement the credential drawer**

Fields are connection name, CorpID, Secret, callback Token and EncodingAESKey. Secret inputs use password type and are cleared on close. Existing credentials are never populated into the form.

- [ ] **Step 4: Implement the account table and protection controls**

Columns are account name, masked `open_kfid`, protection level, AI, whitelist, sync state and last activity. `locked_reason='production_baseline'` displays “生产保护” and disables all protection/AI controls. Other locked accounts may be explicitly switched to “测试模式”; AI cannot turn on until test mode and whitelist are active.

- [ ] **Step 5: Run unit tests and production build**

Run:

```powershell
npm run test:platform-connections
npm run test:catalog
npm run build
```

Expected: all tests pass and Vite completes.

- [ ] **Step 6: Perform Playwright visual checks**

Check 1440x1000 and 820x900 with mocked management responses. Verify tables do not overlap, credential fields are masked, the production protection controls are disabled, and the test account policy flow is understandable.

- [ ] **Step 7: Commit checkpoint**

Skip because the workspace is not a Git repository.

### Task 9: Local MySQL integration and operator documentation

**Files:**
- Create: `docs/wecom-account-operations.md`
- Modify: `.env` only for the user-provided local database password; never write it to source, tests, logs or documentation.

- [ ] **Step 1: Update only the local `DB_PASSWORD` setting**

Preserve all unrelated `.env` values. Confirm `.env` remains outside version control if Git is initialized later.

- [ ] **Step 2: Ensure `PLATFORM_CREDENTIAL_KEY` exists**

Generate a cryptographically random 32-byte base64 key for local development only. Do not print it. Production receives a separately generated key through the deployment secret manager.

- [ ] **Step 3: Start MySQL-backed `rag-server` without Redis-dependent AI sends**

Verify schema initialization, then call the authenticated list API. Do not create or verify a production enterprise connection during automated checks.

- [ ] **Step 4: Write the operator guide**

Document permissions, adding a subject, credential replacement, verification and sync, account protection levels, test-mode enablement, connection errors, rollback/disable and the rule that “客服1号” remains production-locked.

- [ ] **Step 5: Run final verification**

Run the complete backend and frontend commands from Tasks 6 and 8, confirm the local server starts with MySQL, and record any remaining Redis runtime prerequisite without weakening the send guard.

## Completion criteria

- “平台账号” is a real routed page, not mock data.
- Admin can save encrypted enterprise WeCom credentials and verify them with the official API.
- Verification synchronizes multiple `open_kfid` accounts under one enterprise connection.
- Synced accounts default to safe locked/AI-off policy.
- “客服1号” cannot be unlocked by this phase’s API or UI.
- Existing WhatsApp account rows and message regression tests remain green.
- No production WeCom reply, callback change or account-state mutation occurs during local verification.
