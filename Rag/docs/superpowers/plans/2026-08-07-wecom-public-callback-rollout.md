# Enterprise WeCom Public Callback Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing WeCom customer-service callback through `wecom.thelonelybrave.cn` without exposing the Windows host, then complete one allowlisted inbound and manual-text outbound test.

**Architecture:** The Hangzhou ECS terminates HTTPS and proxies only `/webhooks/wecom/` to `127.0.0.1:18788`. A dedicated Windows supervisor maintains an outbound SSH reverse tunnel from ECS `127.0.0.1:18788` to local `wehook:8788`; Rag remains the source of truth and publishes encrypted runtime configuration to the local gateway.

**Tech Stack:** Node.js `node:test`, PowerShell 5.1+, Windows OpenSSH client, Alibaba Cloud Linux, Nginx, Certbot, Express, Vue 3, Element Plus, MySQL, WebSocket

**Version-control note:** `E:\project\project\Rag` and `E:\project\project\wehook` are not Git repositories. Do not initialize Git or fabricate commits. Each task ends with a file-and-test checkpoint; if the directories are placed under Git before execution, use the supplied conventional commit message.

---

## File Map

**Create**

- `Rag/tools/wecom-public-callback/reverse-tunnel.js` - validates tunnel arguments, builds the restricted OpenSSH command, and supervises reconnects.
- `Rag/tools/wecom-public-callback/reverse-tunnel.test.js` - unit coverage for argument validation, forwarding boundaries, and reconnect delay.
- `Rag/tools/wecom-public-callback/install-tunnel-task.ps1` - installs or dry-runs the Windows scheduled task without storing a password.
- `Rag/tools/wecom-public-callback/install-tunnel-task.test.ps1` - verifies the scheduled-task command and local-only forwarding contract.
- `Rag/tools/wecom-public-callback/nginx-wecom-bootstrap.conf` - HTTP-only ACME challenge virtual host used before the certificate exists.
- `Rag/tools/wecom-public-callback/nginx-wecom.conf` - ECS Nginx HTTPS callback-only virtual host with query-free access logging and rate limiting.
- `Rag/tools/wecom-public-callback/nginx-wecom.test.js` - static security contract for the Nginx configuration.
- `Rag/tools/wecom-public-callback/check-readiness.js` - checks local gateway, DNS, TLS, public HTTPS, and optional ECS loopback tunnel health without printing secrets.
- `Rag/tools/wecom-public-callback/check-readiness.test.js` - unit tests for readiness evaluation and safe output.

**Modify**

- `Rag/rag-server/src/modules/platform-connections/platformConnections.repository.js` - select `callback_key` for connection lists.
- `Rag/rag-server/src/modules/platform-connections/platformConnections.repository.test.js` - require `callback_key` in the list query.
- `Rag/rag-server/src/modules/platform-connections/platformConnections.service.js` - derive an HTTPS callback URL from configured public base URL and the stored callback key.
- `Rag/rag-server/src/modules/platform-connections/platformConnections.service.test.js` - prove callback URL exposure without credential leakage.
- `Rag/rag-server/src/modules/platform-connections/index.js` - inject `WECOM_PUBLIC_CALLBACK_BASE_URL` into the service.
- `Rag/platform-web/src/views/Settings/components/ConnectionTable.vue` - show and copy the generated callback URL.
- `Rag/platform-web/src/modules/accounts/CustomerServiceAccountsView.test.js` - require the callback URL operator surface.
- `Rag/docs/wecom-account-operations.md` - document the domain, tunnel, approval gates, and exact rollout/rollback commands.

**Do not modify**

- Any `.env` file with CorpID Secret, Callback Token, EncodingAESKey, SSH private key, or access token.
- `客服1号` protection rules or AI defaults.
- ECS, Alibaba Cloud DNS, ICP filing, or Enterprise WeCom settings until the explicit external-change gates in Tasks 5 and 6.

---

### Task 1: Expose a Safe Admin Callback URL

**Files:**
- Modify: `Rag/rag-server/src/modules/platform-connections/platformConnections.repository.js`
- Modify: `Rag/rag-server/src/modules/platform-connections/platformConnections.repository.test.js`
- Modify: `Rag/rag-server/src/modules/platform-connections/platformConnections.service.js`
- Modify: `Rag/rag-server/src/modules/platform-connections/platformConnections.service.test.js`
- Modify: `Rag/rag-server/src/modules/platform-connections/index.js`
- Modify: `Rag/platform-web/src/views/Settings/components/ConnectionTable.vue`
- Modify: `Rag/platform-web/src/modules/accounts/CustomerServiceAccountsView.test.js`

- [ ] **Step 1: Add failing backend tests for the callback URL**

Add to `platformConnections.service.test.js`:

