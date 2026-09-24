# Enterprise WeCom Official Adapter Foundation Implementation Plan

**Execution status:** Completed and verified locally on 2026-07-24. No production WeCom connection, callback, or send was used.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline-verifiable enterprise WeCom adapter foundation that accepts encrypted callback notifications, pulls and normalizes customer-service messages, and publishes encrypted runtime configuration from Rag without contacting production.

**Architecture:** `rag-server` remains the source of truth for enterprise connections and publishes a versioned encrypted runtime snapshot over the authenticated cloud-gateway protocol. `wehook` applies only newer snapshots, verifies/decrypts WeCom callbacks, uses an injected official API client to pull messages, and hands normalized `wecom_kf` payloads to the existing durable gateway outbox. Provider calls are dependency-injected so all tests are local and no real platform request or send occurs.

**Tech Stack:** Node.js CommonJS, built-in `crypto`/`http`, Express, WebSocket protocol envelopes, `node:test`, MySQL-backed Rag repositories, existing file/MySQL gateway event stores.

---

### Task 1: Versioned encrypted runtime-configuration contract

**Files:**
- Create: `rag-server/src/modules/platform-connections/runtimeConfigCipher.js`
- Create: `rag-server/src/modules/platform-connections/runtimeConfigCipher.test.js`
- Create: `wehook/src/wecom/runtimeConfigCipher.js`
- Create: `wehook/test/wecom-runtime-config.test.js`
- Modify: `rag-server/src/modules/cloud-gateway/gatewayProtocol.js`
- Modify: `wehook/src/protocol.js`

- [ ] **Step 1: Write failing cross-project cipher and protocol tests**

```js
test('Rag runtime ciphertext decrypts in the gateway without exposing plaintext', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  const snapshot = { connectionId: 8, configVersion: 3, corpId: 'ww-test' }
  const ciphertext = createRagRuntimeCipher({ key }).encrypt(snapshot)
  assert.deepEqual(createGatewayRuntimeCipher({ key }).decrypt(ciphertext), snapshot)
  assert.equal(ciphertext.includes('ww-test'), false)
})

test('protocol accepts versioned config apply and applied envelopes', () => {
  assert.equal(validateEnvelope(createRuntimeConfigApply({
    requestId: 'cfg-8-3', connectionId: 8, configVersion: 3,
    channel: 'wecom_kf', status: 'active', ciphertext: 'v1.a.b.c'
  })).valid, true)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test src/modules/platform-connections/runtimeConfigCipher.test.js` from `rag-server` and `node --test test/wecom-runtime-config.test.js` from `wehook`.

Expected: FAIL because the cipher modules and config envelope helpers do not exist.

- [ ] **Step 3: Implement the shared AES-256-GCM wire format and protocol types**

```js
function createRuntimeConfigCipher({ key }) {
  const decodedKey = Buffer.from(String(key || ''), 'base64')
  if (decodedKey.length !== 32) throw new Error('WECOM_RUNTIME_CONFIG_KEY must decode to exactly 32 bytes')
  return {
    encrypt(payload) {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', decodedKey, iv)
      const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
    },
    decrypt(value) {
      const [version, iv, tag, body, extra] = String(value || '').split('.')
      if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error('invalid runtime config ciphertext')
      const decipher = crypto.createDecipheriv('aes-256-gcm', decodedKey, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
    }
  }
}
```

Add `gateway.config.apply` and `gateway.config.applied` to both protocol type sets. Validate `requestId`, positive integer `connectionId/configVersion`, `channel === 'wecom_kf'`, allowed status, and ciphertext for apply messages.

- [ ] **Step 4: Run both focused tests and verify GREEN**

Expected: all Task 1 tests PASS and neither serialized envelope nor ciphertext contains credentials.

### Task 2: Gateway runtime configuration store and apply handling

**Files:**
- Create: `wehook/src/wecom/runtimeConfigStore.js`
- Create: `wehook/src/wecom/runtimeConfigService.js`
- Create: `wehook/test/wecom-runtime-config-service.test.js`
- Modify: `wehook/src/gateway/gatewayServer.js`
- Modify: `wehook/src/index.js`
- Modify: `wehook/src/config.js`
- Modify: `wehook/.env.example`

