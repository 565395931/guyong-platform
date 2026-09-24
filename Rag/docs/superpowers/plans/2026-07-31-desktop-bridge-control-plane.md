# Desktop Bridge Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let many Windows desktop nodes connect outbound to the central server, bind one platform account to one active node lease, ingest platform messages, execute replies reliably, and expose node/account health in the unified web application.

**Architecture:** A new `desktop-bridge` backend module owns WSS authentication, protocol validation, durable event/command state, account leases, and operator APIs. It reuses the existing messaging persistence and review gate for inbound traffic. A transport router selects official API, existing cloud gateway, or desktop bridge per account and replaces duplicated send branches in manual, AI, and review replies. Socket.IO remains the browser update channel; WSS is reserved for desktop nodes.

**Tech Stack:** Node.js 22, Express, `ws`, Zod, MySQL/Sequelize raw queries, Redis/BullMQ where already used, Socket.IO, Node test runner, Vue 3, Element Plus.

---

## Protocol rules

- Endpoint: `wss://<central-host>/bridge/v1` in production and `ws://<host>/bridge/v1` only on an explicitly enabled trusted LAN.
- One JSON envelope per WebSocket frame; maximum frame size 1 MiB.
- Protocol version: `1.0`.
- Event IDs and command IDs are UUIDs and idempotency keys.
- The server acknowledges an inbound event only after durable processing.
- The node acknowledges a command in two stages: `accepted`, then `succeeded` or `failed`.
- A platform account can have only one unexpired active lease.
- No-reply decisions never become desktop commands; the existing review workflow must resolve them through a human action.

The workspace is not currently a Git repository. Run all checkpoints; use the suggested commits once version control is initialized.

## Task 1: Define and test the shared envelope contract

**Files:**
- Create: `shared-protocol/desktop-bridge/envelope.schema.json`
- Create: `shared-protocol/desktop-bridge/payloads.schema.json`
- Create: `rag-server/src/modules/desktop-bridge/bridgeProtocol.js`
- Create: `rag-server/src/modules/desktop-bridge/bridgeProtocol.test.js`
- Modify: `rag-server/package.json`

- [x] **Step 1: Write failing protocol tests**

Test accepted types:

```js
const TYPES = [
  'node.hello', 'node.ready', 'node.heartbeat',
  'account.snapshot', 'account.state.changed',
  'message.inbound', 'message.send', 'message.command.status',
  'event.ack', 'server.error'
]
```

Test rejection of an unsupported version, unknown type, missing ID, invalid timestamp, payload over 1 MiB, and a `message.inbound` without `accountId`, `platformConversationId`, or text/media content.

- [x] **Step 2: Add Zod envelopes mirroring the checked-in JSON Schema**

Use a discriminated union on `type`. The base fields are:

```js
{
  protocolVersion: '1.0',
  type,
  eventId,
  occurredAt,
  sentAt,
  payload
}
```

`nodeId` is optional only on the first pairing `node.hello` and required on every enrolled-node envelope. `message.send` uses `commandId` instead of `eventId`. `event.ack` carries `ackForEventId` and status `processed`, `duplicate`, `rejected`, or `retryable_error`.

- [x] **Step 3: Export canonical envelope creators**

Export `parseEnvelope`, `createEvent`, `createCommand`, `createAck`, and `MAX_FRAME_BYTES`. Do not reuse cloud-gateway version `0.1`; keep an explicit adapter later if the protocols converge.

- [x] **Step 4: Run the protocol tests**

```powershell
cd E:\project\project\Rag\rag-server
node --test src/modules/desktop-bridge/bridgeProtocol.test.js
```

Expected: pass.

Suggested commit: `feat(server): define desktop bridge protocol`

## Task 2: Add durable bridge schema

**Files:**
- Create: `rag-server/src/modules/desktop-bridge/desktopBridge.schema.js`
- Create: `rag-server/src/modules/desktop-bridge/desktopBridge.schema.test.js`
- Modify: `rag-server/src/config/database.js`

- [x] **Step 1: Write a failing schema contract test**

Capture SQL and assert creation of these tables and unique keys:

```text
desktop_bridge_nodes       UNIQUE(node_key)
desktop_bridge_pairings    UNIQUE(code_hash)
desktop_bridge_bindings    UNIQUE(channel_account_id)
desktop_bridge_leases      UNIQUE(channel_account_id)
desktop_bridge_events      UNIQUE(event_id)
desktop_bridge_commands    UNIQUE(command_id)
desktop_bridge_audit_logs  INDEX(node_id, created_at)
```

- [x] **Step 2: Implement an idempotent schema initializer**

