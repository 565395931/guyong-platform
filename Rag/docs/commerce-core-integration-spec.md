# 多平台订单核心开源底座选型与 PoC 规格

状态：阶段 1 骨架、统一订单协议 v2、阶段 2 离线投影账本及 MySQL adapter 已完成；仅限离线合成数据 PoC，生产采用被依赖安全审计阻塞  
更新时间：2026-08-10  
目标底座：Vendure `v3.7.2`

## 问题与目标

当前平台订单事件已经能够进入 `channel_event_inbox`，但事件不会自动形成统一订单、库存预占和履约记录。现有 `orders` 主要承载人工订单及会话转订单，缺少外部订单幂等映射、SKU 库存、电子面单和平台状态回写闭环。

本次工作选择一个开源电商核心作为订单、库存和履约底座，并定义一个可验证的 PoC。PoC 完成后再决定是否进入生产改造和全平台连接器建设。

## 选型结论：Vendure 通过插件接入

PoC 条件性使用 Vendure `v3.7.2`。集成代码放在独立插件和 Rag 适配层中，不修改 Vendure Core。该版本仅用于验证订单契约和集成边界，不得对外暴露、接入真实平台凭据或处理真实订单数据。

| 候选 | 本地审计证据 | 结论 |
|---|---|---|
| Vendure | Node.js、TypeScript、NestJS、GraphQL；内置 Order、OrderLine、Channel、StockLocation、StockLevel、Fulfillment、ShippingMethod；支持 MySQL；GPLv3 提供独立插件许可例外 | 选为 PoC 底座 |
| Medusa `v2.18.0` | Node.js/TypeScript、MIT；订单和库存模块完整；数据库实现深度绑定 PostgreSQL；对照 PoC 的生产依赖审计有 15 项高危 | 排除当前版本，不作为 Vendure 替代底座 |
| ERPNext `v16.31.1` | 销售订单、采购、仓库、发货和财务功能完整；Python/Frappe；GPLv3 | 保留为重 ERP 场景备选 |
| Qihang ERP | MIT；存在淘宝、拼多多、抖音、快手、小红书相关目录；最后提交日期为 2024-03-26 | 排除：部分连接器整文件被注释，包含旧 SDK、硬编码测试凭据和默认密钥，维护与安全风险不可接受 |

版本规则：PoC 固定精确版本，不跟随 `latest`。升级必须经过迁移测试、插件兼容测试和回滚演练。

### 当前安全门槛

2026-08-10 对修复后的锁定依赖执行 `npm audit --omit=dev --audit-level=high`，依赖树仍报告 `13` 项：`1` 项低危、`6` 项中危、`6` 项高危、`0` 项严重。高危路径包括 Vendure Core 或 Asset Server Plugin 带入的图片解析、WebSocket 和相关传递依赖。npm 给出的高危自动修复方案会跨主版本降级 Vendure，不能采用。直接开发依赖升级前的完整审计为 `16` 项，其中 `2` 项严重；升级到 Vite `7.3.6`、Vitest 及 coverage-v8 `3.2.7` 后，严重漏洞已清零。

处理原则：

- 开发工具链使用同主版本修复版，并重新执行测试、覆盖率、类型检查和构建。
- 不使用 `npm audit fix --force`，不盲目覆盖 Vendure 的传递依赖。
- 未达到生产依赖高危和严重漏洞数为 `0`，或未完成逐项风险接受前，禁止启动网络服务、连接真实数据库、配置真实凭据和部署。
- 如果 Vendure 上游在评审期限内没有兼容修复，使用同一订单契约和测试夹具切换评估 Medusa。

### Medusa 对照结果

2026-08-10 使用精确版本 `2.18.0` 建立了隔离 Medusa 后端和供应商无关 JSON Schema。官方脚手架因 GitHub 网络不可达无法克隆 starter，因此骨架按官方兼容 starter 的公开结构创建，所有执行依赖仍来自 npm 官方发布包，未使用第三方镜像。

验证结果：