- [ ] **Step 1: Write failing tests for monotonic versions and sanitized responses**

```js
test('applies a newer encrypted WeCom snapshot and rejects an older version', async () => {
  const service = createRuntimeConfigService({ store, cipher })
  await service.apply({ connectionId: 8, configVersion: 3, status: 'active', ciphertext: encrypt(validSnapshot) })
  await assert.rejects(
    service.apply({ connectionId: 8, configVersion: 2, status: 'active', ciphertext: encrypt(validSnapshot) }),
    error => error.code === 'stale_config_version'
  )
  assert.equal(JSON.stringify(await store.get(8)).includes(validSnapshot.secret), false)
})
```

- [ ] **Step 2: Run the test and verify RED**

Expected: FAIL because the runtime store/service do not exist.

- [ ] **Step 3: Implement encrypted persistence and authenticated apply handling**

The store persists only `{ connectionId, configVersion, status, ciphertext, updatedAt }` to `WECOM_RUNTIME_CONFIG_STORE_PATH`. The service decrypts into memory for validation and lookup, rejects stale versions, and exposes `getActiveByCallbackKey()` / `getActiveByConnectionId()` without logging secrets. `GatewayServer.handleMessage()` handles `gateway.config.apply` only after authentication and sends:

```js
createEnvelope('gateway.config.applied', {
  requestId,
  connectionId,
  configVersion,
  status: 'applied'
}, { eventId: `config-applied-${requestId}` })
```

- [ ] **Step 4: Run focused and phase-one gateway tests**

Run: `node --test test/wecom-runtime-config-service.test.js test/phase1.test.js`.

Expected: PASS; existing ACK/replay/command behavior remains unchanged.

### Task 3: WeCom callback signature and AES message cryptography

**Files:**
- Create: `wehook/src/wecom/callbackCrypto.js`
- Create: `wehook/src/wecom/xmlEnvelope.js`
- Create: `wehook/test/wecom-callback-crypto.test.js`

- [ ] **Step 1: Write failing official-format fixture tests**

```js
test('verifies SHA1 signature and decrypts the official callback payload', () => {
  const cryptoBox = createCallbackCrypto({ token: 'callback-token', encodingAesKey, receiveId: 'ww-test' })
  const encrypted = cryptoBox.encryptForTest('<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token></xml>', { random: Buffer.alloc(16, 1) })
  const signature = cryptoBox.sign(timestamp, nonce, encrypted)
  assert.equal(cryptoBox.decrypt({ signature, timestamp, nonce, encrypted }).includes('sync-token'), true)
})

test('rejects a modified signature with a constant-time comparison', () => {
  assert.throws(() => cryptoBox.decrypt({ signature: '0'.repeat(40), timestamp, nonce, encrypted }), /signature/)
})
```

- [ ] **Step 2: Run the test and verify RED**

Expected: FAIL because callback crypto and XML envelope readers are missing.

- [ ] **Step 3: Implement the official SHA1/AES-CBC format**

Use sorted `token/timestamp/nonce/encrypted` SHA1 input, AES-256-CBC with a zero IV equal to the first 16 key bytes, WeCom PKCS#7 block size 32, and the `16 random bytes + uint32BE length + XML + receiveId` plaintext layout. `xmlEnvelope.js` reads only exact callback tags (`Encrypt`, `Event`, `Token`, `OpenKfId`) and rejects duplicate/malformed tags; it is not a general XML parser.

- [ ] **Step 4: Run tests and verify GREEN**

Expected: valid callbacks decrypt; wrong signatures, wrong receive IDs, malformed padding, duplicate tags and oversized bodies fail.

### Task 4: Official API client and message normalizer

**Files:**
- Create: `wehook/src/wecom/wecomApiClient.js`
- Create: `wehook/src/wecom/messageNormalizer.js`
- Create: `wehook/test/wecom-api-client.test.js`
- Create: `wehook/test/wecom-message-normalizer.test.js`

