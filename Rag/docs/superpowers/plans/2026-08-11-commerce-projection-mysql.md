# Commerce Projection MySQL Adapter Plan

## Task 1: Schema TDD

- [x] 写失败测试，要求四张表和关键唯一/领取索引。
- [x] 实现 `COMMERCE_PROJECTION_SCHEMA_STATEMENTS` 和 `ensureCommerceProjectionSchema`。
- [x] 保持 DDL 离线，不接入 Rag `connectDB`。

## Task 2: Repository TDD

- [x] 定义最小 `SqlExecutor`/transaction 接口。
- [x] 写失败测试覆盖创建、重复、领取、映射、失败和完成。
- [x] 实现参数化 `MySqlProjectionLedgerStore`。
- [x] 验证输出是冻结副本，错误不包含输入值。

## Task 3: Verification

- [x] 运行测试、覆盖率、类型检查和构建。
- [x] 运行生产依赖审计与凭据扫描。
- [x] 更新主规格，记录 SQL adapter 已离线验证、数据库迁移仍未执行。
