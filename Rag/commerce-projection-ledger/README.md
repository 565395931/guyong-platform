# @rag/commerce-projection-ledger

供应商无关的外部订单投影协调层。它依赖 [`@rag/commerce-protocol`](../shared-protocol/commerce)，负责把已验证的订单命令交给未来的 Vendure 适配器，并维护投影任务和外部订单映射的接口。

本包提供内存存储、参数化 MySQL/Sequelize store、离线 DDL 和抽象 `VendureOrderPort`。测试不连接 MySQL、Redis、Vendure 或任何平台 API。

## 公共入口

```ts
import {
  InMemoryProjectionLedgerStore,
  ProjectionCoordinator,
} from '@rag/commerce-projection-ledger'

const store = new InMemoryProjectionLedgerStore({
  accounts: [{ channel: 'taobao', accountId: 7, vendureChannelId: 'channel-7' }],
  skus: [{
    channel: 'taobao',
    accountId: 7,
    sku: 'SKU-001',
    vendureProductVariantId: 'variant-1',
  }],
})

const coordinator = new ProjectionCoordinator({
  store,
  vendure: vendureOrderPort,
  compareExternalVersions: (incoming, current) => incoming.localeCompare(current),
})

const outcome = await coordinator.projectExternalOrder(commandV2)
```

MySQL 适配器使用相同接口：

```ts
import {
  MySqlProjectionLedgerStore,
  ensureCommerceProjectionSchema,
} from '@rag/commerce-projection-ledger'

const store = new MySqlProjectionLedgerStore(sequelize)

// 只允许在审批后的迁移流程中执行；包导入本身不会运行 DDL。
await ensureCommerceProjectionSchema(sequelize)
```

DDL 包含 `commerce_account_mappings`、`commerce_sku_mappings`、`commerce_order_links` 和 `commerce_projection_jobs`。任务只保存命令引用和订单身份元数据，不复制客户、地址或平台 payload。

`VendureOrderPort.project()` 必须按 `(channel, accountId, externalOrderId)` 幂等，并返回 `vendureOrderId`、`orderCode`、规范化状态、最小货币单位总额和已应用外部版本。协调器会重新核对总额、版本、状态和响应标识。

## 处理保证

- `eventInboxId` 唯一：任务创建/领取是原子操作，重复事件返回 `duplicate`，不会再次调用 Vendure。
- 外部订单版本由调用方注入比较器定义；旧版本返回 `stale`，不回退订单。
- 账号或任一 SKU 未映射时标记终止失败，且不会调用 Vendure。
- 不允许的状态转换标记 `STATE_TRANSITION_DENIED`。
- `CommerceUnavailableError` 和未知端口异常标记 `retryable_failed`。
- 金额不一致、非法端口响应和协议错误标记 `terminal_failed`。
- 任务错误只保存错误码和短诊断摘要；返回的 outcome、任务、映射均为冻结副本。

## 后续适配

生产启用前仍需把 schema 执行接入正式迁移流程，并实现 `VendureOrderPort` 插件版本。跨系统事务不能假设存在；Vendure 成功后账本写入失败必须通过外部订单身份重试恢复。

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run audit:production
```

## Enterprise runtime (2026-08-11)

The package now includes a durable `ProjectionWorker`, capped exponential backoff, lease recovery,
retry exhaustion to terminal work, and `HttpCommerceOrderPort`. The HTTP port requires HTTPS by
default and signs method, path, idempotency key, timestamp, and body with HMAC-SHA256.

Rag integrates the package through `rag-server/src/modules/commerce-projection`. Only inbox events
that contain a validated `payload_json.projectionCommand` v2 are dispatched. Database-owned event,
channel, account, and business-key values override payload identity fields. Raw platform orders are
never guessed into commerce commands.

Operations endpoints are mounted at `/api/v1/commerce-projections`. They require an administrator
JWT. Manual replay is restricted to terminal jobs, requires a reason, and records actor, reason, and
the status transition in `commerce_projection_audit_logs` in the same transaction.

Production verification for this package: 60 tests, 95.25% statement coverage, 85.67% branch
coverage, successful typecheck/build, and zero production dependency advisories.
