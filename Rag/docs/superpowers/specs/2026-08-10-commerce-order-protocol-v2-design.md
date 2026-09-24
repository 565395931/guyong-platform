# 统一订单协议 v2 设计

日期：2026-08-10

## 目标

把外部平台订单转换为供应商无关、可审计、可验证的标准命令，完整表达行级折扣、税率、运费、币种精度和金额归属。协议不依赖 Vendure、Medusa 或具体平台 SDK，可用于事件入箱、重放、订单核心投影和费用核对。

## 范围

本阶段包含 JSON Schema v2、TypeScript 类型、运行时验证、金额不变量校验和 v1 到 v2 的安全迁移。暂不修改 Rag 数据库，不执行 Vendure 投影，不接入真实平台凭据。

## 方案

采用独立版本化协议包。v1 Schema 保持不变，v2 使用新文件和 `schemaVersion: 2`。调用方必须显式选择版本，禁止通过可选字段猜测版本。

未采用的方案：

- 原地替换 v1：会破坏已保存事件的重放和历史审计。
- 给 v1 增加可选字段：无法区分“平台没有折扣”与“适配器漏传折扣明细”。
- 在 Vendure 插件内定义 v2：会把 Rag 与未来底座绑定到 Vendure。

## 包边界

`Rag/shared-protocol/commerce/` 成为独立包，负责：

- 保存 v1 和 v2 JSON Schema。
- 导出 v1/v2 TypeScript 类型。
- 验证结构、币种精度和金额不变量。
- 将可安全升级的 v1 命令转换为 v2。

该包不负责数据库、SKU 映射、平台状态查询、库存、履约或日志记录。

## v2 数据模型

顶层标识和幂等字段沿用 v1。主要变化如下：

- `currency` 从三字母字符串改为 `{ code, exponent }`，避免 CNY、JPY 等币种精度被调用方猜测。
- `customer` 和 `shippingAddress` 使用白名单字段，禁止任意对象把原始平台载荷带入核心订单。
- 每个订单行包含 `unitAmount`、`grossAmount`、`discounts[]`、`taxes[]` 和 `totalAmount`。
- `shippingLines[]` 使用与商品行相同的毛额、折扣、税额和总额结构。
- 汇总金额拆成 `itemGross`、`itemDiscount`、`shippingGross`、`shippingDiscount`、`tax` 和 `total`。

折扣包含 `code`、`amount`、可选说明和资金承担方 `platform | seller | shared | unknown`。税包含 `code`、`rate`、`amount` 和 `includedInSourcePrice`；最后一个字段只描述平台原始展示方式，不改变规范化公式。

## 金额不变量

所有金额是非负十进制定点字符串，精度不能超过 `currency.exponent`。校验器使用字符串和 `BigInt` 缩放运算，不使用浮点数。

必须同时满足：

1. 行 `unitAmount × quantity = grossAmount`。
2. 行 `grossAmount - sum(discounts) + sum(taxes) = totalAmount`。
3. 运费行 `grossAmount - sum(discounts) + sum(taxes) = totalAmount`。
4. 汇总字段分别等于对应商品行和运费行的合计。
5. 订单 `itemGross - itemDiscount + shippingGross - shippingDiscount + tax = total`。

任何不一致统一返回 `TOTAL_MISMATCH`，错误不得包含客户信息或原始载荷。

## v1 迁移

v1 只有订单级折扣和税额，无法可靠分配到商品行或运费行。因此迁移规则是：

- v1 折扣和税额都为零时，可以自动升级。
- 非零折扣或税额返回 `BREAKDOWN_REQUIRED`，由平台适配器重新拉取或补充明细。
- 调用方必须提供币种到 exponent 的白名单映射；缺失时返回 `CURRENCY_EXPONENT_REQUIRED`。
- v1 行金额、商品合计或订单总额不一致时返回 `TOTAL_MISMATCH`。
- 非零 v1 运费转换为一条 `external-platform` 运费行。
- 迁移结果必须再次通过 v2 完整校验后才能返回。

不允许按比例自动分摊历史折扣或税额，因为四舍五入规则、平台承担方和税基可能不同。

## 错误分类

- `INVALID_INPUT`：Schema 或基础字段不合法。
- `TOTAL_MISMATCH`：任一金额不变量不成立。
- `BREAKDOWN_REQUIRED`：v1 存在无法安全分配的折扣或税额。
- `CURRENCY_EXPONENT_REQUIRED`：缺少币种精度映射。

返回对象必须是深度冻结的副本，验证和迁移不得修改调用方输入。

## 测试与验收

- 有效 v2：商品折扣、平台承担折扣、税率、运费折扣和税额全部通过。
- 结构失败：未知字段、数值型外部订单号、负金额、空订单行和非法币种被拒绝。
- 金额失败：行毛额、折扣、税、运费和订单汇总分别制造 0.01 差异时被拒绝。
- 迁移成功：零折扣、零税额 v1 生成确定性 v2，并保持输入不变。
- 迁移失败：非零折扣/税额、未知币种精度和 v1 金额不一致返回稳定错误码。
- 工程门槛：测试通过；语句、分支、函数和行覆盖率均不少于 80%；类型检查和构建通过；依赖无高危或严重漏洞。

