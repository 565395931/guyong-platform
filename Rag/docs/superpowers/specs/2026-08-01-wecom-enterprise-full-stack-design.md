# 企业微信全栈接入设计

**日期：** 2026-08-01  
**状态：** 草案，待确认后实施  
**范围：** `Rag`、`wehook`、`platform-web`

## 1. Problem and Goal

当前企业微信链路已经拆成两半：`wehook` 具备回调验签、消息同步、发送和运行时配置骨架，`Rag` 具备企业连接、账号管理和发布接口骨架。缺口在于，这两半还没有被串成一条可上线、可回放、可运维的完整闭环。

这次修改要把企业微信的企业主体、客服账号、回调入口、消息同步、发信出口和管理界面接成一套一致的系统。目标是让管理员在 `Rag` 完成连接配置和账号同步后，`wehook` 能拿到加密运行时快照并对真实企业微信回调和发送请求工作，平台界面也能直接驱动这条链路。

## 2. Scope and Non-Goals

In scope:
- `Rag` 的企业微信连接管理、验证、同步账号、发布运行时、停用运行时
- `wehook` 的真实企业微信回调验签、解密、消息同步、文本发送
- `platform-web` 的企业微信连接和客服账号页面接入真实后端接口
- 运行时快照、同步游标、账号保护模式和白名单策略的联动
- 本地和离线联调测试，覆盖重复回调、重复发布和发送拦截

Out of scope:
- 个人微信接入
- 其他平台适配器的重构
- WAHA、桌面桥和其它渠道的协议变化
- 媒体发送能力的新增
- 生产环境部署编排、域名和证书采购

## 3. System Boundaries

```text
企业微信官方平台
  |  回调通知 / sync_msg / send_msg
  v
wehook
  |  /webhooks/wecom/:callbackKey
  |  加密运行时快照 / 同步游标
  |  标准化 inbound 事件
  v
Rag server
  |  /api/v1/platform-connections
  |  /api/v1/channel-accounts
  |  MySQL canonical state
  v
platform-web
  |  管理员操作 / 列表 / 详情 / 发布
  v
Rag admin API
```

边界归属如下：
- `Rag` 负责企业连接和客服账号的主数据
- `wehook` 负责加密后的运行时副本、回调处理和游标恢复
- 企业微信官方 API 负责签名、解密后的真实业务结果
- `platform-web` 只发起管理操作，不保存密钥和运行时副本

## 4. Ownership or Source of Truth

| Layer | Owns | Rebuildable |
|---|---|---|
| `rag-server` MySQL `platform_connections` | 企业连接生命周期、凭据密文、运行状态、审计日志 | No |
| `rag-server` MySQL `channel_accounts` | `open_kfid` 映射、保护模式、白名单、AI 开关、同步状态 | No |
| `wehook` runtime config store | 当前生效的加密运行时快照 | Yes, from `Rag` publish |
| `wehook` sync-state store | 每个连接的同步游标和失败标记 | Yes |
| 企业微信官方平台 | 验签、消息列表、发信结果 | No |

运行时快照不是主数据。它只保存 `Rag` 已发布且 `wehook` 已确认接收的可执行副本。

## 5. Core Decisions

1. **What:** `Rag` 继续作为企业微信主数据的唯一写入口。  
   **Why:** 连接状态、账号策略和审计记录需要和现有账号体系统一。  
   **Reversal condition:** 如果后续要支持多控制面并行写入，再拆分主写入口。

2. **What:** 运行时发布采用“Rag 落库后发布到 `wehook`，`wehook` 应答后再置为生效”的顺序。  
   **Why:** 这样可以避免 `Rag` 标记为 active 但 `wehook` 还没拿到快照的半成品状态。  
   **Reversal condition:** 只有当 `wehook` 变成不可用时，才需要另引入补偿队列。

3. **What:** 入站回调先验签、再解密、再向企业微信官方拉取同步消息，最后交给 `Rag`。  
   **Why:** 官方回调只做通知，真实消息内容以同步接口为准。  
   **Reversal condition:** 只有在官方协议改成直接推送完整消息时才改顺序。

4. **What:** 出站发送只支持 `wecom_kf` 文本消息。  
   **Why:** 当前适配器和测试矩阵已经覆盖这条路径，媒体发送的行为边界还没定完。  
   **Reversal condition:** 媒体发送的业务规则和存储契约补齐后，再扩展消息类型。

5. **What:** `platform-web` 只调用后端管理接口，不直接接触企业微信密钥。  
   **Why:** 这样密钥流转、校验和审计可以集中在后端。  
   **Reversal condition:** 只有在前端需要本地生成一次性签名材料时才放开更窄的暴露面。

## 6. Runtime Flows

