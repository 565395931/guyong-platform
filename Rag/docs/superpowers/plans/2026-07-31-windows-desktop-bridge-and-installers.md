# Windows Desktop Bridge and Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reliable Windows desktop node that can read and reply through logged-in merchant clients, plus one-click installers for both the central computer and node computers.

**Architecture:** The node is split into a machine-level Windows Service and a per-user tray process because Windows services cannot safely automate applications in an interactive user session. The service owns WSS, enrollment, durable encrypted queues, retry, and updates. The tray owns platform discovery and UI Automation. They communicate over an ACL-restricted named pipe. The first production adapter targets Taobao/Qianniu and fails closed whenever account or conversation identity cannot be proven. The central package serves the built Vue app and Node backend as services alongside MySQL and the existing Redis-compatible runtime.

**Tech Stack:** .NET 10 LTS, C# 14, Worker Service, WinForms tray, Windows UI Automation, `ClientWebSocket`, `Microsoft.Data.Sqlite`, DPAPI, xUnit, Node.js 22, PowerShell 7, NSIS 3, WinSW, MySQL 8.4 LTS.

---

## Prerequisites and licensing gate

The current machine does not have `dotnet`, NSIS, Docker, or MSBuild installed. Install the .NET 10 SDK and NSIS on the build machine before Task 1. Target `.NET 10`, not `.NET 8`: as of 2026-07-31, .NET 10 is active LTS through November 2028, while .NET 8 reaches end of support in November 2026.

The existing local deployment uses Memurai as the Redis-compatible runtime. Before redistributing a central installer commercially, obtain and record redistribution permission for the chosen Memurai edition. The release build must fail unless `MEMURAI_REDISTRIBUTION_APPROVED=1`; development builds may reference an already installed local runtime but must not silently bundle it.

The workspace is not currently a Git repository. Run every checkpoint; use the suggested commits after Git is initialized.

## Task 1: Scaffold a pinned Windows solution

**Files:**
- Create: `desktop-bridge/global.json`
- Create: `desktop-bridge/Directory.Build.props`
- Create: `desktop-bridge/Directory.Packages.props`
- Create: `desktop-bridge/Rag.DesktopBridge.slnx`
- Create: `desktop-bridge/src/Rag.Bridge.Protocol/Rag.Bridge.Protocol.csproj`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Rag.Bridge.Service.csproj`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Rag.Bridge.Tray.csproj`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/Rag.Bridge.Platform.csproj`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/Rag.Bridge.Adapter.Qianniu.csproj`
- Create: `desktop-bridge/tests/Rag.Bridge.Protocol.Tests/Rag.Bridge.Protocol.Tests.csproj`
- Create: `desktop-bridge/tests/Rag.Bridge.Service.Tests/Rag.Bridge.Service.Tests.csproj`
- Create: `desktop-bridge/tests/Rag.Bridge.Platform.Tests/Rag.Bridge.Platform.Tests.csproj`
- Create: `desktop-bridge/tests/Rag.Bridge.Adapter.Qianniu.Tests/Rag.Bridge.Adapter.Qianniu.Tests.csproj`

- [ ] **Step 1: Verify build tools**

```powershell
dotnet --info
makensis /VERSION
```

Expected: .NET 10 SDK and NSIS 3.x are available.

- [ ] **Step 2: Pin the SDK family**