- 统一命令校验、Medusa 订单输入和库存预占模板共 `24` 个测试通过。
- 全局语句覆盖率 `99%`、分支覆盖率 `86.15%`、函数覆盖率 `100%`、行覆盖率 `99%`。
- TypeScript 类型检查、Medusa backend 和 Admin 完整构建通过；未创建 `.env`、数据库或网络监听服务。
- `npm audit --omit=dev --audit-level=high` 报告 `78` 项：`63` 项中危、`15` 项高危、`0` 项严重。高危路径包括 Medusa CLI、Framework、Vite、Lodash 和 GraphQL codegen，建议修复包含破坏性 Medusa 降级。
- Medusa `BigNumberInput` 可直接接受十进制字符串，金额不需要经过浮点数；但协议 v1 缺少 Medusa 所需的行级折扣 adjustment 和 tax rate 明细，非零折扣或税额不能无损投影。

结论：不采用 Medusa 替代 Vendure。Vendure 依赖树的高危数量较少，且现有 MySQL 运维契合度更高，但仍保持“仅离线 PoC、禁止部署”。统一订单协议 v2、投影账本协调层和参数化 MySQL adapter 已完成离线验证，下一步实现 Vendure 插件端口和 worker 装配，并持续监控 Vendure 上游兼容修复；在安全门槛解除前不执行 DDL、不创建数据库或真实平台连接。

## 范围

本次 PoC 包含：

- 独立 Vendure 开发实例和独立数据库。
- 一个已经进入 `channel_event_inbox` 的订单事件投影到 Vendure。
- 平台账号到 Vendure Channel 的映射。
- 外部 SKU 到 Vendure ProductVariant 的显式映射。
- 外部订单、订单行、地址、金额和状态的幂等写入。
- 库存预占、模拟履约、模拟运单号和 Rag 侧查询投影。
- 重复事件、乱序事件、缺少 SKU、金额不一致和 Vendure 不可用的自动化测试。

本次 PoC 不包含：

- 真实平台 OAuth、正式店铺授权和生产回调。
- 真实申通或其他承运商电子面单申请。
- 全量历史订单迁移。
- 快手、视频号、小红书和海外平台的真实连接器上线。
- platform-web 全面重写。
- 多租户计费、订阅和 AI credits 结算。

## 系统边界

```text
电商平台 / 消息渠道
        |
        | webhook / pull / confirmed AI draft
        v
Rag channel adapters
        |
        | write raw normalized event
        v
channel_event_inbox ---- duplicate event ----> return existing result
        |
        | create durable projection job
        v
commerce projection worker
        |\
        | \-- missing account/SKU mapping --> terminal failure + operator action
        |
        | projectExternalOrder
        v
Vendure integration plugin
        |
        | one database transaction
        v
Order + OrderLine + Stock + Fulfillment
        |
        | result/event
        v
Rag order facade + legacy orders projection
        |
        | later phase
        v
carrier adapter / platform shipment write-back
```

保持不变的模块：

- `wehook` 继续负责企业微信等消息网关能力。
- Rag 会话、客服、AI 路由和客户身份继续由现有模块负责。
- `channel_event_inbox` 继续保存原始标准化事件并负责第一层去重。
- platform-web 在 PoC 阶段继续调用 Rag API。

## 数据所有权

| 数据 | 权威来源 | 其他副本 |
|---|---|---|
| 平台原始事件及接收结果 | Rag `channel_event_inbox` | 日志只能保存脱敏摘要 |
| 客服会话、AI 识别草稿、人工确认 | Rag | Vendure 只接收确认后的订单数据 |
| 标准订单、订单行、库存、履约 | Vendure | Rag `orders` 在迁移期是只读投影 |
| 平台外部订单状态 | 对应电商平台 | Vendure 保存最近一次成功同步状态 |
| 外部订单与 Vendure ID 映射 | Rag `commerce_order_links` | 无可重建副本 |
| 承运商报价和最终账单 | 后续物流模块 | 订单只保存选中报价和结算引用 |

