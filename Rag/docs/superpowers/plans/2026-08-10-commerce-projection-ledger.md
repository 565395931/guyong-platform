# Commerce Projection Ledger Implementation Plan

**Goal:** 在不启动数据库或 Vendure 的前提下，实现供应商无关的投影账本协调器、内存存储和 Vendure 端口契约。

**Architecture:** 新建 `commerce-projection-ledger` TypeScript 包，依赖本地 `@rag/commerce-protocol`。协调器负责校验、映射、幂等、版本/状态保护、端口错误分类和任务完成；存储和 Vendure 通过接口注入。

## Task 1: Scaffold and domain types

- [x] 创建精确依赖、TypeScript/Vitest 配置和 README。
- [x] 定义映射、任务、订单链接、端口输入/输出和错误类型。
- [x] 定义内存存储接口，确保持久化适配器可替换。

## Task 2: TDD projection coordinator

- [x] 先写失败测试：协议结构失败、账号/SKU 缺失、重复事件、旧版本和状态转换。
- [x] 实现 `projectExternalOrder` 的最小协调流程。
- [x] 增加 Vendure 端口返回金额不一致、暂时不可用和成功幂等测试。

## Task 3: TDD in-memory ledger

- [x] 实现 immutable-style 内存任务/映射存储。
- [x] 覆盖 retryable/terminal/succeeded 状态和安全错误摘要。
- [x] 验证输入和结果不共享可变引用。

## Task 4: Verification and docs

- [x] 运行完整测试、覆盖率、类型检查和构建。
- [x] 运行生产依赖审计和凭据扫描。
- [x] 更新主集成规格，明确阶段 2 离线完成项和 SQL/Vendure 适配器阻塞条件。