```js
test('returns an HTTPS callback URL without exposing callback credentials', async () => {
  const harness = createHarness()
  const service = createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    publicCallbackBaseUrl: 'https://wecom.thelonelybrave.cn',
    randomBytes: () => Buffer.from('1234567890123456')
  })

  const created = await service.createConnection({
    connectionName: '孤勇者企业微信', corpId: 'ww123', secret: 'secret-value',
    callbackToken: 'callback-token', encodingAesKey: 'encoding-key'
  }, 9)
  const [listed] = await service.listConnections()

  assert.equal(created.callbackUrl, 'https://wecom.thelonelybrave.cn/webhooks/wecom/31323334353637383930313233343536')
  assert.equal(listed.callbackUrl, created.callbackUrl)
  assert.doesNotMatch(JSON.stringify([created, listed]), /secret-value|callback-token|encoding-key/)
})

test('rejects a non-HTTPS public callback base URL at service construction', () => {
  const harness = createHarness()
  assert.throws(() => createPlatformConnectionsService({
    repository: harness.repository,
    credentialCipher: harness.credentialCipher,
    wecomClient: {},
    publicCallbackBaseUrl: 'http://wecom.thelonelybrave.cn'
  }), /must use HTTPS/)
})
```

Update `platformConnections.repository.test.js` so the list-query assertion requires `callback_key`:

```js
assert.match(calls[0].sql, /SELECT[\s\S]*callback_key[\s\S]*FROM platform_connections/i)
```

- [ ] **Step 2: Run the backend tests and verify RED**

Run:

```powershell
cd E:\project\project\Rag\rag-server
node --test src/modules/platform-connections/platformConnections.repository.test.js src/modules/platform-connections/platformConnections.service.test.js
```

Expected: FAIL because `callbackUrl` is missing and HTTP callback bases are not rejected.

- [ ] **Step 3: Implement callback base validation and URL mapping**

In `platformConnections.repository.js`, include `callback_key` in `listConnections()`:

```js
`SELECT id,channel_code,connection_name,corp_id,callback_key,status,health_status,health_message,
        account_count,config_version,last_token_refresh_at,last_callback_at,last_sync_at,
        created_at,updated_at
   FROM platform_connections
  ORDER BY created_at DESC,id DESC`
```

In `platformConnections.service.js`, add:

```js
function normalizePublicCallbackBaseUrl(value = '') {
  const text = String(value || '').trim()
  if (!text) return ''
  const url = new URL(text)
  if (url.protocol !== 'https:') throw new Error('WeCom public callback base URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('WeCom public callback base URL must not contain credentials, query, or fragment')
  }
  return url.origin
}

function buildCallbackUrl(baseUrl, callbackKey) {
  const key = String(callbackKey || '').trim()
  return baseUrl && key ? `${baseUrl}/webhooks/wecom/${encodeURIComponent(key)}` : null
}
```

Extend the service dependency list and bind the mapper once:

```js
function createPlatformConnectionsService({
  repository,
  credentialCipher,
  wecomClient,
  runtimeConfigPublisher = null,
  protectedAccountNames = ['客服1号'],
  publicCallbackBaseUrl = '',
  now = () => new Date(),
  randomBytes = crypto.randomBytes
}) {
  const callbackBaseUrl = normalizePublicCallbackBaseUrl(publicCallbackBaseUrl)
  const mapConnectionView = row => {
    const mapped = mapConnection(row)
    return mapped ? { ...mapped, callbackUrl: buildCallbackUrl(callbackBaseUrl, row.callback_key) } : null
  }
```

Replace every service-level `mapConnection(...)` call with `mapConnectionView(...)`. In `createConnection`, return `callbackUrl: buildCallbackUrl(callbackBaseUrl, callbackKey)` alongside the existing safe fields.

In `platform-connections/index.js`, inject:

```js
publicCallbackBaseUrl: process.env.WECOM_PUBLIC_CALLBACK_BASE_URL || ''
```

Do not return `callback_key`, `credential_ciphertext`, Secret, Callback Token, or EncodingAESKey.

- [ ] **Step 4: Run the backend tests and verify GREEN**

Run the command from Step 2.

Expected: all repository and service tests PASS.

- [ ] **Step 5: Add a failing frontend operator-surface test**

Extend `CustomerServiceAccountsView.test.js`:

```js
test('WeCom connection table exposes a copyable callback URL without credential fields', () => {
  const source = readSource('../../views/Settings/components/ConnectionTable.vue')
  assert.match(source, /row\.callbackUrl/)
  assert.match(source, /复制回调地址/)
  assert.match(source, /navigator\.clipboard\.writeText/)
  assert.doesNotMatch(source, /callbackToken|encodingAesKey|corpSecret/)
})
```

- [ ] **Step 6: Run the frontend test and verify RED**

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/accounts/CustomerServiceAccountsView.test.js
```

Expected: FAIL because the copy action does not exist.

- [ ] **Step 7: Add the callback copy action**

In `ConnectionTable.vue`, import `DocumentCopy` and `ElMessage`:

```js
import { ElMessage } from 'element-plus'
import { DocumentCopy, Plus, Refresh, SwitchButton } from '@element-plus/icons-vue'

async function copyCallbackUrl(row) {
  if (!row.callbackUrl) return
  await navigator.clipboard.writeText(row.callbackUrl)
  ElMessage.success('企业微信回调地址已复制')
}
```

Add this button before “发布到网关”:

```vue
<el-button
  link
  type="primary"
  :icon="DocumentCopy"
  :disabled="!row.callbackUrl"
  @click.stop="copyCallbackUrl(row)"