迁移期间发生冲突时，Vendure 的订单、库存和履约状态胜出。平台状态变化只能通过事件投影或受审计的人工命令进入 Vendure。

## 核心决策

1. **使用独立 Vendure 应用和插件。** Rag 通过受认证的内部接口调用插件。反转条件：PoC 无法精确保留平台订单金额或无法满足幂等要求。
2. **Vendure 与 Rag 使用同一 MySQL 服务的不同数据库。** 两个服务不跨库写事务，通过持久化投影任务实现最终一致。反转条件：生产容量评估要求独立数据库实例。
3. **每个平台店铺账号映射一个 Vendure Channel。** Channel 承载币种、库存、价格和店铺隔离。反转条件：验证发现一个平台账号需要跨多个独立价格或库存域。
4. **未知 SKU 阻断订单投影。** 系统创建可操作的失败记录，Vendure 中不创建不完整订单。运营人员补齐映射后重放同一任务。
5. **外部金额原样保留到最小货币单位。** PoC 必须验证商品、折扣、运费和订单总额逐分一致；禁止用浮点数计算金额。
6. **已有 `orders` 逐步降级为查询投影。** PoC 不删除该表；新外部订单的独立状态写入在切换阶段关闭。
7. **插件与 Core 分离发布。** 插件目录不得复制或修改 Vendure Core 源码。生产商业模式上线前完成 GPLv3 和插件例外的法律审查。

## 运行流程

### 外部订单投影

```text
1. adapter 写入 channel_event_inbox
   |-- 同一 channel/account/external_event_id 已存在
   |     `-- 返回已有事件，不创建第二个任务
   `-- 新事件
         v
2. 创建 commerce_projection_jobs
         v
3. worker 原子领取任务
         v
4. 校验账号映射、订单标识、币种、地址和所有 SKU
   |-- 契约错误 --> terminal_failed，记录错误码，不写 Vendure
   `-- 临时依赖错误 --> retryable_failed，按退避时间重试
         v
5. 调用 Vendure plugin: projectExternalOrder
         v
6. 插件按 external order identity 查询
   |-- 不存在 --> 创建草稿订单、订单行和外部引用
   `-- 已存在 --> 仅应用更新版本更高的字段和状态
         v
7. Vendure 提交事务并返回 order id/state/totals
         v
8. Rag 更新 commerce_order_links 和 orders 查询投影
         v
9. projection job = succeeded
```

跨系统写入顺序固定为：先保存原始事件，再保存投影意图，再写 Vendure，最后更新 Rag 映射和查询投影。步骤 8 失败时重试查询投影，禁止重复创建 Vendure 订单。

### 会话转订单

```text
消息会话 --> AI 提取草稿 --> 人工确认
                              |
                              v
                   写入标准 projection command
                              |
                              v
                   复用外部订单投影流程
```

AI 未通过人工确认时，不创建 Vendure 订单，不预占库存。

## 接口契约

### `ExternalOrderProjectionCommand` v2

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `commandId` | UUID string | 是 | 投影命令幂等键 |
| `eventInboxId` | integer/string | 是 | 对应 `channel_event_inbox.id` |
| `schemaVersion` | integer | 是 | v2 固定为 `2`；v1 只用于历史事件迁移 |
| `channel` | string | 是 | 标准渠道编码 |
| `accountId` | integer | 是 | Rag 平台账号 ID |
| `externalOrderId` | string | 是 | 全程按字符串处理 |
| `externalVersion` | string | 是 | 平台更新时间或版本号 |
| `occurredAt` | RFC 3339 timestamp | 是 | 平台事件发生时间 |
| `currency` | object | 是 | `{ code, exponent }`；调用方显式给出币种精度 |
| `customer` | object | 是 | 仅允许外部客户 ID、姓名、邮箱和电话白名单字段 |
| `shippingAddress` | object | 条件必填 | 结构化白名单字段；需要实物履约时必填 |
| `lines` | array | 是 | 至少一行；含单价、毛额、行级折扣、行级税和行总额 |
| `shippingLines` | array | 是 | 运费毛额、折扣、税和总额；无运费时为空数组 |
| `amounts` | object | 是 | 商品毛额/折扣、运费毛额/折扣、税和总额，均为十进制字符串 |
| `normalizedStatus` | enum | 是 | `created/paid/ready_to_ship/shipped/delivered/cancelled/after_sales` |
| `rawPayloadRef` | string | 是 | 指向 inbox 记录，禁止再次复制完整敏感载荷 |