- [ ] **Step 1: Write failing injected-HTTP tests**

```js
test('refreshes one token for concurrent callers and pulls sync_msg pages', async () => {
  const client = createWecomApiClient({ request, now: () => 1000 })
  const [first, second] = await Promise.all([
    client.syncMessages(config, { token: 'sync-token', cursor: '' }),
    client.syncMessages(config, { token: 'sync-token', cursor: '' })
  ])
  assert.equal(tokenRequests, 1)
  assert.equal(first.messages.length, 1)
  assert.equal(second.nextCursor, 'cursor-2')
})

test('normalizes only customer-origin messages with stable identifiers', () => {
  assert.deepEqual(normalizeWecomMessage(raw, mapping), {
    eventId: 'wecom:8:msg-1',
    payload: {
      channel: 'wecom_kf', accountId: 12, channelAccountId: 'wk-test',
      channelUserId: 'external-1', direction: 'inbound', messageType: 'text',
      content: { text: 'hello' }, channelMessageId: 'msg-1',
      clientTimestamp: 1700000000000
    }
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Expected: FAIL because client and normalizer modules do not exist.

- [ ] **Step 3: Implement token cache, `sync_msg`, text/media normalization and send gate input**

The client accepts an injected `request` function, caches tokens by `corpId`, coalesces concurrent refreshes, retries once on WeCom token-expired codes, and never includes tokens in thrown messages. The normalizer accepts customer origin `3`, supports text/image/voice/video/file/link/location metadata, ignores account/system events, resolves `open_kfid` through the runtime snapshot, and returns a stable `wecom:<connectionId>:<msgid>` event ID.

- [ ] **Step 4: Run focused tests and verify GREEN**

Expected: all token, paging, redaction, message-type and unknown-account cases PASS without network access.

### Task 5: Callback-to-outbox orchestration and safe WeCom provider

**Files:**
- Create: `wehook/src/wecom/wecomAdapter.js`
- Create: `wehook/src/wecom/wecomProvider.js`
- Create: `wehook/test/wecom-adapter.test.js`
- Modify: `wehook/src/index.js`

- [ ] **Step 1: Write failing callback orchestration tests**

```js
test('acknowledges callback quickly and stores each pulled message once', async () => {
  const result = await adapter.handleCallback({ callbackKey: 'key-1', query, body: encryptedBody })
  assert.equal(result.status, 200)
  assert.equal(result.body, 'success')
  await result.processing
  assert.deepEqual(server.ingested.map(item => item.eventId), ['wecom:8:msg-1'])
})

test('provider refuses locked, disabled and non-allowlisted targets before HTTP', async () => {
  await assert.rejects(() => provider.send(lockedCommand), error => error.code === 'WECOM_SEND_BLOCKED')
  assert.equal(requestCalls.length, 0)
})
```

- [ ] **Step 2: Run tests and verify RED**

Expected: FAIL because adapter/provider do not exist.

- [ ] **Step 3: Implement HTTP callback routing and fail-closed provider selection**

Add `GET/POST /webhooks/wecom/:callbackKey` to `createHealthServer()`. GET returns verified plaintext `echostr`. POST reads at most 1 MiB, verifies/decrypts the notification, returns `success`, then processes injected sync pages through `GatewayServer.ingestInbound()`. The provider handles `wecom_kf` commands only when runtime account policy is active, not `locked`, and the target is permitted; unsupported media returns a permanent sanitized failure. `createGateway()` selects the WeCom provider for `wecom_kf` and keeps `MockProvider` for other channels in tests.

- [ ] **Step 4: Run full gateway tests**

Run: `npm test` and `npm run check` from `wehook`.

Expected: all tests and syntax checks PASS; no real URL is contacted.

### Task 6: Rag runtime snapshot publisher and admin endpoint

**Files:**
- Create: `rag-server/src/modules/platform-connections/runtimeConfigPublisher.js`
- Create: `rag-server/src/modules/platform-connections/runtimeConfigPublisher.test.js`
- Modify: `rag-server/src/modules/cloud-gateway/runtime.js`
- Modify: `rag-server/src/modules/cloud-gateway/index.js`
- Modify: `rag-server/src/modules/cloud-gateway/gatewayLink.js`
- Modify: `rag-server/src/modules/platform-connections/platformConnections.repository.js`
- Modify: `rag-server/src/modules/platform-connections/platformConnections.service.js`
- Modify: `rag-server/src/modules/platform-connections/platformConnections.routes.js`
- Modify: `rag-server/src/modules/platform-connections/index.js`

- [ ] **Step 1: Write failing publisher and service tests**

```js
test('publishes a ciphertext-only snapshot and waits for the matching applied result', async () => {
  const promise = publisher.publish(snapshot)
  assert.equal(JSON.stringify(link.sent[0]).includes(snapshot.secret), false)
  link.emit('config_applied', appliedEnvelope)
  assert.deepEqual(await promise, { connectionId: 8, configVersion: 3, status: 'applied' })
})