>复制回调地址</el-button>
```

Increase the non-embedded operation column width only enough to avoid wrapping the new action into an unreadable layout; keep the embedded layout wrapping behavior.

- [ ] **Step 8: Verify frontend tests and build**

```powershell
cd E:\project\project\Rag\platform-web
node --test src/modules/accounts/CustomerServiceAccountsView.test.js src/modules/platformConnections/connectionForm.test.js
npm run build
```

Expected: tests PASS and Vite exits `0` with only existing Sass/chunk warnings.

- [ ] **Step 9: Record checkpoint**

Record the seven changed files and test counts in the task log. Conventional commit if Git becomes available:

```text
feat: expose enterprise wecom callback url
```

---

### Task 2: Build the Restricted Reverse-Tunnel Supervisor

**Files:**
- Create: `Rag/tools/wecom-public-callback/reverse-tunnel.js`
- Create: `Rag/tools/wecom-public-callback/reverse-tunnel.test.js`
- Create: `Rag/tools/wecom-public-callback/install-tunnel-task.ps1`
- Create: `Rag/tools/wecom-public-callback/install-tunnel-task.test.ps1`

- [ ] **Step 1: Write failing Node tests for tunnel configuration**

Create `reverse-tunnel.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSshArguments, reconnectDelayMs, validateConfig } = require('./reverse-tunnel')

const CONFIG = {
  sshHost: 'ecs.example.test',
  sshPort: 22,
  sshUser: 'wecom-tunnel',
  identityFile: 'E:\\secure\\wecom-tunnel\\id_ed25519',
  remotePort: 18788,
  localPort: 8788
}

