# Commerce Projection Ledger Design

日期：2026-08-10

## 目标

为已完成的 `@rag/commerce-protocol` v2 增加一个供应商无关的投影账本协调层，验证外部订单从 `channel_event_inbox` 到 Vendure 端口之间的幂等、乱序、SKU 映射和错误分类。该阶段只运行离线合成数据，不连接 Rag 数据库、Vendure、Redis 或真实平台。

## 包边界

新包位于 `Rag/commerce-projection-ledger/`，依赖本地 `@rag/commerce-protocol`：

- 校验 v2 命令并使用其金额不变量；
- 为 `(channel, accountId, externalOrderId)` 维护订单链接；
- 为 `eventInboxId` 维护投影任务状态；
- 解析账号和 SKU 映射；
- 调用抽象的 Vendure order port；
- 将异常分类为终止失败、可重试失败或旧事件。

包不负责：SQL、数据库迁移、队列驱动、OAuth、平台 SDK、库存实现或 Vendure Core API。后续适配器只能实现本包接口，不能绕过协调器直接写订单。

## 跨系统流程

```text
v2 command
   |
   v
validateExternalOrderCommandV2
   |
   v
createOrGetJob(eventInboxId) ---- existing succeeded/processing --> duplicate result
   |
   v
resolve account + every SKU
   |\
   | \-- missing mapping --> terminal_failed (no Vendure call)
   v
compare externalVersion + normalizedStatus
   |\
   | \-- old version --> stale result (no Vendure call)
   v
VendureOrderPort.project (idempotency key = external identity)
   |\
   | \-- unavailable --> retryable_failed
   | \-- contract/state/total error --> terminal_failed
   v
completeJob + upsertOrderLink
```

账本状态写入和 Vendure 调用不是一个跨库事务。Vendure port 必须按外部订单身份幂等；因此“Vendure 成功、账本提交失败”后的重试只能得到同一个 Vendure 订单。

## 接口

### 映射

`AccountMapping` 将 `(channel, accountId)` 映射到 Vendure channel。`SkuMapping` 将同一账号下的外部 SKU 映射到 Vendure ProductVariant。缺任一映射都是 `ACCOUNT_MAPPING_MISSING` 或 `SKU_MAPPING_MISSING`，且不调用 Vendure。

### 版本和状态

协调器不猜测 `externalVersion` 的语义，构造时必须注入 `compareExternalVersions(incoming, current)`。返回值小于、等于或大于零分别表示旧版本、同版本或新版本。相同版本不覆盖已成功订单。

允许的状态转换：

| 当前 | 允许的下一状态 |
|---|---|
| 无 | `created`、`paid`、`ready_to_ship`、`cancelled` |
| `created` | `created`、`paid`、`ready_to_ship`、`cancelled` |
| `paid` | `paid`、`ready_to_ship`、`shipped`、`cancelled`、`after_sales` |
| `ready_to_ship` | `ready_to_ship`、`shipped`、`cancelled`、`after_sales` |
| `shipped` | `shipped`、`delivered`、`after_sales` |
| `delivered` | `delivered`、`after_sales` |
| `cancelled` | `cancelled`、`after_sales` |
| `after_sales` | `after_sales` |

不允许的转换返回 `STATE_TRANSITION_DENIED`，不调用 Vendure。

### Vendure 端口

端口输入包含已验证命令、Vendure channel ID、每行 ProductVariant ID 和可选已有 Vendure order ID。端口返回 Vendure order ID、order code、状态、最小货币单位总额和已应用外部版本。协调器验证返回金额和版本后才标记任务成功。

## 错误分类

- `INVALID_INPUT`、`TOTAL_MISMATCH`：协议校验失败，终止失败；
- `ACCOUNT_MAPPING_MISSING`、`SKU_MAPPING_MISSING`、`STATE_TRANSITION_DENIED`：业务前置条件失败，终止失败；
- `COMMERCE_UNAVAILABLE`：Vendure 或依赖暂时不可用，可重试；
- `STALE_EVENT`：旧版本事件，不改变订单，不作为异常重试。

错误记录只保存错误码和短的非敏感诊断摘要，不保存客户地址、电话、token 或完整原始载荷。

## 验收

- 同一 `eventInboxId` 重复处理不产生第二次 Vendure 调用；
- 同一外部订单的新版本更新同一链接，旧版本不回退金额、状态或版本；
- 缺账号/SKU 映射和非法状态转换不调用 Vendure；
- Vendure 不可用标记 `retryable_failed`，可再次处理；
- Vendure 返回总额不等于协议总额时标记 `TOTAL_MISMATCH`；
- 所有测试只使用合成订单和内存存储。