Required state:

- nodes: display name, machine fingerprint hash, version, capabilities JSON, status, last seen, disabled timestamp;
- pairings: one-time code hash, expiry, created/consumed actor and time;
- bindings: account, preferred node, adapter ID, mode, AI mode, enabled;
- leases: account, node, lease token hash, generation, expiry, heartbeat;
- events: event ID, node/account, type, status, retry count, error, processed time;
- commands: command ID, local message ID, node/account, payload JSON, state, attempts, deadline, error, completed time;
- audit logs: actor kind/ID, action, target, before/after JSON, created time.

Use `DATETIME(3)` timestamps and indexes for queue scans. Foreign keys may be omitted where the current bootstrap order makes them brittle, but account existence must be validated in the repository.

- [x] **Step 3: Call `ensureDesktopBridgeSchema(sequelize)` from `connectDB`**

Place it beside other module-owned schema initializers, not inside the large legacy table block.

- [x] **Step 4: Run schema and existing database-related tests**

Expected: pass and initializer can run twice.

Suggested commit: `feat(server): persist desktop bridge state`

## Task 3: Implement pairing, node identity, and account leases

**Files:**
- Create: `rag-server/src/modules/desktop-bridge/bridgeRepository.js`
- Create: `rag-server/src/modules/desktop-bridge/bridgeRepository.test.js`
- Create: `rag-server/src/modules/desktop-bridge/leaseService.js`
- Create: `rag-server/src/modules/desktop-bridge/leaseService.test.js`

- [x] **Step 1: Test one-time pairing codes**

Pairing code rules: 8 uppercase base32 characters, 10-minute lifetime, store only SHA-256 hash, consume once, and create or re-enroll the matching machine fingerprint only through an explicit operator action.

- [x] **Step 2: Test lease exclusivity and takeover**

Required cases:

```js
await acquire(accountId, nodeA) // succeeds, generation 1
await acquire(accountId, nodeB) // throws ACCOUNT_LEASE_CONFLICT
await takeover(accountId, nodeB, supervisor) // generation 2; node A is revoked
await renew(accountId, nodeA, oldToken) // throws LEASE_REVOKED
```

Lease duration: 45 seconds; node heartbeat: 15 seconds; consider a node offline after 3 missed heartbeats.

- [x] **Step 3: Implement transactional compare-and-swap**

Use `SELECT ... FOR UPDATE` around acquire/takeover. Include a monotonic `generation`; never rely only on wall-clock time. Hash lease tokens before storage. Emit audit records for bind, unbind, acquire, expire, takeover, disable, and re-enroll.

- [x] **Step 4: Verify repository and lease tests**

Expected: concurrent acquisition yields exactly one winner.

Suggested commit: `feat(server): add exclusive desktop account leases`

## Task 4: Host the inbound desktop-node WebSocket gateway

