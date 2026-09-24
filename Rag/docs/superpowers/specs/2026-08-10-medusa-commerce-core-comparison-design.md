# Medusa 订单核心对照 PoC 设计

日期：2026-08-10

状态：已完成；Medusa 因依赖安全门槛和协议明细缺口被拒绝

## 目标

使用与 Vendure PoC 相同的外部订单命令，验证 Medusa `v2.18.0` 作为多平台订单、库存和履约底座的适配成本与安全状态。结果用于选择底座，不用于部署或接入真实平台。

## 约束

- 不修改现有 Rag、Vendure PoC 或业务数据库。
- 不创建 PostgreSQL 数据库，不运行迁移，不启动 Medusa 服务或 Admin。
- 不创建 `.env`，不保存真实凭据，不安装 Storefront。
- 仅使用合成订单夹具；构建或测试需要配置时只注入进程级合成值。
- 版本固定为精确版本，不使用浮动 `latest`。

## 方案比较

### 方案 A：完整 Medusa 后端骨架（采用）

使用官方脚手架的 `--skip-db` 和无浏览器模式生成独立后端。优点是依赖审计、构建链、Admin 和插件结构具有代表性；缺点是安装体积和时间较大，且没有 PostgreSQL 时无法执行端到端订单流。

### 方案 B：只安装 Commerce Modules

只安装 Order、Inventory 和 Fulfillment 模块并测试服务接口。安装更轻，但不能代表完整应用的依赖风险、配置复杂度和 Admin 成本，不适合作为 Vendure 的公平对照。

### 方案 C：继续等待 Vendure 修复

不增加代码和依赖，但当前 `6` 项高危生产依赖仍阻塞数据库和网络验证，无法形成新的决策证据。

## 架构

标准订单协议放在 `Rag/shared-protocol/commerce/`，以 JSON Schema 作为供应商无关的权威格式。Vendure 与 Medusa 适配器只能依赖该协议，不允许彼此引用源码。

Medusa 对照 PoC 放在 `Rag/commerce-core-medusa-poc/`，包含：

- 官方 Medusa 后端骨架和精确版本锁文件。
- JSON Schema 校验入口。
- `ExternalOrderProjectionCommand` 到 Medusa workflow 输入的纯函数映射。
- 错误分类和单元测试。
- 安全边界、审计结果和运行禁令。

数据流：

```text
Rag channel_event_inbox
        |
        | ExternalOrderProjectionCommand
        v
shared JSON Schema validation
        |
        | validated immutable command
        v
Medusa projection mapper
        |
        | order / reservation / fulfillment workflow inputs
        v
Medusa workflow execution（本轮不执行）
```

## 映射规则

- `channel + accountId` 映射为 Medusa Sales Channel，不自动创建未知渠道。
- `externalOrderId`、`externalVersion` 和 `rawPayloadRef` 保存在受控 metadata 字段，并由 Rag 映射表保证幂等。
- 金额继续以十进制定点字符串进入协议；Medusa `BigNumberInput` 原生接受字符串，适配器原样传递并使用 `BigInt` 缩放值校验合计，不使用浮点计算。
- 当前协议只有订单级折扣和税额，没有 Medusa 所需的行级 adjustment 与 tax rate 明细。零折扣、零税额可生成执行计划；非零值必须返回 `DISCOUNT_BREAKDOWN_REQUIRED` 或 `TAX_BREAKDOWN_REQUIRED`，待协议升级后再支持。
- 外部 SKU 必须先解析为 Medusa Product Variant 与 Inventory Item；缺少映射时整体失败，不创建半成品订单。
- 使用 `createOrderWorkflow` 时必须显式追加 reservation workflow；直接完成 cart 不是外部平台订单投影的默认路径。
- fulfillment 只能引用已创建的 reservation 和 order line，平台运单回写仍由 Rag 连接器负责。

## 错误处理

协议错误统一返回 `INVALID_INPUT`。适配错误至少区分 `CHANNEL_NOT_MAPPED`、`SKU_NOT_MAPPED`、`TOTAL_MISMATCH`、`DISCOUNT_BREAKDOWN_REQUIRED`、`TAX_BREAKDOWN_REQUIRED`、`STALE_EVENT` 和 `UNSUPPORTED_STATE`。纯函数不得记录客户姓名、电话、地址、token 或原始载荷。

任何依赖高危或严重漏洞、构建失败、协议字段丢失、金额精度丢失都会使 Medusa 判定为不可采用。不得使用 `npm audit fix --force` 掩盖结果。

## 测试

- JSON Schema：有效订单、超大外部订单号、非法币种、空订单行、非法金额和未知状态。
- 映射：渠道、SKU、金额、地址、metadata、库存预占和履约输入完整性。
- 不变性：验证输入不会被适配器修改，输出不可变。
- 安全：生产模式禁止、缺失密钥失败、常见凭据模式扫描无命中。
- 工程门槛：测试、80% 全局覆盖率、类型检查、构建和依赖审计。

## 决策标准

Medusa 只有同时满足以下条件才替代 Vendure：

1. 生产依赖高危和严重漏洞数低于 Vendure，且没有必须强制跨主版本修复的问题。
2. 标准订单字段全部可映射，库存预占和履约不需要绕过核心 workflow。
3. 定制代码不侵入 Medusa Core，升级路径可由自动化测试保护。
4. PostgreSQL、Redis 和运维新增成本可接受。

若两者都未通过安全门槛，继续保留供应商无关协议，暂停数据库集成，并重新评估 ERPNext 或等待上游修复。
