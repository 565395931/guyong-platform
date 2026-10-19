# Agent 工作入口：先模块，后依赖

本文件是项目唯一根级工作入口。默认只阅读本文件和本次目标模块，不扫描、通读全仓库。历史记录不是当前操作指令。

## 1. 每个任务的最小流程

1. 用下面的模块表选定目标；已知文件直接打开，不先做全库概览。
2. 检查目标目录是否有更近的 AGENTS.md；仅适用该目录的约束需要继续读取。
3. 先读目标入口、对应业务实现和相关测试。首轮通常 3–5 个文件；这不是硬上限，证据不足时按依赖扩大。
4. 在目标模块内定位符号；修改前核对直接调用者/依赖，默认深度 1。只有发现真实跨模块调用才扩展。
5. 先运行模块测试；改共享协议、鉴权、消息主链路或跨端接口时，再运行受影响系统的完整测试。
6. 完成后写入 docs/changes/YYYY-MM-DD-主题.md，说明改动、验证、未验证项、部署/数据影响；在本文件末尾留下短链接。

禁止把所有路由、所有组件、所有测试或全部历史文档一次读完。任务不清楚时先用小范围路径/符号查询，不用“通读项目”替代定位。

## 2. 模块入口

路径均相对本目录。表格是路由索引，不是必须阅读清单。

| 任务 | 先读的模块/入口 | 需要联动时才跟进 |
| --- | --- | --- |
| 聊天显示、备注、归档、切换渠道 | Rag/platform-web/src/components/Chat、components/Conversation、modules/conversations；views/Workbench、views/PlatformMessages | stores/conversation.js、api/websocket.js；rag-server/src/routes/conversations.js、modules/conversation-pool |
| 微信小店本地配对、连接、图片 | Rag/rag-server/src/modules/cloud-gateway/localShopConnection.js、src/routes/localWorkbench.js；platform-web/src/views/Settings/AccountManage.vue | wehook/src/saas/localShop*、shopGatewayAdapter.js；wehook/docs/local-workbench-pairing.md |
| 远端微信小店登记、回调、收发 | wehook/src/saas/wechatShop*、cloudMessagingService.js；cloud-console/public/assets/cloud.js | controlPlaneServer.js、gateway、test/wechat-shop.test.js；docs/wechat-shop-integration.md |
| 企业微信第三方应用、授权、回调 | wehook/src/wecom、src/saas/wecomSuiteService.js | providerCallbackServer.js、controlPlaneServer.js；相关 wecom 测试 |
| 通用消息入站、出站、去重 | Rag/rag-server/src/modules/messaging、channel-adapters | modules/conversations、conversation-pool、websocket |
| 飞鸽/抖店桌面采集、租约、发送 | Rag/rag-server/src/modules/desktop-bridge；Rag/tools/feige-uia-probe | channel-adapters/desktop-bridge、src/routes/desktopBridge.js；只读探针与对应测试 |
| 渠道账号、连接配置、健康状态 | Rag/rag-server/src/routes/channelAccounts.js、channelStatus.js；modules/platform-connections | platform-web/src/views/Settings/AccountManage.vue、modules/channels、views/Channels |
| 大模型配置、AI 建议、知识库 | Rag/rag-server/src/modules/ai-provider、modules/rag、services/aiSettings.js | modules/conversation-pool；platform-web/src/views/Settings、views/Knowledge、modules/aiConfig |
| 客户资料、身份、跟进 | Rag/rag-server/src/modules/customer-operations、src/routes/customers.js | platform-web/src/views/Customers、modules/customers；会话入口仅按需跟进 |
| 商品、报价、订单、仓库 | Rag/rag-server/src/modules/catalog、order-fulfillment、warehouse、commerce-projection | platform-sku-mapping；platform-web 对应 Catalog/Orders/Warehouses；shared-protocol/commerce、commerce-projection-ledger |
| 登录、角色、系统账号 | Rag/rag-server/src/routes/auth.js、modules/system-accounts | src/middleware；platform-web/src/views/Login、modules/login、modules/systemAccounts |
| 启动、重启、部署、依赖 | ops、start-all.bat；Rag/tools/local-deploy | Rag/docker/mysql、Rag/docker/redis、对应 package.json；app.js 仅启动生命周期任务才读 |
| 云端租户、凭证、额度、配对鉴权 | wehook/src/saas/controlPlaneService.js、controlPlaneServer.js、localWorkbenchPairing.js | cloud-console；fileSaasStore.js、security.js、相关 test |
| 公司官网 | web | 独立系统，不能顺带改客服平台 |

通配路径表示文件名线索：先列出匹配文件，再选择目标，不把整个目录全部打开。遇到未知功能，先在最可能的系统中查询；只有未命中才扩大到项目根。