**Files:**
- Create: `rag-server/src/modules/desktop-bridge/bridgeGateway.js`
- Create: `rag-server/src/modules/desktop-bridge/bridgeGateway.test.js`
- Create: `rag-server/src/modules/desktop-bridge/connectionRegistry.js`
- Create: `rag-server/src/modules/desktop-bridge/index.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Write gateway handshake tests with an in-process HTTP server**

Cover: valid one-time pairing, enrolled node reconnect, expired pairing rejection, disabled node rejection, oversized frame close code `1009`, invalid JSON, heartbeat renewal, and duplicate live node connection replacing the older socket.

- [ ] **Step 2: Attach a `WebSocketServer` with `noServer: true`**

Handle only upgrade path `/bridge/v1`; leave Socket.IO upgrades untouched. Set `maxPayload` to `MAX_FRAME_BYTES`. Production startup must fail when bridge transport is enabled without TLS termination or an explicit `BRIDGE_ALLOW_INSECURE_LAN=true` override.

- [ ] **Step 3: Implement the handshake state machine**

Before `node.ready`, accept only `node.hello`. On success, store the live connection by node ID, return node configuration and server time, then accept heartbeat, snapshots, inbound messages, and command statuses.

- [ ] **Step 4: Make shutdown deterministic**

Expose `start`, `stop`, `sendToNode`, and `getConnection`. On process shutdown, stop accepting upgrades, close clients with code `1001`, and flush in-flight state updates.

- [ ] **Step 5: Mount from `app.js` and verify gateway tests**

Pass the existing `httpServer`, `sequelize`, and `eventEmitter` into `initDesktopBridge`. Store the returned service on `app` as `desktopBridge`.

Expected: tests pass; existing cloud-gateway tests remain green.

Suggested commit: `feat(server): accept authenticated desktop nodes`

## Task 5: Route inbound desktop messages through existing review logic

**Files:**
- Create: `rag-server/src/modules/desktop-bridge/inboundBridgeService.js`
- Create: `rag-server/src/modules/desktop-bridge/inboundBridgeService.test.js`
- Reuse: `rag-server/src/modules/messaging/messaging.service.js`
- Reuse: `rag-server/src/modules/messaging/inboundMessage.service.js`

- [ ] **Step 1: Test account and lease checks before persistence**

Reject events when the account does not exist, binding is disabled, event node does not own the current lease, or event channel differs from the account channel.

- [ ] **Step 2: Test idempotent processing**

The first event calls `processIncomingMessage` and `processInboundMessageAfterStore`. The second frame with the same event ID returns `duplicate` and performs neither call again.

- [ ] **Step 3: Normalize the node payload**

Map platform data into the existing standard message shape, including:

```js
{
  channel,
  accountId,
  channelMessageId,
  userId: platformCustomerId,
  userName,
  content,
  messageType,
  clientTimestamp,
  rawData: { source: 'desktop_bridge', nodeId, adapterId, platformPayload }
}
```

Do not trust a node-supplied central conversation ID.

- [ ] **Step 4: Persist event outcome before acknowledgment**

On success return `processed`; on duplicate return `duplicate`; on validation failure return `rejected`; on transient storage failure return `retryable_error`. The AI review and mandatory human no-reply policy are inherited from `processInboundMessageAfterStore`.

- [ ] **Step 5: Run inbound and message-review regression tests**

```powershell
node --test src/modules/desktop-bridge/inboundBridgeService.test.js src/modules/messaging/inboundMessage.service.test.js src/modules/message-review/*.test.js
```

Expected: pass.

Suggested commit: `feat(server): ingest desktop bridge messages`

## Task 6: Build a single outbound transport router

**Files:**
- Create: `rag-server/src/modules/messaging/outboundTransport.service.js`
- Create: `rag-server/src/modules/messaging/outboundTransport.service.test.js`
- Modify: `rag-server/src/modules/cloud-gateway/gatewayOutboundDispatcher.js`
- Modify: `rag-server/src/routes/conversations.js`
- Modify: `rag-server/src/modules/message-review/index.js`
- Modify: `rag-server/src/modules/conversation-pool/ai-auto-reply.service.js`

- [ ] **Step 1: Write transport precedence tests**

The resolver order is:

1. official/local adapter when it reports chat-send support for the account;
2. configured cloud gateway mapping;
3. active desktop-bridge binding and lease;
4. fail closed with `NO_CHAT_TRANSPORT`.

Never return the cloud gateway's current `noop` success for an unsupported adapter.

- [ ] **Step 2: Implement `dispatchOutbound`**

Input:

```js
{
  conversationId,
  localMessageId,
  channel,
  accountId,
  targetUserId,
  messageType,
  content,
  replyToChannelMessageId
}
```

Output always contains `success`, `status`, `transport`, and `commandId` or platform message ID. Desktop commands are inserted in state `queued` before sending over WSS.

- [ ] **Step 3: Replace duplicated route/review/AI send logic**

All three callers must persist the outbound message first, then invoke the same router. Preserve WhatsApp self-recipient retry by encapsulating it in the official adapter transport, not in the route.

- [ ] **Step 4: Map command statuses back to `plat_messages`**

`accepted` keeps `send_status=pending`; `succeeded` sets `sent` and platform message ID; terminal `failed` sets `failed` and emits `INTERNAL_EVENTS.MESSAGE_UPDATE`.

- [ ] **Step 5: Add timeout and retry behavior**

Retry an unaccepted command at most 3 times with the same command ID. Do not retry after terminal platform rejection. A lease takeover requeues only commands that were never accepted by the old node.

- [ ] **Step 6: Run focused and full backend tests**

```powershell
node --test src/modules/messaging/outboundTransport.service.test.js src/modules/desktop-bridge/*.test.js src/modules/cloud-gateway/*.test.js src/modules/message-review/*.test.js
npm test
```

If `npm test` is not defined, run `node --test` and add a stable `test` script to `rag-server/package.json`.

Suggested commit: `refactor(server): unify outbound message transport`

## Task 7: Expose operator APIs with audit controls

**Files:**
- Create: `rag-server/src/modules/desktop-bridge/bridgeRoutes.js`
- Create: `rag-server/src/modules/desktop-bridge/bridgeRoutes.test.js`
- Modify: `rag-server/src/modules/desktop-bridge/index.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Test authentication and role matrix**

Routes:

```text
GET    /api/v1/desktop-bridge/nodes
POST   /api/v1/desktop-bridge/pairings
PATCH  /api/v1/desktop-bridge/nodes/:id
GET    /api/v1/desktop-bridge/bindings
PUT    /api/v1/desktop-bridge/bindings/:accountId
POST   /api/v1/desktop-bridge/bindings/:accountId/takeover
GET    /api/v1/desktop-bridge/commands
GET    /api/v1/desktop-bridge/audit-logs
```

Admin can pair/disable/re-enroll; supervisor can view, bind, and perform an explicit takeover with a reason; agent can only read account online status through the existing channel-status surface.

- [ ] **Step 2: Validate all request bodies with Zod**

Takeover requires a 5-200 character reason. Pairing accepts a display name and optional allowed adapter IDs. Binding requires an existing account, node, and adapter capability match.

- [ ] **Step 3: Mount the router**

Mount at `/api/v1/desktop-bridge`. Reuse the existing JWT middleware style and return 409 for lease conflicts.

- [ ] **Step 4: Verify route tests**

Expected: pass, including audit row assertions.

Suggested commit: `feat(server): expose desktop bridge operations api`

## Task 8: Add node management and logs to the unified account page

**Files:**
- Create: `platform-web/src/api/desktopBridge.js`
- Create: `platform-web/src/modules/desktopBridge/bridgeStatus.js`
- Create: `platform-web/src/modules/desktopBridge/bridgeStatus.test.js`
- Create: `platform-web/src/views/Settings/components/DesktopNodePanel.vue`
- Create: `platform-web/src/views/Settings/components/DesktopBridgeLogPanel.vue`
- Modify: `platform-web/src/views/Settings/CustomerServiceAccountsView.vue`

- [ ] **Step 1: Test display-state derivation**

Derive `online`, `degraded`, `offline`, `conflict`, and `disabled` from server status, heartbeat age, lease, and command failures. Use server-provided timestamps and current time injection for deterministic tests.

- [ ] **Step 2: Add page tabs**

Use `账号`, `桌面节点`, and `运行日志`. Accounts remains the default. Do not nest these page sections inside decorative cards.

- [ ] **Step 3: Implement node operations**

Provide pairing code creation with expiry countdown, node enable/disable, account binding, and an explicit takeover dialog requiring a reason. Never expose stored token hashes or raw machine fingerprints.

- [ ] **Step 4: Implement operational log filtering**

Filters: time, node, platform, account, action, outcome. Command errors show a short operator message and a copyable correlation/command ID.

- [ ] **Step 5: Verify tests and build**

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/desktopBridge/bridgeStatus.test.js
npm run build
```

Suggested commit: `feat(web): manage desktop nodes and bindings`

## Task 9: End-to-end verification with a fake node

**Files:**
- Create: `rag-server/test/fixtures/fakeDesktopBridgeNode.js`
- Create: `rag-server/test/desktopBridge.e2e.test.js`
- Create: `docs/runbooks/desktop-bridge-operations.md`

- [ ] **Step 1: Implement a deterministic fake node**

The fixture pairs, connects, acquires one account, emits one inbound message, accepts one send command, and reports success. It also supports forced disconnect and duplicate replay.

- [ ] **Step 2: Test the complete lifecycle**

Assert:

- inbound message is stored once;
- suspicious content creates one review item;
- a human reply creates one outbound command;
- command success updates the stored message;
- duplicate inbound event does not duplicate the conversation message;
- node B cannot acquire node A's account without takeover;
- after takeover, stale node A status is rejected.

- [ ] **Step 3: Document production operations**

Document TLS termination, pairing, binding, takeover, node replacement, certificate rotation, database backup, log retention, and emergency disable. Include commands using the actual environment names from `.env.example`.

- [ ] **Step 4: Run all backend tests and a frontend build**

```powershell
cd E:\project\project\Rag\rag-server
node --test
cd ..\platform-web
npm run build
```

Expected: all backend tests pass and the frontend build exits 0.

Suggested commit: `test: verify desktop bridge end to end`

## Completion criteria

- Multiple PCs can connect outbound without inbound firewall rules on node PCs.
- Each platform account has at most one live lease and takeover is explicit/audited.
- Inbound desktop messages reuse the existing persistence, AI review, and human no-reply policy.
- Manual, reviewed, and AI replies all use one transport router.
- Commands survive reconnects, deduplicate by command ID, and expose terminal status.
- Supervisors can see nodes, bindings, health, commands, and audit records in the unified account page.
- Full backend tests, frontend tests, and build pass.