Use:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature",
    "allowPrerelease": false
  }
}
```

Target `net10.0-windows10.0.19041.0`, enable nullable and warnings as errors, and use centrally managed NuGet versions. Service publish target is `win-x64`, self-contained, single-file. Tray publish target is `win-x64`, self-contained.

- [ ] **Step 3: Add projects and references**

Dependency direction:

```text
Protocol <- Service
Protocol <- Platform <- Adapter.Qianniu
Protocol + Platform <- Tray
```

The service must not reference UI Automation or WinForms.

- [ ] **Step 4: Build the empty solution**

```powershell
cd E:\project\project\Rag\desktop-bridge
dotnet restore --locked-mode
dotnet build --no-restore -c Release
```

Expected: exit 0 with no warnings.

Suggested commit: `build(bridge): scaffold windows node solution`

## Task 2: Mirror and verify the shared protocol

**Files:**
- Create: `shared-protocol/desktop-bridge/examples/*.json`
- Create: `desktop-bridge/src/Rag.Bridge.Protocol/BridgeEnvelope.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Protocol/BridgeJsonContext.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Protocol/ProtocolValidator.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Protocol.Tests/ProtocolFixtureTests.cs`

- [ ] **Step 1: Add valid fixtures for every event/command type**

Use the same JSON examples in Node and .NET tests. Add invalid fixtures for wrong version, unknown type, missing IDs, and invalid payloads.

- [ ] **Step 2: Write failing C# deserialization tests**

Assert round-trip preservation of IDs, UTC timestamps, content, media metadata, and optional reply target.

- [ ] **Step 3: Implement immutable records and source-generated JSON**

Use `JsonPolymorphic`/`JsonDerivedType` or an explicit type switch. Reject unknown fields only in security-sensitive handshake payloads; retain forward-compatible extension data for message payloads.

- [ ] **Step 4: Run Node and .NET protocol tests**

```powershell
cd E:\project\project\Rag\rag-server
node --test src/modules/desktop-bridge/bridgeProtocol.test.js
cd ..\desktop-bridge
dotnet test tests/Rag.Bridge.Protocol.Tests -c Release
```

Expected: both implementations accept and reject the same fixtures.

Suggested commit: `feat(bridge): implement shared protocol contract`

## Task 3: Implement protected node configuration and durable queues

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Service/Configuration/NodeConfigurationStore.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Security/DpapiProtector.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Storage/BridgeStore.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Storage/BridgeStoreMigrations.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Service.Tests/NodeConfigurationStoreTests.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Service.Tests/BridgeStoreTests.cs`

- [ ] **Step 1: Test DPAPI and atomic configuration writes**

Store central URL, node ID, node credential, CA thumbprint, and last acknowledged cursors under `%ProgramData%\RagCustomerService\Bridge`. Protect secrets with DPAPI `LocalMachine`; write to a temporary sibling and atomically replace the previous file.

- [ ] **Step 2: Test SQLite queue semantics**

Tables: `outbound_events`, `inbound_commands`, `account_state`, and `meta`. Event/command IDs are unique. Claims have expiry, attempt count, next-attempt timestamp, and terminal state.

- [ ] **Step 3: Encrypt queued payloads**

Encrypt each JSON payload with DPAPI before storing it as a BLOB. Keep only IDs, state, and scheduling fields in plaintext. Bound retained completed records by age and count.

- [ ] **Step 4: Verify crash recovery**

Tests must reopen the database after a simulated process stop and prove queued events/commands remain exactly once.

Suggested commit: `feat(bridge): add protected durable node storage`

## Task 4: Implement service-to-tray named-pipe IPC

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Protocol/IpcEnvelope.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Ipc/TrayPipeServer.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Ipc/ServicePipeClient.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Service.Tests/TrayPipeServerTests.cs`

- [ ] **Step 1: Test authenticated local sessions**

The pipe name contains the node ID. Apply ACLs for LocalSystem, Administrators, and the interactive user SID. On connection, challenge the client with a random nonce and verify the Windows identity obtained from pipe impersonation.

- [ ] **Step 2: Define bounded IPC messages**

Support `tray.hello`, `adapter.snapshot`, `message.observed`, `command.execute`, `command.result`, `diagnostic.request`, and `diagnostic.result`. Cap IPC frames at 2 MiB.

- [ ] **Step 3: Add liveness and reconnect**

Service tracks the tray heartbeat independently from WSS. Tray reconnect uses jittered backoff capped at 15 seconds. A missing tray marks account capability unavailable but does not discard central commands.

- [ ] **Step 4: Run IPC tests under a non-admin test process**

Expected: valid interactive user connects; unrelated local user is denied; reconnect does not duplicate commands.

Suggested commit: `feat(bridge): connect windows service and tray`

## Task 5: Implement enrollment and resilient WSS transport

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Service/Transport/BridgeWebSocketClient.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Transport/EnrollmentService.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Service/Workers/BridgeTransportWorker.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Service.Tests/BridgeWebSocketClientTests.cs`

- [ ] **Step 1: Test enrollment and certificate behavior**

Accept an 8-character pairing code once. Use normal Windows certificate validation plus the configured deployment CA thumbprint. Never provide a switch that accepts all certificates.

- [ ] **Step 2: Test reconnect and replay**

Use exponential backoff with full jitter from 1 to 60 seconds. On reconnect, send last acknowledged cursors and replay unacknowledged events with original event IDs. Deduplicate commands before handing them to the tray.

- [ ] **Step 3: Implement heartbeat and time offset**

Send heartbeat every 15 seconds with tray status, adapter/account snapshot, queue depth, version, and disk availability. Record server time offset for expiry calculations; never change the PC clock.

- [ ] **Step 4: Run transport tests against an in-process test server**

Cover server restart, fragmented frames, invalid envelope, certificate failure, stale lease, and command replay.

Suggested commit: `feat(bridge): add enrolled resilient wss client`

## Task 6: Define a safe platform-adapter contract

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Platform/IPlatformDesktopAdapter.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/PlatformAccountIdentity.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/ObservedPlatformMessage.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/SendCommand.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/SendResult.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Platform/AdapterSupervisor.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Platform.Tests/AdapterSupervisorTests.cs`

- [ ] **Step 1: Test adapter state transitions**

States: `client_missing`, `login_required`, `account_mismatch`, `ready_readonly`, `ready`, `degraded`, and `blocked`. The supervisor never reports `ready` unless the adapter proves the logged-in account identity matches the central binding.

- [ ] **Step 2: Define cancellation and idempotency**

`ObserveAsync`, `GetAccountIdentityAsync`, and `SendAsync` accept cancellation tokens. `SendAsync` receives command ID and must return a stable prior result when the same command is seen again.

- [ ] **Step 3: Enforce fail-closed send preconditions**

Before every send, assert process identity, logged-in merchant account, selected customer/conversation identity, editable composer, and command lease generation. Any mismatch returns a typed failure without injecting input.

- [ ] **Step 4: Verify pure supervisor tests**

Expected: process crashes and account switches move the adapter out of ready state immediately.

Suggested commit: `feat(bridge): define safe desktop adapter boundary`

## Task 7: Build a fake merchant client and adapter first

**Files:**
- Create: `desktop-bridge/test-apps/Rag.FakeMerchantClient/Rag.FakeMerchantClient.csproj`
- Create: `desktop-bridge/test-apps/Rag.FakeMerchantClient/MainForm.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Fake/Rag.Bridge.Adapter.Fake.csproj`
- Create: `desktop-bridge/tests/Rag.Bridge.Platform.Tests/FakeAdapterE2eTests.cs`

- [ ] **Step 1: Create an accessible test UI**

Expose stable Automation IDs for account label, conversation list, customer ID, message list, composer, and send button. Add controls to simulate login loss, account switch, delayed UI, duplicate message, and client restart.

- [ ] **Step 2: Implement selector-based UI Automation**

Use Automation ID, control type, and ancestor relationships. Do not use absolute screen coordinates or OCR.

- [ ] **Step 3: Prove the complete local loop**

Observe a message, send it through IPC/WSS fake control plane, receive a command, focus the correct conversation, set composer value through UIA patterns, invoke Send, and report success.

- [ ] **Step 4: Prove safety failures**

Account switch, ambiguous customer, missing composer, stale lease, and client restart must not send to the wrong conversation.

Suggested commit: `test(bridge): prove desktop automation with fake client`

## Task 8: Implement the Taobao/Qianniu adapter

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuProcessLocator.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuSelectors.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuAccountReader.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuMessageObserver.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuMessageSender.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Adapter.Qianniu/QianniuAdapter.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Adapter.Qianniu.Tests/QianniuSelectorTests.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Adapter.Qianniu.Tests/QianniuSafetyTests.cs`
- Create: `docs/runbooks/qianniu-adapter-certification.md`

- [ ] **Step 1: Capture a versioned UI signature**

On a dedicated test account, inspect the supported Qianniu build and record process executable, signed publisher, main-window class, required Automation IDs/names, and supported locale under a versioned selector profile. Store no account password or session cookie.

- [ ] **Step 2: Read and verify the merchant identity**

Require exact normalized match to the central account external ID/display ID. An unreadable or ambiguous identity yields `account_mismatch` and disables send.

- [ ] **Step 3: Observe incoming messages**

Prefer UI Automation events; use bounded polling only when the client does not raise events. Build a platform event ID from stable UI attributes plus message timestamp/content hash, then let the central event ID deduplicate replay.

- [ ] **Step 4: Send with target revalidation**

Navigate by stable customer/conversation identifier, verify the selected header, set the composer through `ValuePattern` or supported text pattern, invoke the send control, and verify the outgoing bubble or platform acknowledgment. Clipboard use is disabled by default and fixed-coordinate clicks are prohibited.

- [ ] **Step 5: Certify against supported client updates**

The runbook must record Qianniu version, Windows version, locale, 100-message receive run, 100-message send run, forced restart, network loss, account switch, duplicate command, and zero wrong-recipient sends. Unsupported client signatures start read-only.

Suggested commit: `feat(bridge): add certified qianniu adapter`

## Task 9: Implement the tray application

**Files:**
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Program.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/TrayApplicationContext.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Views/StatusForm.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Views/EnrollmentForm.cs`
- Create: `desktop-bridge/src/Rag.Bridge.Tray/Diagnostics/DiagnosticBundleBuilder.cs`
- Create: `desktop-bridge/tests/Rag.Bridge.Platform.Tests/DiagnosticBundleTests.cs`

- [ ] **Step 1: Build feature-complete tray states**

Tray menu: Status, Enroll/Re-enroll, Open central workbench, Export diagnostics, Restart adapter, and Exit tray. Status shows central connection, active platform account, client login, lease owner, pending queue, and last error.

- [ ] **Step 2: Keep credentials out of the UI**

Enrollment form accepts central URL and pairing code. It never asks for platform password; the user logs into the official merchant client normally.

- [ ] **Step 3: Sanitize diagnostics**

Export version, timestamps, state transitions, command/event IDs, selector profile, and errors. Redact tokens, customer message bodies, phone numbers, account cookies, and DPAPI ciphertext.

- [ ] **Step 4: Verify single-instance and session behavior**

One tray process per Windows user session. Fast user switching must not allow a second session to execute an account lease owned by the first.

Suggested commit: `feat(bridge): add operator tray experience`

## Task 10: Package the desktop node installer

**Files:**
- Create: `installers/node/RagDesktopNode.nsi`
- Create: `installers/node/install-service.ps1`
- Create: `installers/node/uninstall-service.ps1`
- Create: `installers/node/build-node-installer.ps1`
- Create: `installers/node/verify-node-install.ps1`
- Create: `installers/common/sign-artifact.ps1`

- [ ] **Step 1: Publish reproducible binaries**

Run `dotnet publish` for service and tray into `output/node/win-x64`. Generate SHA-256 manifest. The build must not package `bin`, `obj`, test data, local databases, or developer configuration.

- [ ] **Step 2: Author an elevated NSIS installer**

Install under `%ProgramFiles%\RagCustomerService\DesktopBridge`; create `%ProgramData%\RagCustomerService\Bridge`; register `RagDesktopBridge` as automatic delayed-start service; create an all-users logon scheduled task for the tray; add firewall rules only if a local listener is introduced later. The current node needs outbound HTTPS/WSS only.

- [ ] **Step 3: Support central-generated response files**

Accept signed installer parameters for central URL and CA certificate. Import the deployment CA into Local Machine Trusted Root only after showing its subject and SHA-256 fingerprint. Launch enrollment after install.

- [ ] **Step 4: Make upgrades and uninstall safe**

Stop the service, replace binaries atomically, migrate SQLite, restart, and roll back binaries on failed health check. Uninstall removes service/task/binaries but asks before removing enrollment and queued data.

- [ ] **Step 5: Sign release artifacts**

Development builds may be unsigned and must be labeled `DEV-UNSIGNED`. Release builds fail when the Authenticode certificate is unavailable. Sign service, tray, and installer, then verify signatures before publishing.

- [ ] **Step 6: Test in a clean Windows VM**

Install, enroll, reboot, verify automatic service/tray startup, receive/send through the fake client, upgrade, repair, and uninstall. No .NET runtime may be required on the target because publish is self-contained.

Suggested commit: `build(bridge): package one-click node installer`

## Task 11: Convert the central app to a production service bundle

**Files:**
- Modify: `rag-server/src/app.js`
- Create: `rag-server/src/config/productionStatic.js`
- Create: `rag-server/src/config/productionStatic.test.js`
- Create: `rag-server/src/config/productionTls.js`
- Create: `rag-server/src/config/productionTls.test.js`
- Create: `tools/central-deploy/RagServerService.xml`
- Create: `tools/central-deploy/start-central.ps1`
- Create: `tools/central-deploy/stop-central.ps1`
- Create: `tools/central-deploy/health-check.ps1`
- Create: `tools/central-deploy/backup-database.ps1`
- Create: `tools/central-deploy/restore-database.ps1`

- [ ] **Step 1: Serve the built Vue application from Express**

In production, serve `platform-web/dist` with immutable hashed assets and an SPA fallback after API routes. Do not run Vite on the central computer. Keep API and WSS on one origin.

- [ ] **Step 2: Create the production HTTPS server explicitly**

Extract `createTransportServer(app, env)` so development continues to use HTTP, while production requires readable certificate/key files and returns `https.createServer`. Attach Socket.IO and `/bridge/v1` upgrades to that returned server. Add tests for missing TLS files, valid injected TLS options, and the development HTTP path.

- [ ] **Step 3: Package a private Node runtime**

Run the backend through WinSW using the packaged `node.exe`; do not depend on a system Node installation or global npm packages. Service working directory and logs remain under the installation/data directories respectively.

- [ ] **Step 4: Make startup dependency-aware**

Start MySQL and Redis-compatible service first, wait for health, then start Rag Server. A failed dependency leaves the server stopped with an actionable Windows Event Log entry.

- [ ] **Step 5: Add backup and restore**

Daily scheduled backup uses `mysqldump --single-transaction`, encrypts the archive with a deployment backup key, retains 30 daily and 12 monthly backups, and verifies restore into a temporary database weekly.

- [ ] **Step 6: Verify static routing and service health**

Test `/`, a deep SPA path, `/api/v1/channels/status`, Socket.IO, and `/bridge/v1` upgrade coexistence.

Suggested commit: `build(server): prepare central production service bundle`

## Task 12: Package the central-computer installer

**Files:**
- Create: `installers/central/RagCentralServer.nsi`
- Create: `installers/central/build-central-installer.ps1`
- Create: `installers/central/configure-central.ps1`
- Create: `installers/central/verify-central-install.ps1`
- Create: `installers/central/generate-deployment-ca.ps1`
- Create: `installers/central/generate-node-bootstrap.ps1`
- Modify: `platform-web/src/views/Settings/components/DesktopNodePanel.vue`

- [ ] **Step 1: Stage only production artifacts**

Build frontend, prune backend production dependencies, include private Node runtime, WinSW, MySQL 8.4 LTS binaries, approved Redis-compatible runtime, scripts, and schema assets. Exclude source maps unless explicitly building a diagnostics package.

- [ ] **Step 2: Configure the central host in one wizard**

Collect installation folder, data folder, backup folder, static LAN IP/DNS name, ports, initial admin password, and certificate choice. Generate independent random JWT, database, bridge-enrollment, and backup secrets; never ship defaults.

- [ ] **Step 3: Generate deployment TLS correctly**

For an internal deployment, generate a local deployment CA and a server certificate with the configured DNS/IP SANs, install the CA on the central PC, and configure HTTPS. Export only the public CA certificate for node bootstrap. Never export the CA private key with node packages.

- [ ] **Step 4: Install database and services**

Initialize an empty MySQL data directory, create a least-privilege application user, install services, run schema initialization, create the first admin, and schedule backups. Do not package the developer `output/runtime/mysql-data` directory.

- [ ] **Step 5: Generate a deployment-specific node bootstrap**

From the Node panel, an admin downloads a ZIP containing the signed generic node installer, signed response file with central URL, and public deployment CA. Pairing code remains short-lived and is generated separately at install time.

- [ ] **Step 6: Verify in a clean central VM**

Install, reboot, open the HTTPS workbench without a certificate warning on the central PC, create admin/user accounts, pair a node VM, receive/send a fake message, back up, restore, upgrade, and uninstall while retaining data.

- [ ] **Step 7: Enforce redistribution and signature gates**

The release build exits nonzero unless third-party redistribution approval flags, license inventory, SHA-256 checksums, and Authenticode signatures are all present.

Suggested commit: `build(server): package one-click central installer`

## Task 13: Production soak and adapter release gate

**Files:**
- Create: `desktop-bridge/tests/soak/BridgeSoakRunner.cs`
- Create: `docs/runbooks/desktop-bridge-release-checklist.md`
- Create: `docs/runbooks/desktop-bridge-incident-response.md`

- [ ] **Step 1: Run a 72-hour fake-client soak**

Inject network loss, central restart, node restart, tray restart, duplicate events, duplicate commands, slow UI, disk pressure, and clock skew. Require zero lost accepted messages, zero duplicate sends, and zero wrong-recipient sends.

- [ ] **Step 2: Run a supervised Qianniu pilot**

Start in `observe`, then `assist`, then `guarded_auto` only after metrics pass. Every no-reply recommendation remains in human review. Keep a kill switch per account and per node.

- [ ] **Step 3: Define release thresholds**

Required: inbound deduplication 100%, wrong-recipient sends 0, terminal command reconciliation 100%, reconnect recovery under 2 minutes, node status freshness under 45 seconds, and no secrets in diagnostic bundles.

- [ ] **Step 4: Complete installer matrix**

Test supported Windows 10/11 x64 editions, Chinese and English locales, standard user after admin install, reboot, upgrade from previous release, repair, and uninstall/data retention.

Suggested commit: `test(bridge): complete production release gate`

## Completion criteria

- A node computer installs with one executable and starts service/tray automatically after reboot.
- The node never needs an inbound firewall port and never stores platform passwords.
- UI Automation uses verified selectors and refuses ambiguous account/conversation state.
- Events and commands survive crashes/reconnects without duplicate sends.
- Qianniu is the first certified adapter; other platforms can implement the same contract independently.
- The central computer installs with one executable, uses production static assets, initializes services/database, creates trusted deployment TLS, and schedules verified backups.
- Both release installers are signed, reproducible, and pass clean-VM install/upgrade/uninstall tests.
