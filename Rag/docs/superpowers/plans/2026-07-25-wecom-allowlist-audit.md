# 企业微信测试白名单与操作审计实施计划

**日期：** 2026-07-25  
**范围：** `rag-server`、`platform-web`；复用现有 `wehook` 运行时配置协议，不连接真实企业微信。

## 目标

在现有企业连接与客服账号管理基础上，完成三个可安全验收的后台能力：

1. 管理非生产基线测试账号的外部联系人白名单。
2. 在修改运行中配置前，先同步停用网关快照，避免数据库与网关状态不一致。
3. 查询连接、账号策略、白名单和运行时发布/停用的操作日志。

`客服1号`（`locked_reason=production_baseline`）始终拒绝白名单及保护策略变更。本阶段不发送真实消息，不修改企业微信后台配置。

## 安全约束

- 白名单只允许 `protection_level=test`、非生产基线账号维护。
- 连接处于 `active` 时拒绝白名单增删；管理员必须先调用停用接口，并等待网关返回 `gateway.config.applied`。
- 停用成功后才把 MySQL 连接状态改为 `disabled`；失败时保留原状态并记录健康错误。
- 停用使用递增 `config_version` 和 `status=disabled`，不得只修改数据库状态。
- 删除白名单采用软停用；再次添加同一外部联系人时恢复原条目。
- 列表和日志不返回企业凭据、完整 CorpID、回调密钥或消息正文。
- 白名单写操作允许 `admin`、`supervisor`；停用运行时只允许 `admin`；日志查询允许两者。

## 实施步骤

### 1. 后端契约测试

- 为白名单输入规范化、长度限制和必填校验添加测试。
- 为仓库的列表、恢复式 upsert、软停用和分页日志查询添加 SQL 合同测试。
- 为服务保护条件添加测试：账号不存在、生产基线、非测试模式、连接运行中均拒绝。
- 为停用快照发布、确认后落库、失败保持 active 添加测试。
- 为路由、角色权限和错误码添加测试。

### 2. 后端实现

- 扩展 `runtimeConfigPublisher`，统一发布 `active/disabled` 两种快照。
- 扩展 repository：白名单 CRUD、连接状态读取、审计分页查询。
- 扩展 service：白名单业务保护、脱敏映射、运行时停用、审计查询。
- 新增接口：
  - `POST /api/v1/platform-connections/:id/disable-runtime`
  - `GET /api/v1/platform-connections/accounts/:accountId/allowlist`
  - `POST /api/v1/platform-connections/accounts/:accountId/allowlist`
  - `DELETE /api/v1/platform-connections/accounts/:accountId/allowlist/:entryId`
  - `GET /api/v1/platform-connections/operation-logs`

### 3. 前端测试与实现

- 扩展纯函数测试：白名单表单、可维护条件、可停用条件、日志筛选参数。
- 在连接表加入“停用网关”命令和二次确认。
- 在客服账号表加入白名单管理入口，只对安全测试账号开放。
- 新增白名单抽屉：列表、添加、软停用；运行中连接明确提示先停用。
- 新增操作日志区：按连接、账号、动作筛选并分页显示。

### 4. 验证

- 运行 `rag-server` 平台连接模块全部测试。
- 运行 `platform-web` 平台连接与导航测试，并执行生产构建。
- 运行 `wehook` 全量测试，确认禁用快照协议兼容。
- 重启本地后端；仅在共享临时运行时密钥可安全复用时重启网关。
- 用浏览器在桌面和窄屏检查账号页，不触发真实验证、发布、停用或发送。
- 更新 `wehook/memory/2026-07-25.md`；若 `Rag` 没有项目规则要求的记忆目录，则只更新本计划与相关运维文档。