协议实现位于 `shared-protocol/commerce`。结构通过 Draft 2020-12 JSON Schema 校验，金额使用字符串和 `BigInt` 缩放运算，禁止浮点计算。v1 仅在订单级折扣和税均为零、行金额及汇总完全一致、调用方提供币种精度映射时迁移；否则分别返回 `BREAKDOWN_REQUIRED`、`TOTAL_MISMATCH` 或 `CURRENCY_EXPONENT_REQUIRED`，不进行比例分摊。

### Vendure 插件入口

```text
projectExternalOrder(input: ExternalOrderProjectionInput)

success -> {
  commandId,
  vendureOrderId,
  orderCode,
  state,
  totalWithTaxMinor,
  appliedExternalVersion
}

error INVALID_INPUT          -> 输入缺字段或格式错误，终止重试
error ACCOUNT_MAPPING_MISSING -> 店铺未映射 Vendure Channel，终止重试
error SKU_MAPPING_MISSING     -> 至少一个 SKU 未映射，终止重试
error STALE_EVENT             -> 事件版本较旧，返回现有订单且不修改
error TOTAL_MISMATCH          -> Vendure 计算金额与平台金额不一致，终止重试
error STATE_TRANSITION_DENIED -> 状态转换不合法，终止重试
error COMMERCE_UNAVAILABLE    -> Vendure 或数据库临时不可用，可以重试
```

内部接口必须使用服务身份认证和网络访问控制。错误响应不得包含平台 token、App Secret、客户完整地址或完整手机号。

## 持久化契约

### `commerce_order_links`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | UUID | 主键 |
| `channel` | varchar(30) | 非空 |
| `account_id` | int | 非空 |
| `external_order_id` | varchar(160) | 非空 |
| `vendure_order_id` | varchar(64) | 非空 |
| `legacy_order_id` | varchar(36) | 可空 |
| `external_version` | varchar(100) | 非空 |
| `last_event_inbox_id` | bigint | 非空 |
| `sync_status` | enum | `active/cancelled/after_sales/error` |
| `last_error_code` | varchar(80) | 可空 |
| `created_at` / `updated_at` | datetime | 非空 |

唯一约束：`(channel, account_id, external_order_id)`。映射记录禁止硬删除；测试环境清理时按整套 PoC 数据库销毁。

### `commerce_projection_jobs`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | UUID | 主键 |
| `event_inbox_id` | bigint | 唯一、非空 |
| `command_json` | JSON | 非空、已脱敏 |
| `status` | enum | `pending/processing/retryable_failed/terminal_failed/succeeded` |
| `attempts` | int | 默认 `0` |
| `next_attempt_at` | datetime | 可空 |
| `locked_at` | datetime | 可空 |
| `last_error_code` | varchar(80) | 可空 |
| `last_error` | varchar(500) | 可空、禁止敏感数据 |
| `created_at` / `updated_at` | datetime | 非空 |

任务记录在 PoC 期间保留。生产保留周期和客户删除策略必须在上线评审中确定；该决策未完成时禁止生产发布。

## 失败场景与验收

