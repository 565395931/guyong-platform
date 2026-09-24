# 重构基线：2026-09-23

本文件记录“逐系统测试与重构”开始前的可重复基线。

## 已通过

- 启动编排 PowerShell 语法检查。
- 新启动编排 dry-run 契约测试。
- Windows CMD 一键入口的 CRLF/ASCII 兼容性测试。
- 原有本地部署 dry-run 契约测试。
- `wehook`：46/46 测试通过。
- `Rag/platform-web`：147/147 测试通过。
- `Rag/rag-server`：533/533 单元测试通过。

## 本轮修复

`rag-server` 测试运行器原来无条件传入 `--test-timeout=30000`，本机 Node.js 20.10 不支持该参数，导致任何后端测试都无法启动。现在运行器会从当前 Node 的帮助信息检测能力，仅在支持时添加此参数，并增加对应契约测试。

## 尚未执行

- 4 个需要真实或专用环境的后端集成测试。
- MySQL、Redis、网关、后端和工作台的完整启动与健康检查。
- 真实数据库迁移验证。
- 真实平台、OAuth、生产 token、外部发送接口和公网回调。
- 官网 `web`、旧前端和 Commerce PoC 的测试。

## 下一阶段

先执行基础设施与主系统的本地启动验收：MySQL → Redis → wehook → rag-server → platform-web。确认健康检查、日志和停止方式后，再开始拆分 `rag-server` 的数据库初始化和进程生命周期。