### 6.1 连接验证与发布

```text
管理员
  -> platform-web 保存企业连接
  -> Rag 校验凭据并同步 open_kfid 账号列表
  -> Rag 生成加密运行时快照
  -> Rag 通过已认证 cloud-gateway 发送 gateway.config.apply
  -> wehook 持久化密文并返回 gateway.config.applied
  -> Rag 标记连接 active / verified
```

失败分支：
- 官方 API 验证失败时，连接保持 `draft` 或 `error`
- `wehook` 未确认接收时，连接不进入 `active`
- 同版本重复发布返回幂等成功，不写第二份快照

### 6.2 入站回调与同步

```text
企业微信
  -> wehook /webhooks/wecom/:callbackKey
  -> 验签与解密
  -> sync_msg 拉取完整消息页
  -> 标准化为 wecom_kf inbound
  -> 交给 Rag ingestInbound
  -> Rag 持久化事件并 ACK
  -> wehook 推进同步游标
```

失败分支：
- 回调签名或接收方不匹配，直接拒绝
- 同步游标不前进，记录失败并停止继续页拉取
- Rag ACK 失败时，不推进成功游标

### 6.3 出站发送

```text
Rag 发送命令
  -> wehook provider 读取运行时快照
  -> 校验连接 active、账号状态、保护模式和白名单
  -> 调用企业微信 send_msg
  -> 返回 channelMessageId
  -> Rag 记录 accepted / sent / failed
```

失败分支：
- 账号锁定、目标不在白名单或文本为空时直接阻断
- 官方接口返回错误时标记为失败并保留错误码
- 重复 `commandId` 返回原结果，不再次调用官方 API

## 7. Data and Interface Contracts

### 7.1 `Rag` 管理接口

`GET /api/v1/platform-connections`  
`POST /api/v1/platform-connections`

- `channel_code` string required, fixed `wecom_kf`
- `connection_name` string required
- `corp_id` string required
- `credential_ciphertext` string required
- `callback_token_ciphertext` string required
- `encoding_aes_key_ciphertext` string required

success `200/201` -> `{ success, message, data }`
error `400` -> validation failure
error `401` -> unauthenticated
error `403` -> insufficient role

`PATCH /api/v1/platform-connections/:id/credentials`

- replaces encrypted credentials only
- preserves connection identity and account mapping

`POST /api/v1/platform-connections/:id/verify`

- validates official credentials
- syncs `open_kfid` accounts
- returns connection status and account count

`POST /api/v1/platform-connections/:id/publish-runtime`

- encrypts the runtime snapshot in memory
- sends `gateway.config.apply`
- waits for `gateway.config.applied`
- returns the published connection/version

`POST /api/v1/platform-connections/:id/disable-runtime`

- publishes a disabled runtime snapshot
- marks the connection disabled only after `wehook` confirms the disable snapshot

`GET /api/v1/platform-connections/:id/accounts`

- returns account policy, sync status, allowlist state and last activity fields

### 7.2 `platform_connections` persistent object

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | primary key |
| `channel_code` | enum | yes | `wecom_kf` |
| `connection_name` | string | yes | admin label |
| `corp_id` | string | yes | decrypted only in memory |
| `credential_ciphertext` | string | yes | encrypted secret bundle |
| `callback_key` | string | yes | unguessable route key |
| `status` | enum | yes | `draft / verified / active / disabled / error` |
| `health_status` | enum | yes | `unknown / healthy / degraded / error` |
| `last_token_refresh_at` | timestamp | no | RFC 3339 |
| `last_callback_at` | timestamp | no | RFC 3339 |
| `last_sync_at` | timestamp | no | RFC 3339 |

### 7.3 `channel_accounts` persistent object

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | primary key |
| `connection_id` | integer | yes | owning enterprise connection |
| `external_account_id` | string | yes | `open_kfid` |
| `account_name` | string | yes | display name |
| `protection_level` | enum | yes | `locked / test / none` |
| `ai_enabled` | boolean | yes | outbound AI allowed |
| `allowlist_enabled` | boolean | yes | test mode gate |
| `sync_status` | enum | yes | `active / missing / disabled / error` |
| `last_inbound_at` | timestamp | no | RFC 3339 |
| `last_outbound_at` | timestamp | no | RFC 3339 |

### 7.4 `wehook` runtime snapshot record

| Field | Type | Required | Notes |
|---|---|---|---|
| `connectionId` | integer | yes | must match the published request |
| `configVersion` | integer | yes | monotonically increasing |
| `callbackKey` | string | yes | callback route lookup key |
| `corpId` | string | yes | decrypted only in memory |
| `secret` | string | yes | official API secret |
| `callbackToken` | string | yes | callback verification token |
| `encodingAesKey` | string | yes | 43-char base64 key |
| `accounts` | array | yes | account map with `accountId`, `openKfId`, `status` |