| 能力 | 失败示例 | 预期结果 | 完成信号 |
|---|---|---|---|
| 事件幂等 | 同一事件并发投递 10 次 | 只创建一个投影任务和一个 Vendure 订单 | 重复订单数 = `0` |
| 外部订单幂等 | 不同事件更新同一外部订单 | 更新同一个 Vendure 订单 | 同一外部订单映射数 = `1` |
| 乱序保护 | 旧版本事件晚于新版本到达 | 返回 `STALE_EVENT`，不回退状态和金额 | 状态回退次数 = `0` |
| SKU 完整性 | 一行 SKU 未映射 | 任务终止，Vendure 无半成品订单 | 不完整订单数 = `0` |
| 金额一致性 | 折扣或运费导致总额差 0.01 | 返回 `TOTAL_MISMATCH` | 成功订单金额差异 = `0` |
| 库存预占 | 两个订单竞争最后一件库存 | 只有一个订单成功预占 | 超卖数量 = `0` |
| 非法状态转换 | 已取消订单收到已发货事件 | 返回明确错误并保留原状态 | 未授权转换数 = `0` |
| 故障恢复 | Vendure 成功后 Rag 投影写入失败 | 重试只补写投影 | 重试新增 Vendure 订单数 = `0` |
| 敏感信息 | 错误日志和接口响应 | 不出现 secret、token、完整地址和完整手机号 | 敏感信息扫描命中数 = `0` |
| 模拟履约 | 订单生成模拟运单号 | Vendure fulfillment 和 Rag 查询结果一致 | 端到端测试全部通过 |

## 实施阶段

### 阶段 0：安全和许可证门槛（部分完成，生产阻塞）

包含：确认 Vendure 插件例外边界；记录精确版本；检查现有仓库凭据；排除 Qihang 代码直接合并。  
当前结果：许可证和版本结论已有记录，PoC 配置文件常见密钥模式扫描命中数为 `0`；依赖审计仍有 `6` 项高危。  
阻塞关系：允许在隔离目录安装依赖并执行合成数据测试；不得启动网络服务、连接真实数据或部署。

### 阶段 1：隔离底座（骨架完成，运行验证待安全解锁）

包含：创建独立 Vendure 应用、独立 MySQL 数据库、环境变量模板和健康检查。  
当前结果：固定版本应用骨架、环境变量模板、订单输入契约和配置校验已完成；未配置密钥时启动明确失败，`APP_ENV=production` 被代码拒绝。未创建或迁移数据库，也未启动服务。  
完成信号：依赖安全门槛解除后，使用专用数据库完成迁移、健康检查和本机回环地址启动验证。

### 阶段 1.5：统一订单协议 v2（完成）

包含：供应商无关的 v1/v2 Schema、TypeScript 类型、运行时金额不变量校验、结构化客户/地址白名单和 v1 安全迁移。  
当前结果：`32` 个测试通过；总体语句覆盖率 `97.74%`、分支覆盖率 `84.61%`；类型检查、构建和生产依赖审计通过。协议包不连接数据库、不读取平台凭据、不启动网络服务。  
完成信号：所有金额逐最小货币单位一致；含非零订单级折扣或税的 v1 数据被明确拒绝并要求平台适配器补齐明细。

### 阶段 2：插件和投影账本（离线协调层完成，外部适配器阻塞）

包含：先写契约测试，再实现供应商无关协调器、任务/订单映射存储接口、账号/SKU 映射解析、版本和状态保护、Vendure 端口契约和错误分类。  
当前结果：`@rag/commerce-projection-ledger` 使用内存存储和假 SQL executor 完成 `40` 个合成测试；包级语句覆盖率 `97.59%`、分支覆盖率 `91.21%`。已验证 10 路并发重复事件只调用一次 Vendure、条件领取、订单链接事务 upsert、账号/SKU 参数化查询、旧版本、非法状态、可重试故障和敏感错误摘要。MySQL store 自身语句覆盖率 `99.29%`、分支覆盖率 `89.53%`。  
未完成项：真实 worker、Vendure 插件和数据库迁移执行。依赖安全门槛解除前禁止启动这些外部适配器或对现有数据库执行 DDL。

### 阶段 3：端到端 PoC

包含：使用脱敏订单夹具完成事件入箱、订单投影、库存预占、模拟履约和 Rag 查询。  
完成信号：本文件验收表全部满足，重复订单、超卖、非法转换和敏感信息泄露计数均为 `0`。