test('builds a loopback-only SSH reverse forward with no shell', () => {
  const args = buildSshArguments(CONFIG)
  assert.ok(args.includes('-N'))
  assert.ok(args.includes('-T'))
  assert.ok(args.includes('127.0.0.1:18788:127.0.0.1:8788'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.equal(args.some(value => /0\.0\.0\.0:18788/.test(value)), false)
  assert.equal(args.at(-1), 'wecom-tunnel@ecs.example.test')
})

test('rejects unsafe host, user, port, and identity inputs', () => {
  assert.throws(() => validateConfig({ ...CONFIG, sshHost: 'host;shutdown' }), /sshHost/)
  assert.throws(() => validateConfig({ ...CONFIG, sshUser: 'root user' }), /sshUser/)
  assert.throws(() => validateConfig({ ...CONFIG, remotePort: 443 }), /remotePort/)
  assert.throws(() => validateConfig({ ...CONFIG, localPort: 3001 }), /localPort/)
  assert.throws(() => validateConfig({ ...CONFIG, identityFile: '' }), /identityFile/)
})

test('uses bounded exponential reconnect delay', () => {
  assert.deepEqual([0, 1, 2, 8].map(reconnectDelayMs), [1000, 2000, 4000, 30000])
})
```

- [ ] **Step 2: Run the tunnel tests and verify RED**

```powershell
cd E:\project\project\Rag
node --test tools/wecom-public-callback/reverse-tunnel.test.js
```

Expected: FAIL because `reverse-tunnel.js` does not exist.

- [ ] **Step 3: Implement the supervisor**

Create `reverse-tunnel.js` with these exported contracts:

```js
const { spawn } = require('node:child_process')
const path = require('node:path')

function requiredText(value, name, pattern) {
  const text = String(value || '').trim()
  if (!text || (pattern && !pattern.test(text))) throw new Error(`${name} is invalid`)
  return text
}

function validateConfig(input = {}) {
  const config = {
    sshHost: requiredText(input.sshHost, 'sshHost', /^[A-Za-z0-9.-]+$/),
    sshPort: Number(input.sshPort || 22),
    sshUser: requiredText(input.sshUser || 'wecom-tunnel', 'sshUser', /^[A-Za-z_][A-Za-z0-9_-]*$/),
    identityFile: path.resolve(requiredText(input.identityFile, 'identityFile')),
    remotePort: Number(input.remotePort || 18788),
    localPort: Number(input.localPort || 8788)
  }
  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) throw new Error('sshPort is invalid')
  if (config.remotePort !== 18788) throw new Error('remotePort must be 18788')
  if (config.localPort !== 8788) throw new Error('localPort must be 8788')
  return config
}

function buildSshArguments(input) {
  const config = validateConfig(input)
  return [
    '-N', '-T', '-p', String(config.sshPort), '-i', config.identityFile,
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=yes',
    '-R', `127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort}`,
    `${config.sshUser}@${config.sshHost}`
  ]
}

function reconnectDelayMs(attempt) {
  return Math.min(1000 * (2 ** Math.max(0, Number(attempt) || 0)), 30000)
}
```

The CLI must accept `--ssh-host`, `--ssh-port`, `--ssh-user`, `--identity-file`, `--remote-port`, and `--local-port`; start `ssh.exe` with `windowsHide: true` and ignored stdin/stdout; log only structured event names, exit codes, and retry delay. It must never log the full SSH arguments or identity-file contents. Handle `SIGINT`/`SIGTERM` by killing the child and exiting without reconnecting.

- [ ] **Step 4: Run the Node tests and verify GREEN**

Run the command from Step 2.

Expected: 3 tests PASS.

- [ ] **Step 5: Write the scheduled-task dry-run test**

Create `install-tunnel-task.test.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'install-tunnel-task.ps1'
$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
  -DryRun -SshHost 'ecs.example.test' -IdentityFile 'E:\secure\wecom-tunnel\id_ed25519'
$plan = $raw | ConvertFrom-Json

if ($plan.taskName -ne 'Rag-WeCom-Reverse-Tunnel') { throw 'Unexpected task name.' }
if ($plan.arguments -notmatch '--remote-port 18788') { throw 'Remote port is not fixed.' }
if ($plan.arguments -notmatch '--local-port 8788') { throw 'Local gateway port is not fixed.' }
if ($plan.arguments -match '0\.0\.0\.0') { throw 'Public bind is forbidden.' }
if ($plan.arguments -match 'password|secret|token') { throw 'Task arguments contain a secret field.' }
Write-Output 'wecom tunnel scheduled-task contract passed'
```

- [ ] **Step 6: Run the PowerShell test and verify RED**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\project\project\Rag\tools\wecom-public-callback\install-tunnel-task.test.ps1
```

Expected: FAIL because the installer does not exist.

- [ ] **Step 7: Implement the scheduled-task installer**

Create `install-tunnel-task.ps1` with mandatory `SshHost` and `IdentityFile`, defaults `SshPort=22`, `SshUser=wecom-tunnel`, and a `DryRun` switch. Resolve `node.exe`, `reverse-tunnel.js`, and the identity file to absolute paths. Build a scheduled-task action equivalent to:

```powershell
$arguments = @(
  ('"' + $tunnelScript + '"'),
  '--ssh-host', $SshHost,
  '--ssh-port', [string]$SshPort,
  '--ssh-user', $SshUser,
  '--identity-file', ('"' + $resolvedIdentity + '"'),
  '--remote-port', '18788',
  '--local-port', '8788'
) -join ' '
```

`-DryRun` returns `{ taskName, program, arguments }` as JSON without touching Task Scheduler. The real path uses `Register-ScheduledTask` with startup and logon triggers, `RunLevel Highest`, restart-on-failure settings, and no stored password. Do not register the task during this code task.

- [ ] **Step 8: Run both tunnel tests and syntax checks**

```powershell
cd E:\project\project\Rag
node --check tools/wecom-public-callback/reverse-tunnel.js
node --test tools/wecom-public-callback/reverse-tunnel.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\wecom-public-callback\install-tunnel-task.test.ps1
```

Expected: all commands exit `0`.

- [ ] **Step 9: Record checkpoint**

Record the four created files and test results. Conventional commit if Git becomes available:

```text
feat: add restricted wecom reverse tunnel
```

---

### Task 3: Add ECS Nginx and Readiness Contracts

**Files:**
- Create: `Rag/tools/wecom-public-callback/nginx-wecom-bootstrap.conf`
- Create: `Rag/tools/wecom-public-callback/nginx-wecom.conf`
- Create: `Rag/tools/wecom-public-callback/nginx-wecom.test.js`
- Create: `Rag/tools/wecom-public-callback/check-readiness.js`
- Create: `Rag/tools/wecom-public-callback/check-readiness.test.js`

- [ ] **Step 1: Write failing Nginx security tests**

Create `nginx-wecom.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const source = readFileSync(require.resolve('./nginx-wecom.conf'), 'utf8')
const bootstrap = readFileSync(require.resolve('./nginx-wecom-bootstrap.conf'), 'utf8')

test('bootstrap serves only the ACME challenge before TLS exists', () => {
  assert.match(bootstrap, /server_name\s+wecom\.thelonelybrave\.cn;/)
  assert.match(bootstrap, /location \^~ \/\.well-known\/acme-challenge\//)
  assert.match(bootstrap, /root\s+\/var\/www\/certbot;/)
  assert.match(bootstrap, /location \/\s*\{\s*return 404;/s)
  assert.doesNotMatch(bootstrap, /proxy_pass|ssl_certificate/)
})

test('terminates HTTPS and proxies only the WeCom callback path', () => {
  assert.match(source, /server_name\s+wecom\.thelonelybrave\.cn;/)
  assert.match(source, /location \^~ \/webhooks\/wecom\//)
  assert.match(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:18788;/)
  assert.match(source, /location \/\s*\{\s*return 404;/s)
  assert.doesNotMatch(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:(3001|3003|8787)/)
})

test('does not log callback query strings and applies bounded request controls', () => {
  assert.match(source, /log_format\s+wecom_callback[^;]*\$uri[^;]*;/s)
  assert.doesNotMatch(source, /log_format\s+wecom_callback[^;]*\$request_uri/s)
  assert.match(source, /client_max_body_size\s+1m;/)
  assert.match(source, /limit_req\s+zone=wecom_callback/)
  assert.match(source, /limit_except GET POST/)
})
```

- [ ] **Step 2: Run the Nginx test and verify RED**

```powershell
cd E:\project\project\Rag
node --test tools/wecom-public-callback/nginx-wecom.test.js
```

Expected: FAIL because the Nginx configurations do not exist.

- [ ] **Step 3: Create the hardened Nginx configuration**

Create `nginx-wecom-bootstrap.conf`:

```nginx
server {
    listen 80;
    server_name wecom.thelonelybrave.cn;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
    }

    location / { return 404; }
}
```

Create `nginx-wecom.conf`:

```nginx
log_format wecom_callback '$remote_addr [$time_local] $request_method $uri $status $body_bytes_sent $request_time';
limit_req_zone $binary_remote_addr zone=wecom_callback:10m rate=120r/m;

server {
    listen 80;
    server_name wecom.thelonelybrave.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name wecom.thelonelybrave.cn;

    ssl_certificate /etc/letsencrypt/live/wecom.thelonelybrave.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wecom.thelonelybrave.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;

    access_log /var/log/nginx/wecom-callback.access.log wecom_callback;
    error_log /var/log/nginx/wecom-callback.error.log warn;
    client_max_body_size 1m;

    location ^~ /webhooks/wecom/ {
        limit_req zone=wecom_callback burst=30 nodelay;
        limit_except GET POST { deny all; }
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
        proxy_pass http://127.0.0.1:18788;
    }

    location / { return 404; }
}
```

- [ ] **Step 4: Run the Nginx tests and verify GREEN**

Run the command from Step 2.

Expected: 2 tests PASS.

- [ ] **Step 5: Write failing readiness tests**

Create `check-readiness.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { assessReadiness, redactDiagnostic } = require('./check-readiness')

test('requires local gateway, DNS, valid TLS, public HTTPS, and ECS tunnel health', () => {
  const ready = assessReadiness({ localGateway: true, dns: true, tls: true, https: true, ecsTunnel: true })
  assert.deepEqual(ready, { ready: true, failed: [] })
  assert.deepEqual(
    assessReadiness({ localGateway: true, dns: false, tls: false, https: false, ecsTunnel: true }).failed,
    ['dns', 'tls', 'https']
  )
})

test('redacts URLs, query strings, and token-shaped diagnostics', () => {
  const value = redactDiagnostic('GET https://host/path?msg_signature=abc token=secret')
  assert.doesNotMatch(value, /abc|secret|msg_signature/)
})
```

- [ ] **Step 6: Run readiness tests and verify RED**

```powershell
node --test E:\project\project\Rag\tools\wecom-public-callback\check-readiness.test.js
```

Expected: FAIL because `check-readiness.js` does not exist.

- [ ] **Step 7: Implement the readiness checker**

Create `check-readiness.js` exporting:

```js
function assessReadiness(checks) {
  const failed = ['localGateway', 'dns', 'tls', 'https', 'ecsTunnel'].filter(name => checks[name] !== true)
  return { ready: failed.length === 0, failed }
}

function redactDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(?:msg_signature|token|secret|access_token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .slice(0, 240)
}
```

The CLI uses only Node built-ins to perform:

- local `http://127.0.0.1:8788/healthz` JSON health check;
- DNS A/AAAA resolution for `wecom.thelonelybrave.cn`;
- TLS certificate hostname and expiry validation on port `443`;
- public `https://wecom.thelonelybrave.cn/` request, accepting a controlled `404` as proof of the callback-only virtual host;
- optional SSH loopback probe using a dedicated read-only probe account/key. Do not reuse the `wecom-tunnel` reverse-forward runtime key for this probe. If the probe key is restricted with a forced command, that command must only check `http://127.0.0.1:18788/healthz`.

Output exactly one JSON object with booleans and safe error codes. Never output resolved IP addresses, certificate serial numbers, SSH arguments, callback query strings, response bodies, or credentials. Exit `0` only when all five checks pass; exit `1` otherwise.

- [ ] **Step 8: Run all infrastructure contract tests**

```powershell
cd E:\project\project\Rag
node --test tools/wecom-public-callback/nginx-wecom.test.js tools/wecom-public-callback/check-readiness.test.js tools/wecom-public-callback/reverse-tunnel.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\wecom-public-callback\install-tunnel-task.test.ps1
```

Expected: all tests PASS.

- [ ] **Step 9: Record checkpoint**

Record the five created files and test results. Conventional commit if Git becomes available:

```text
feat: add wecom public callback infrastructure contracts
```

---

### Task 4: Update the Operator Runbook

**Files:**
- Modify: `Rag/docs/wecom-account-operations.md`
- Reference: `Rag/docs/superpowers/specs/2026-08-07-wecom-public-callback-rollout-design.md`

- [ ] **Step 1: Add the fixed environment and order**

Document these exact values and boundaries:

```text
WECOM_PUBLIC_CALLBACK_BASE_URL=https://wecom.thelonelybrave.cn
Public callback: https://wecom.thelonelybrave.cn/webhooks/wecom/<callbackKey>
ECS loopback forward: 127.0.0.1:18788
Local gateway health: 127.0.0.1:8788
Scheduled task: Rag-WeCom-Reverse-Tunnel
```

State the required order explicitly:

```text
verify and sync -> publish runtime -> copy callback URL -> save callback in Enterprise WeCom -> controlled inbound test
```

- [ ] **Step 2: Add external-change approval gates**

The runbook must say:

```text
Approval A: submit or change ICP filing data.
Approval B: create/change Alibaba Cloud DNS records, security-group rules, ECS users, SSH configuration, Nginx, or certificates.
Approval C: save the callback URL in Enterprise WeCom.
Approval D: send the first real manual test reply.
```

These approvals are required at action time even though the implementation design is approved.

- [ ] **Step 3: Add exact safe rollback commands**

Document:

```powershell
Disable-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
Stop-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
```

and the ordered product rollback:

```text
1. Disable runtime from platform-web and wait for gateway confirmation.
2. Disable the callback in Enterprise WeCom.
3. Stop and disable the Windows tunnel task.
4. Preserve connection, account, message, and audit data.
```

- [ ] **Step 4: Scan the runbook for secrets and placeholders**

```powershell
cd E:\project\project\Rag
rg -n "TBD|TODO|corpsecret=|access_token=|EncodingAESKey=[A-Za-z0-9+/]" docs\wecom-account-operations.md
```

Expected: no output.

- [ ] **Step 5: Record checkpoint**

Record the updated runbook and scan output. Conventional commit if Git becomes available:

```text
docs: add enterprise wecom public callback runbook
```

---

### Task 5: Provision ICP, DNS, ECS, Certificate, and Tunnel

**Files:**
- Use: `Rag/tools/wecom-public-callback/nginx-wecom.conf`
- Use: `Rag/tools/wecom-public-callback/install-tunnel-task.ps1`
- Use: `Rag/tools/wecom-public-callback/check-readiness.js`

**External-change gate:** Stop before Step 2 and obtain explicit approval for Alibaba Cloud/ICP changes. Stop again before Step 7 and obtain approval before registering the Windows scheduled task.

- [ ] **Step 1: Read-only inspect current Alibaba Cloud state**

Using the already authenticated Alibaba Cloud browser session, record only:

- current ICP filing status and filing subject name for `thelonelybrave.cn`;
- whether the domain is in the same Alibaba Cloud account;
- the ECS operating system, running state, region, and whether ports `80/443` are already open;
- whether Nginx, Certbot, a `wecom-tunnel` user, or an existing callback virtual host already exists.

Do not display the ECS public IP, account identifiers, SSH keys, cookies, or access keys in chat or logs.

- [ ] **Step 2: Complete the approved ICP correction**

Submit only the filing change that makes `thelonelybrave.cn` consistent with the Enterprise WeCom certified entity, using the company documents already approved by the user. Do not invent company data or submit until every legal field is user-confirmed in the Alibaba Cloud form.

Expected: Alibaba Cloud/MIIT shows the filing as approved for the correct entity. If review is pending, mark Task 5 blocked at this step; do not proceed to DNS or callback setup.

- [ ] **Step 3: Create the DNS record after ICP approval**

Create one A record:

```text
Host: wecom
Type: A
Value: the existing Hangzhou ECS public IPv4
TTL: 600
```

Do not create wildcard records and do not change unrelated records.

Verify without printing the address:

```powershell
$records = Resolve-DnsName 'wecom.thelonelybrave.cn' -Type A
if (-not $records) { throw 'WeCom callback DNS does not resolve.' }
'DNS_OK'
```

- [ ] **Step 4: Configure the restricted ECS tunnel account**

On ECS, create `wecom-tunnel` with no password and no interactive shell. On Windows, construct the authorized-key line from the generated public key without printing the private key:

```powershell
$publicKey = (Get-Content -Raw -LiteralPath 'E:\project\project\Rag\data\wecom-tunnel\id_ed25519.pub').Trim()
$restrictedKey = 'restrict,port-forwarding,permitlisten="127.0.0.1:18788" ' + $publicKey
```

Install `$restrictedKey` as the only line in that tunnel account's `authorized_keys`; never paste the private key. Confirm `GatewayPorts no` and `AllowTcpForwarding remote` for the tunnel account, then validate `sshd -t` before reload. Do not weaken the global SSH policy for other users.

Create a separate `wecom-probe` readiness account/key only if ECS loopback probing is used. It must not share the `wecom-tunnel` runtime private key. Restrict the probe key to the health check command `curl -fsS --max-time 5 http://127.0.0.1:18788/healthz`, or use an equivalently constrained read-only account. Do not enable an interactive shell for the tunnel account to make readiness pass.

- [ ] **Step 5: Install Nginx and issue the certificate**

On Alibaba Cloud Linux, install Nginx and Certbot using the available `dnf` or `yum` packages. Create `/var/www/certbot`, install `nginx-wecom-bootstrap.conf`, and enable Nginx before requesting the certificate:

```bash
sudo install -d -m 0755 /var/www/certbot
sudo install -m 0644 nginx-wecom-bootstrap.conf /etc/nginx/conf.d/wecom-bootstrap.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo certbot certonly --webroot -w /var/www/certbot -d wecom.thelonelybrave.cn
```

Only after Certbot reports success, replace the bootstrap virtual host with the final configuration:

```bash
sudo rm -f /etc/nginx/conf.d/wecom-bootstrap.conf
sudo install -m 0644 nginx-wecom.conf /etc/nginx/conf.d/wecom.conf
sudo nginx -t
sudo systemctl reload nginx
```

Expected: both `nginx -t` commands and Certbot succeed; HTTPS root returns controlled `404`; query strings do not appear in the dedicated callback access log. If certificate issuance fails, keep the bootstrap host, do not install the TLS configuration, and do not configure the Enterprise WeCom callback.

- [ ] **Step 6: Restrict the ECS security group**

Allow inbound `80/443` for the public callback. Keep `18788` closed to the public. Restrict SSH to the user's approved administration source range; do not open MySQL, Redis, `3001`, `3003`, `8787`, or `8788`.

- [ ] **Step 7: Generate the dedicated key and register the tunnel task**

On Windows, create `E:\project\project\Rag\data\wecom-tunnel`, restrict its ACL to the current user and Administrators, and generate a dedicated Ed25519 key. Add only the public key to ECS.

Dry-run first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\project\project\Rag\tools\wecom-public-callback\install-tunnel-task.ps1 `
  -DryRun -SshHost $env:WECOM_ECS_SSH_HOST -IdentityFile E:\project\project\Rag\data\wecom-tunnel\id_ed25519
```

After explicit approval, rerun without `-DryRun`, start `Rag-WeCom-Reverse-Tunnel`, and confirm the task is running.

- [ ] **Step 8: Run readiness verification**

```powershell
node E:\project\project\Rag\tools\wecom-public-callback\check-readiness.js `
  --domain wecom.thelonelybrave.cn `
  --ssh-host $env:WECOM_ECS_SSH_HOST `
  --ssh-port 22 `
  --ssh-user wecom-probe `
  --identity-file E:\project\project\Rag\data\wecom-probe\id_ed25519
```

Expected JSON:

```json
{"ready":true,"checks":{"localGateway":true,"dns":true,"tls":true,"https":true,"ecsTunnel":true},"failed":[]}
```

- [ ] **Step 9: Record infrastructure checkpoint**

Record only pass/fail, timestamps, certificate expiry date, and service status. Do not record public IPs, keys, tokens, callback query strings, or response bodies.

---

### Task 6: Create and Publish the Real WeCom Connection

**Files:**
- Modify locally, without committing secrets: `Rag/rag-server/.env`
- Use UI: `https://localhost:3003/customer-service-accounts?channel=wecom_kf`

**External-change gate:** The user enters CorpID, Secret, Callback Token, and EncodingAESKey directly in the local UI. Never request or read these values in chat. Obtain explicit approval before saving the callback in Enterprise WeCom.

- [ ] **Step 1: Configure the public callback base URL**

Add only this non-secret setting to the existing backend environment:

```text
WECOM_PUBLIC_CALLBACK_BASE_URL=https://wecom.thelonelybrave.cn
```

Restart only `rag-server:3001` and verify the existing `wehook:8787/8788`, Redis, and frontend remain running.

- [ ] **Step 2: Create the enterprise connection in the local UI**

The administrator enters:

- connection name;
- CorpID;
- WeCom customer-service Secret;
- Callback Token;
- EncodingAESKey.

Verify the API response and browser DOM contain only the masked CorpID and callback URL, never the four credential values.

- [ ] **Step 3: Verify and sync accounts**

Click “验证并同步”. Expected:

- connection status becomes `verified`;
- at least one `open_kfid` account appears;
- every new account is locked with AI off and allowlist on;
- `客服1号`, if present, has `production_baseline` protection.

- [ ] **Step 4: Select the isolated test account**

Use a separately named `AI测试客服` account. If it does not exist in Enterprise WeCom, stop and have the administrator create it there, then rerun sync. Do not use `客服1号` as a substitute.

Set the test account to test protection with AI still off, keep allowlist enabled, and add exactly one approved test customer's `external_userid`.

- [ ] **Step 5: Publish the runtime**

Click “发布到网关”. Expected:

- `wehook` confirms the same connection ID and config version;
- connection becomes `active` only after confirmation;
- callback URL is copyable from the connection row;
- runtime configuration remains encrypted at rest.

- [ ] **Step 6: Save the callback in Enterprise WeCom**

After explicit approval, paste the copied URL into the Enterprise WeCom customer-service callback form and use the same locally entered Callback Token and EncodingAESKey. Submit the GET verification.

Expected: Enterprise WeCom accepts the URL. If it reports filing-entity mismatch, certificate error, timeout, or signature failure, stop and preserve AI-off state; do not rotate credentials until the failing layer is identified.

- [ ] **Step 7: Verify health signals**

Refresh the local connection page. Expected before real traffic:

- connection `active`;
- gateway connected;
- account sync time present;
- no callback or outbound timestamp fabricated before traffic occurs.

- [ ] **Step 8: Record connection checkpoint**

Record connection ID, test account display name, masked CorpID, config version, statuses, and timestamps only. Do not record secrets, `open_kfid`, `external_userid`, or callback key in the task log.

---

### Task 7: Execute the Controlled End-to-End Test and Rollback Drill

**Files:**
- Test: existing `wehook/test/wecom-*.test.js`
- Test: existing `Rag/rag-server/src/modules/platform-connections/*.test.js`
- Test: existing `Rag/rag-server/src/modules/cloud-gateway/*.test.js`
- Test: existing `Rag/platform-web/src/modules/accounts/CustomerServiceAccountsView.test.js`

**External-change gate:** Obtain explicit approval immediately before sending the first real manual reply to the allowlisted test customer.

- [ ] **Step 1: Run all offline regression suites**

```powershell
cd E:\project\project\wehook
npm test
npm run check

cd E:\project\project\Rag\rag-server
node --test src/modules/platform-connections/*.test.js src/modules/cloud-gateway/*.test.js src/modules/messaging/inboundMessage.service.test.js

cd E:\project\project\Rag\platform-web
node --test src/modules/accounts/CustomerServiceAccountsView.test.js src/modules/platformConnections/connectionForm.test.js
npm run build
```

Expected: every command exits `0`; no skipped security test and no credential text in output.

- [ ] **Step 2: Send one inbound test message**

From the approved allowlisted test customer, send a unique text such as:

```text
WECOM-E2E-20260807-INBOUND
```

Expected:

- one callback reaches Nginx and `wehook`;
- one normalized `wecom_kf` message appears in Rag;
- one conversation is associated with the correct test account;
- connection `lastCallbackAt` and account `lastInboundAt` advance;
- no AI reply is sent.

- [ ] **Step 3: Verify duplicate handling**

Use the existing offline replay test for exact duplicate delivery rather than replaying a signed production request from logs:

```powershell
cd E:\project\project\wehook
node --test test/wecom-offline.integration.test.js
```

Expected: duplicate delivery does not create a second Rag message.

- [ ] **Step 4: Send one approved manual reply**

After explicit approval, reply from the assigned agent with:

```text
WECOM-E2E-20260807-MANUAL-REPLY
```

Expected:

- the allowlisted customer receives exactly one message;
- Rag transitions the local message to `sent` or reports a sanitized official failure;
- account `lastOutboundAt` advances;
- no production account sends anything.

- [ ] **Step 5: Verify blocked sends**

Using automated tests only, verify locked account, production baseline, non-allowlisted customer, empty text, and unsupported media are blocked before the official API call. Do not send test traffic to a real non-allowlisted customer.

```powershell
cd E:\project\project\wehook
node --test test/wecom-provider.test.js test/wecom-api-client.test.js
```

- [ ] **Step 6: Run the tunnel failure drill**

Stop the Windows scheduled task for no more than two minutes:

```powershell
Stop-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
```

Expected:

- ECS Nginx returns upstream unavailable;
- Rag history remains available;
- no fallback send path activates;
- after restarting the task, readiness returns green and no duplicate message is created.

Restart:

```powershell
Start-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
```

- [ ] **Step 7: Run the product rollback drill**

1. Disable runtime in platform-web and wait for `wehook` confirmation.
2. Confirm a manual send is blocked.
3. Re-publish only after all health checks are green.

Do not remove the real callback during this drill unless an actual incident requires full rollback.

- [ ] **Step 8: Final security and dependency review**

```powershell
cd E:\project\project\Rag\rag-server
npm audit --omit=dev
rg -n "corpsecret=|access_token=|callbackToken|encodingAesKey" ..\logs E:\project\project\wehook\data E:\project\project\wehook\logs
```

Expected: audit output is recorded with existing vulnerabilities separated from newly introduced ones; secret scan produces no plaintext credential values. Do not run `npm audit fix --force`.

- [ ] **Step 9: Record final checkpoint**

Record:

- offline test counts;
- readiness JSON booleans;
- callback acceptance status;
- one inbound and one manual outbound timestamp;
- duplicate count `0`;
- unauthorized/blocked-send count and reason codes;
- rollback drill result.

Do not record secrets, public IPs, callback keys, `open_kfid`, `external_userid`, customer message content beyond the fixed test markers, or browser session data.

Conventional commit if Git becomes available:

```text
feat: complete enterprise wecom public callback rollout
```

---

## Completion Gate

The rollout is complete only when all conditions are true:

- ICP subject is accepted by Enterprise WeCom for `thelonelybrave.cn`.
- DNS and TLS are valid for `wecom.thelonelybrave.cn`.
- ECS exposes only HTTPS callback traffic and keeps `18788` loopback-only.
- Windows reverse tunnel automatically recovers and passes readiness checks.
- Callback URL is generated by Rag and copyable without credential exposure.
- Enterprise WeCom accepts callback verification.
- One allowlisted inbound and one approved manual outbound succeed exactly once.
- Production baseline and non-allowlisted sends remain blocked.
- Tunnel and runtime rollback drills pass without data loss.
- AI remains disabled pending a separate approval and rollout.