### 7.5 `wehook` sync-state record

| Field | Type | Required | Notes |
|---|---|---|---|
| `connectionId` | integer | yes | primary lookup key |
| `cursor` | string | yes | last successful sync cursor |
| `lastSuccessAt` | timestamp | no | RFC 3339 |
| `lastFailureAt` | timestamp | no | RFC 3339 |
| `failureCount` | integer | yes | consecutive sync failure count |

### 7.6 State machine

`platform_connections.status`

```text
draft     -> verified   (official credentials verified and accounts synced)
verified  -> active     (runtime published and confirmed by wehook)
active    -> disabled   (disable runtime published and confirmed)
active    -> error      (verification, publish, or sync failure)
verified  -> error      (publish failure after verification)
error     -> verified   (retry succeeds)
```

`channel_accounts.sync_status`

```text
missing  -> active   (official account list contains the `open_kfid`)
active   -> missing  (official list no longer contains the account)
active   -> disabled (admin disables the account)
active   -> error    (sync or write failure)
error    -> active   (retry succeeds)
```

### 7.7 Deletion and retention

- `platform_connections` and `channel_accounts` use soft-disable semantics.
- `wehook` runtime snapshots are overwritten by the latest active version.
- `wehook` sync-state records are retained so replay and recovery use the last cursor.
- operation logs are retained and redacted; plaintext secrets do not enter logs.

### 7.8 Filesystem Layout

Root workspaces:
- `E:\project\project\Rag`
- `E:\project\project\wehook`

Ownership:
- `Rag/docs/superpowers/specs` owns the canonical design and rollout docs for this change
- `Rag/rag-server/src/modules/platform-connections` owns connection CRUD, verification and runtime publish
- `Rag/platform-web/src/views/Settings` owns the operator UI for connection and account management
- `wehook/src/wecom` owns the enterprise WeCom adapter, runtime config, callback crypto and official API client
- `wehook/test` owns adapter and offline integration coverage

## 8. Failure Cases and Acceptance

Capability: connection verification publishes the right runtime
  Failure example: credentials validate in `Rag` but `wehook` never receives the runtime snapshot
  Expected: the connection stays non-active until `gateway.config.applied` returns
  Completion signal: published connection/version count = 1, active-state count = 1

Capability: repeated callback replay stays idempotent
  Failure example: the same enterprise callback creates two inbound events
  Expected: one normalized `wecom_kf` event, one processed ACK, one cursor advance
  Completion signal: duplicate inbound side-effect count = 0

Capability: blocked outbound sends never reach the official API
  Failure example: a locked or non-allowlisted account still calls `send_msg`
  Expected: `WECOM_SEND_BLOCKED` is returned and no official send happens
  Completion signal: unauthorized outbound API call count = 0

Capability: secrets never leak to logs or responses
  Failure example: `secret`, `callbackToken` or `encodingAesKey` appears in a log line or JSON response
  Expected: only redacted identifiers and status fields are observable
  Completion signal: plaintext secret leak count = 0

Capability: duplicate runtime publish stays idempotent
  Failure example: same `connectionId` and `configVersion` write two different active snapshots
  Expected: the second publish returns the original result or a conflict, with no second side effect
  Completion signal: conflicting same-version publish count = 0

## 9. Implementation Phases or Rollout Steps

Phase 1: Rag connection management completion  
Includes: connection CRUD, credential replacement, verify-and-sync, runtime publish and disable endpoints, schema alignment, route tests.  
Done when: an admin can create a WeCom connection, verify credentials, sync accounts and see the connection state persist after restart.  
Blocks: `wehook` cannot receive a runtime until the publish path exists.

Phase 2: wehook live runtime and callback loop  
Includes: runtime snapshot apply, live callback endpoint, sync cursor persistence, official API client wiring, outbound policy checks.  
Done when: a real callback lands once, syncs once, and a valid send returns a platform message id through the adapter.  
Blocks: local end-to-end validation depends on Phase 1 publishing the runtime.

Phase 3: platform-web operator surface  
Includes: connection page wiring, account policy controls, allowlist actions, runtime publish/disable actions and status display.  
Done when: the full enterprise WeCom setup can be completed from the UI without raw API calls.  
Blocks: UI actions depend on Phase 1 and Phase 2 API behavior stabilizing.

Phase 4: integration verification  
Includes: offline callback replay test, duplicate publish test, blocked send test and secret-redaction checks across both repos.  
Done when: the cross-repo test matrix passes and all zero-tolerance acceptance signals stay at 0.  

