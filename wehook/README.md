# Cloud Channel Gateway

计划部署到云服务器的多渠道接入网关，用于连接各平台公网回调/长连接与本地 `D:\project\Rag\rag-server`。

## 核心职责

- 平台回调、长连接、验签、解密和 OAuth/token。
- 账号密钥加密保存和平台消息标准化。
- 通过可靠 WebSocket 与本地 Rag 通信。
- 缓存、重试、ACK、重放、发送结果和送达状态处理。

## 非职责

不管理会话池、坐席、AI/RAG 或客服前端推送。这些能力属于 `D:\project\Rag`。

## Codex 上下文

- `AGENTS.md`：Codex 操作与跨项目查询入口。
- `PROJECT_RULES.md`：云网关强制架构规则。
- `memory/MEMORY.md`：稳定决策和跨项目背景。
- `docs/README.md`：专题文档按需读取索引。

## 第一阶段 Mock 闭环

当前代码提供：协议 envelope 校验、认证 WSS Server、心跳、持久化 Event Store/Outbox、ACK、重试/重放、死信、`commandId` 幂等、Mock Provider、结构化日志和健康检查。

入站闭环已经实现：云网关先持久化 `channel.message.inbound` 再推送 Rag；Rag 调用现有 `messagingService.processIncomingMessage()` 后返回带 `ackForEventId` 的应用级 ACK。该链路已通过临时真实 WebSocket Mock 测试，完整 Rag + MySQL 联调仍待执行。

安装依赖后可启动：

```powershell
npm install
$env:GATEWAY_AUTH_TOKEN='replace-with-a-service-token'
node src/index.js
```

Windows 本地开发可直接双击仓库根目录的 `start-gateway.cmd`（内部调用同目录 `start-gateway.ps1`）。脚本会：

- 自动切换到项目目录并查找 Node.js。
- 检查 `ws` 依赖和 `8787/8788` 端口占用。
- 首次启动时生成 `data/gateway-auth-token.txt`，该目录已被 Git 忽略。
- 在当前窗口以前台方式启动云网关；关闭窗口或按 `Ctrl+C` 会停止服务。

脚本只启动云网关的 WebSocket（默认 `8787`）和健康/指标 HTTP（默认 `8788`），不会启动 Rag 后端 `3001`。需要自定义端口或 Node 路径时，将 `gateway.local.cmd.example` 复制为 `gateway.local.cmd` 后修改。

- WSS/WS 默认监听 `127.0.0.1:8787`；生产部署应由反向代理终止 TLS，或改为证书化 WSS Server。
- 健康检查默认监听 `127.0.0.1:8788/healthz`，Prometheus 文本指标位于 `/metrics`。
- Mock 持久化文件默认位于 `data/gateway-store.json`，不连接 Rag MySQL，也不调用任何真实平台。
- 该 JSON Store 是第一阶段单进程 Mock/联调实现；生产多实例部署前必须替换为带唯一约束和事务的共享数据库 Event Store。
- 设置 `GATEWAY_STORE_DRIVER=mysql` 可启用 MySQL Event Store；本地可与 Rag 共用 MySQL 实例，但必须使用独立的 `cloud_channel_gateway` 数据库。初始化和手动测试见 `docs/mysql-event-store.md`。
- 非生产环境可通过 `POST http://127.0.0.1:8788/mock/inbound` 手动注入入站事件；接口需要 Bearer token，生产环境固定关闭。
- 同机本地联调时 Rag 后端会自动读取 `data/gateway-auth-token.txt`，无需把明文 token 写入 Rag `.env`；生产环境仍必须使用密钥环境变量或受控 token 文件。
- Rag 3002 测试工具通过 3001 代理提交结构化消息，可配置消息类型、`content` JSON 和稳定 ID；浏览器不会读取网关 token。
- 未接入真实平台时可在测试工具按渠道创建专用 `cloud_gateway_mock` 账号；Rag 自动生成本地 ID 和 Mock 映射，不需要把账号 ID 写入 `.env`，也不会启动 WAHA。
- 一次性测试：`npm test`。
- 真实本机 WebSocket 一次性联调：`node --test test/local-link.integration.test.js`；完整步骤见 `docs/local-link-testing.md`。

Rag 侧通过 `CLOUD_GATEWAY_ENABLED=true` 显式启用连接；未启用时统一 dispatcher 继续调用原有 WAHA 适配器，不改变 WAHA/GOWS 链路。
