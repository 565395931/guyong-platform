# 完整项目源码包使用说明

交付日期：2026-09-17。ZIP 顶层是 `Rag/`，这是完整项目代码归档，不是安装包，也不是生产数据库备份。

## 目录

| 目录 | 用途 |
| --- | --- |
| platform-web | 主客服工作台、Electron 桌面端源码、构建与单元测试 |
| rag-server | 中心业务服务、渠道接入、报价、订单、仓库、AI 辅助及数据库初始化代码 |
| rag-admin / rag-chat-ui | 旧管理和聊天前端 |
| shared-protocol/commerce | 电商共享契约 |
| commerce-projection-ledger | 电商投影协调库 |
| commerce-core-poc / commerce-core-medusa-poc | 开源电商核心调研 PoC，不是正式生产服务 |
| docs | 需求、方案、操作说明和测试记录 |
| tools / docker | 部署、导入、验证与归档工具及配置模板 |

## 解压后检查

`SOURCE-MANIFEST.json` 包含逐文件 SHA256、文件大小和排除说明。不要直接覆盖现有生产目录，先在新目录解压核对。

包中不含 `node_modules`，各项目根据自己的 `package-lock.json` 安装依赖；其他电商包按其锁文件/README 使用对应包管理器。包中也不含真实 `.env`、证书私钥、客户媒体/附件、运行数据库或日志。这些仍在原机器，并未删除。

## 主工作台

进入 `platform-web`，本轮使用 Node.js 24.14.1 验证：

```powershell
npm ci
npm test
npm run build
```

桌面开发运行 `npm run desktop:dev`；生成 Windows 安装程序运行 `npm run desktop:dist`。需要中心服务才能登录并处理业务。详细地址配置见 `platform-web/README.desktop.md`。

## 中心服务

进入 `rag-server`，安装依赖后可以先运行安全离线测试：

```powershell
npm ci
npm test
```

测试入口不加载原机器凭据，默认排除需真实数据库/Redis的专项测试；详见 `docs/testing/backend-safe-tests.md`。

实际启动前，需要根据 `.env.example` 配置独立的 MySQL、Redis、认证密钥及所需平台/模型配置，并先完成数据库迁移与数据恢复规划。服务启动可能创建/修改表结构、启动业务定时任务，不要对正式数据库进行盲目试运行。原账号、产品报价和客户数据来自中心数据库，不存于源码包。

## 当前完成度

完整复核结果见 `docs/testing/project-audit-2026-09-17.md`。本轮前端 147 项、后端 532 项、独立电商包 132 项测试通过，但真实平台物流回写、安全加固和业务数据恢复仍有明确缺口。不要把源码可构建等同于已完成企业商用上线验收。
