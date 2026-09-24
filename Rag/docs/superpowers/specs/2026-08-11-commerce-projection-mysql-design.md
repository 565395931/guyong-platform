# Commerce Projection MySQL Adapter Design

日期：2026-08-11

## 目标

为 `@rag/commerce-projection-ledger` 提供可由 Sequelize/MySQL 实现的参数化持久层，验证 DDL、任务原子领取、订单链接 upsert 和账号/SKU 映射查询。该阶段只使用假 SQL executor，不连接现有 Rag 数据库。

## 表结构

新增四张独立表：

- `commerce_account_mappings`：`(channel, account_id)` 到 Vendure Channel；
- `commerce_sku_mappings`：`(channel, account_id, external_sku)` 到 Vendure ProductVariant；
- `commerce_order_links`：外部订单复合身份到 Vendure order；
- `commerce_projection_jobs`：`event_inbox_id` 唯一的投影任务、状态、尝试次数、安全错误摘要和结果。

任务表不保存完整命令、客户、地址或平台 payload，只保存 `command_ref`、命令 ID、外部订单身份和版本。worker 重试时通过 `command_ref` 从受控事件层重新获取标准命令。生产实现必须为该读取路径配置保留期、授权和审计。

## 并发

新任务通过 `INSERT IGNORE` 原子创建为 `processing`、`attempts=1`。同一 `event_inbox_id` 的并发插入只有一个成功。重试任务通过条件 UPDATE 从 `pending/retryable_failed` 转为 `processing`；未更新任何行表示另一个 worker 已领取，协调器返回 duplicate，不调用 Vendure。

完成任务与订单链接 upsert 在同一个 Rag 数据库事务中执行。该事务不包含 Vendure；Vendure port 仍必须按外部订单身份幂等。

## 安全边界

- 所有动态值通过 Sequelize replacements 传入；表名、列名和状态集合是代码常量。
- 错误消息最长 500 字符且由协调器脱敏。
- 外部订单 ID、SKU 和版本在 SQL 边界再次验证长度。
- 不创建 `.env`，不读取数据库凭据，不执行 DDL。

## 验收

- DDL 包含四表、复合唯一键、任务唯一事件键和领取索引；
- repository 的所有输入只出现在 replacements，不拼接到 SQL；
- 任务创建、重复查询、条件领取、失败、完成和订单链接 upsert 都有测试；
- 假 executor 模拟 job ID 冲突时返回稳定 `INVALID_INPUT`；
- 生产依赖无高危/严重漏洞。