test('activation keeps the production baseline locked in the runtime snapshot', async () => {
  await service.publishRuntimeConfig(8, 1)
  assert.equal(published.accounts.find(item => item.name === '客服1号').protectionLevel, 'locked')
  assert.equal(published.accounts.find(item => item.name === '客服1号').aiEnabled, false)
})
```

- [ ] **Step 2: Run tests and verify RED**

Expected: FAIL because publisher and activation service method do not exist.

- [ ] **Step 3: Implement ciphertext-only publishing and explicit activation API**

Extend cloud-gateway runtime to expose the current link. `GatewayLink` emits `config_applied`. The publisher rejects a disconnected link, encrypts the complete snapshot with `WECOM_RUNTIME_CONFIG_KEY`, sends `gateway.config.apply`, waits for the exact connection/version response, and times out cleanly. Add admin-only `POST /api/v1/platform-connections/:id/publish-runtime`; it requires a verified connection, decrypts credentials only in memory, includes raw `open_kfid` mappings and policy, preserves production locks, and marks the connection `active` only after the gateway confirms application.

- [ ] **Step 4: Run platform-connection, cloud-gateway and route tests**

Run: `npm run test:platform-connections` and `node --test src/modules/cloud-gateway/cloudGateway.test.js` from `rag-server`.

Expected: PASS; unauthenticated/non-admin/disconnected/stale cases fail closed.

### Task 7: Cross-project offline integration, docs and operational memory

**Files:**
- Create: `wehook/test/wecom-offline.integration.test.js`
- Modify: `wehook/.env.example`
- Create: `wehook/memory/2026-07-24.md`
- Modify: `Rag/docs/wecom-account-operations.md`

- [ ] **Step 1: Write the failing offline integration test**

The test starts an ephemeral gateway, publishes an encrypted versioned snapshot through a real local WebSocket, submits a generated valid encrypted callback to an ephemeral HTTP server, stubs official token/sync responses, and verifies one `wecom_kf` message reaches a fake Rag consumer with the mapped account ID. Repeating the same callback must leave one event.

- [ ] **Step 2: Run the integration test and verify RED**

Expected: FAIL until all Task 1-6 boundaries are wired together.

- [ ] **Step 3: Complete wiring and update operator documentation**

Document the shared runtime key, encrypted store path, callback URL shape, explicit publish action, test-account-only activation sequence, and the fact that no real callback/send is enabled by this implementation alone. Record changed files, tests and the production prohibition in `wehook/memory/2026-07-24.md`.

- [ ] **Step 4: Run complete regression**

Run:

```text
wehook: npm test; npm run check
rag-server: npm run test:platform-connections; npm run test:catalog; node --test src/modules/cloud-gateway/cloudGateway.test.js src/modules/messaging/inboundMessage.service.test.js src/routes/channelAccounts.presenter.test.js; node --check src/app.js
platform-web: npm run test:channel-navigation; npm run test:platform-connections; npm run test:catalog; npm run build
```

Expected: every command exits 0. Verification uses generated keys, fake accounts and stubbed HTTP only; connection count in the real local database remains unchanged.