### 阶段 4：生产采用评审

包含：容量、备份恢复、保留策略、GPL 法律审查、升级策略和连接器路线图。  
完成信号：形成采用或放弃 Vendure 的明确决定；放弃时使用同一测试夹具评估 Medusa。

## 审计来源

- Vendure 仓库：<https://github.com/vendurehq/vendure>
- Vendure `v3.7.2`：<https://github.com/vendurehq/vendure/releases/tag/v3.7.2>
- Medusa 仓库：<https://github.com/medusajs/medusa>
- ERPNext 仓库：<https://github.com/frappe/erpnext>
- Qihang ERP 仓库：<https://gitee.com/muxh/qihang.ecom.erp>
- 当前 Rag 事件表：`rag-server/src/modules/channel-events/channelEventInbox.schema.js`
- 当前 Rag 订单表：`rag-server/src/config/database.js`
- 当前 Rag 平台适配器：`rag-server/src/modules/channel-adapters/`

## 2026-08-11 enterprise execution update

- The Rag-side durable worker, MySQL store, retry backoff, lease recovery, terminal dead-letter
  state, signed HTTPS port, inbox dispatcher, administrator job API, and replay audit log are
  implemented.
- `channel_event_inbox.payload_json.projectionCommand` v2 is the only dispatchable command source.
  Raw platform payloads remain stored for evidence but are not heuristically converted into order
  amounts or statuses.
- Rag production dependencies now report 0 known advisories. Mongoose was upgraded from 6.13.9
  to the patched same-major release 6.13.10 and the affected test set was rerun.
- Vendure 3.7.2 remains blocked from production: after moving Asset Server, Dashboard, GraphiQL,
  and development email tooling out of production dependencies, its runtime audit still reports
  four high advisories in Vendure Core and transitive image/WebSocket utility packages.
- `APP_ENV=production` remains rejected by the Vendure PoC. The vendor-neutral signed HTTP boundary
  allows a patched Vendure release or another approved commerce engine to be introduced without
  changing the Rag order protocol or ledger.
- No Vendure service, real commerce callback, or production credential was started or configured in
  this implementation session. Rag schema creation is wired into its existing startup migration;
  it was verified with fake SQL executors and not executed against the existing local MySQL service.

## 2026-08-12 warehouse MVP update

Rag now has a transactional warehouse module alongside the existing order and channel modules. It
owns warehouse master data, on-hand/reserved inventory, reservation transitions, and an immutable
inventory ledger. Stock mutations use idempotency keys and the MySQL repository uses transaction
callbacks plus `FOR UPDATE` reads for inventory and reservation transitions. The module is mounted
at `/api/v1/warehouses` and the enterprise frontend exposes `/warehouses`.

The warehouse MVP is a usable foundation, not a complete commercial WMS. Real MySQL migration and
concurrency verification, platform SKU mapping, procurement/transfers/cycle counts, batch/serial
tracking, carrier labels, and fulfillment/shipment write-back remain production gates.

## 2026-08-12 connector projection update

- A shared conservative order mapper now validates protocol v2 commands at the adapter boundary.
  It requires explicit line gross/net amounts, discount and tax allocations, shipping breakdown,
  currency precision, normalized status, and order total. Missing data stays raw-only; conflicting
  monetary data fails closed.
- Pinduoduo order-number increments are hydrated through `pdd.order.information.get` before
  normalization, with strict order identity checks and no cursor advance after detail failure.
- Taobao, Pinduoduo, and 1688 clients preserve decimal values and unsafe integer identifiers as
  exact strings. Safe integers remain numbers for pagination and status fields.
- The shared boundary is wired into Taobao, Pinduoduo, 1688, Douyin, Xiaohongshu, WeChat Shop, and
  Kuaishou adapters. Platform-specific raw-field mappers and official production authorization are
  still required; see `docs/commerce-channel-capability-matrix.md` for the non-marketing status.