## 3. 定位规则

- CodeGraph 用于声明、引用、调用关系和依赖；精确文案、日志、配置键用限定路径的 rg。
- 已知目标用 goto / refs / deps，不固定执行 orient、index、sync。需要概览时 orient 只用 small 预算。
- CodeGraph MCP 根目录必须匹配本项目；路径错误、连接失败或长时间无响应时，不反复重试。使用 CLI 或限定模块的 rg，并说明覆盖限制。
- CodeGraph 静态索引不能证明运行时正确。遇到截断/降级结果先缩小查询；有 stale 标记时按工具约定刷新。
- 不读 node_modules、dist、缓存、镜像、日志全集。运行故障只读相关日志尾部并脱敏。
- 不使用根目录无边界搜索或递归枚举来收集源码；首次模块定位可用限定目录的 rg --files。

示例（在本目录执行）：

```powershell
rg -n "备注|user_name" Rag/platform-web/src/components/Conversation Rag/rag-server/src/routes/conversations.js
codegraph refs "Rag/rag-server/src/routes/conversations.js" --root .
codegraph deps "Rag/rag-server/src/modules/cloud-gateway/localShopConnection.js" --root .
```

## 4. 按需读取的约束

- 跨系统或系统归属不明：读 SYSTEMS.md。不要默认读独立官网、旧前端或实验 PoC。
- 改界面：读该系统 DESIGN.md / UX-CONTRACT.md 和相关组件；只验收桌面端，不擅自增加移动端适配。
- 身份、授权、渠道容器商业化：按需读 Rag/docs/commercialization/README.md。
- 部署：读目标系统运维说明和实际服务配置；单元测试通过不等于正式环境已验证。
- 历史问题：先在 docs/history/AGENTS-before-2026-10-10.md 搜索相关标题，再读该段。不要默认通读历史快照。

## 5. 安全边界

- 保留用户未提交修改；禁止顺手重置、清理、升级或重构无关模块。
- 不在文档、日志、提交或返回内容中写密码、Token、私钥、AppSecret、客户聊天正文。
- 不擅自发送真实客户消息、切换小店客服模式、开启自动回复、改官网或扩大部署范围。
- 删除前确认精确对象、关联影响和备份；禁止清库或用宽泛路径递归删除。备份不得误覆盖后续业务数据。
- 新配对连接按客户/店铺隔离；本地备注不写远端。测试店铺不是可随意重置的数据库。
- 不默认启动 WAHA。MySQL/Redis 等服务的启动、停止仍须遵守本次授权范围。

## 6. 验证与交付

优先使用模块现有测试命令或对应测试文件；先查看该系统 package.json 的脚本，不凭记忆写命令。

| 受影响系统 | 完整验证（必要时） |
| --- | --- |
| Rag/rag-server | npm.cmd test；环境/集成测试另行明确执行 |
| Rag/platform-web | npm.cmd test；界面变更再 npm.cmd run build |
| wehook | npm.cmd test；改入口/运行脚本再做语法检查 |
| 启动运维 | 对应 PowerShell 测试/dry-run；ops/Get-PlatformStatus.ps1 |

写实际测试结果，不将历史测试数当固定门槛。浏览器未登录、真实平台未联调、部署未执行等限制必须单独说明。纯文档调整只核对路径、链接、内容与历史保存完整性，不启动业务服务或重跑无关全量测试。

## 7. 最近记录（短索引）

- 更早记录已完整保留在 [历史快照](docs/history/AGENTS-before-2026-10-10.md)，仅按任务读取。

后续每次只增加短链接，最多保留最近 5 条；详细内容写入 changes，旧链接移到历史索引。不再往本文件追加长篇排障日志。





























- 2026-10-10 可配置渠道提示词与失败感叹号详情：[实现与验收](docs/changes/2026-10-10-configurable-channel-prompts.md)。

- 2026-10-10 AI文字发送失败图片兜底与转人工：[实现与验证](docs/changes/2026-10-10-ai-send-image-fallback.md)。

- 2026-10-10 取消截图补发，AI发送失败直接转待人工：[当前行为与验证](docs/changes/2026-10-10-ai-send-failure-human-only.md)。

- 2026-10-12 Admin 与普通客服、自动分配及个人话术：[实现与验证](docs/changes/2026-10-12-admin-team-routing.md)。

- 2026-10-19 GitHub 同步、OCR 安装与多平台审查：[修复与验证](docs/changes/2026-10-19-github-ocr-platform-audit.md)，[验收清单、账号准备与远端操作地址](docs/multiplatform-acceptance-checklist.md)。
