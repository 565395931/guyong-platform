# @rag/commerce-protocol

供应商无关的外部订单命令协议。该包只负责 JSON Schema、TypeScript 类型、运行时校验和安全的 v1 到 v2 迁移，不依赖数据库、Vendure、Medusa 或平台 SDK。

## 公共 API

```ts
import {
  migrateExternalOrderCommandV1,
  validateExternalOrderCommandV2,
  type ExternalOrderProjectionCommandV2,
} from '@rag/commerce-protocol'

const command = validateExternalOrderCommandV2(untrustedInput)

const migrated = migrateExternalOrderCommandV1(legacyInput, {
  CNY: 2,
  JPY: 0,
  USD: 2,
})
```

两个函数都返回与输入分离、递归冻结的 v2 对象。错误只包含错误码和字段路径，不回显订单、客户或原始平台载荷。

## 协议版本

- v1 Schema 保留在 `external-order-projection-command.schema.json`，用于历史事件验证和受控迁移。
- v2 Schema 位于 `external-order-projection-command.v2.schema.json`，新增显式币种精度、行级折扣、行级税、运费行和结构化客户/地址字段。
- 调用方必须使用 `schemaVersion` 显式选择版本，不能根据可选字段猜测。

所有金额均为非负十进制定点字符串。校验器用字符串和 `BigInt` 运算，不使用浮点数。金额最长 64 个字符，精度不能超过 `currency.exponent`。

## 金额不变量

每条有效命令必须同时满足：

1. 商品行 `unitAmount * quantity = grossAmount`。
2. 商品行 `grossAmount - sum(discounts) + sum(taxes) = totalAmount`。
3. 运费行 `grossAmount - sum(discounts) + sum(taxes) = totalAmount`。
4. 订单汇总分别等于商品行、运费行、折扣和税的合计。
5. `itemGross - itemDiscount + shippingGross - shippingDiscount + tax = total`。

任一不变量失败返回 `TOTAL_MISMATCH`。Schema、币种精度或白名单字段失败返回 `INVALID_INPUT`。

## v1 迁移规则

v1 只有订单级折扣和税，无法证明它们应该落在哪个商品行或运费行。因此只有折扣和税均为零、且所有金额可对账时允许自动迁移。

- 非零折扣或税：`BREAKDOWN_REQUIRED`，平台适配器必须重新拉取或补齐行级明细。
- 币种不在调用方传入的精度映射中：`CURRENCY_EXPONENT_REQUIRED`。
- v1 行金额、商品合计或订单总额不一致：`TOTAL_MISMATCH`。
- 非零运费：生成一条确定性的 `external-platform` 运费行。
- 未知客户/地址字段：不迁移；已知字段类型错误：拒绝迁移。

迁移器不做比例分摊，也不猜测税率、折扣承担方或币种精度。

## 验证命令

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run audit:production
```
