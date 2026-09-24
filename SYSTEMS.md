# 系统边界与重构顺序

本目录不是一个单体应用，而是多个可独立测试、独立发布的系统集合。后续重构按本文件划定的边界逐个推进，避免一次改动跨越全部系统。

## A. 当前主系统

### 1. `Rag/rag-server`

- 核心客服后端，提供 HTTP API、Socket.IO、渠道消息处理、RAG、任务队列和定时任务。
- 依赖 MySQL、Redis，以及 `@rag/commerce-protocol`、`@rag/commerce-projection-ledger` 两个本地包。
- 第一优先级：先拆数据库初始化和进程启动生命周期，再拆消息、RAG、订单等业务域。

### 2. `Rag/platform-web`

- 当前统一工作台，支持浏览器和 Electron 桌面端。
- 只通过 HTTP/Socket.IO 访问 `rag-server`，不直接访问数据库或渠道密钥。

### 3. `wehook`

- 公网渠道网关，负责企业微信等平台回调、可靠投递、ACK、重试和重放。
- 不承担会话池、AI、坐席权限或前端推送。
- `wehook/cloud-console` 是独立云端控制平面：`admin` 管运营租户/企微安装/额度账本，`account` 管客户账户/本地设备，`api` 接收本地设备的计量请求。
- 云端控制平面只保存租户、连接凭据哈希、额度和审计；聊天、客户、订单、PDF 与百炼知识库仍归本地 `Rag`。

### 4. `Rag/shared-protocol/commerce`

- 厂商无关的外部订单协议、Schema 和运行时校验。

### 5. `Rag/commerce-projection-ledger`

- 外部订单投影账本、幂等、租约和重试协调层。

## B. 独立系统

### `web`

- 公司官网、官网后台和询盘客户池。
- 使用自己的 Vue/Express/MySQL 链路，不属于客服平台核心进程。
- 后续单独测试和重构，不由默认的一键启动脚本启动。

## C. 暂停维护，待确认后归档

- `Rag/rag-admin`：旧管理端，与 `platform-web` 功能重叠。
- `Rag/rag-chat-ui`：旧聊天前端，与 `platform-web` 功能重叠。

源码暂时保留，但已清除可重新安装的依赖和构建产物。确认没有生产入口后再迁入正式归档目录。

## D. 实验性 PoC，不进入生产启动链路

- `Rag/commerce-core-poc`：Vendure 集成边界实验。
- `Rag/commerce-core-medusa-poc`：Medusa 对比实验，当前结论是不采用。

源码和测试保留，依赖与生成目录按需重新安装或构建。

## 建议测试与重构顺序

1. 基础设施和启动编排：MySQL、Redis、健康检查、日志和停止流程。
2. `wehook`：协议、持久化、ACK、离线重放和本地 Mock 闭环。
3. `rag-server` 基础层：配置、数据库、鉴权和统一错误处理。
4. 消息主链路：渠道入站、幂等、会话创建、事件推送和人工发送。
5. AI/RAG：文档上传、检索、回复队列、失败重试和转人工。
6. `platform-web`：登录、消息工作台、权限、断线恢复和桌面端。
7. 订单与商业投影：协议、账本、平台映射和外部 Commerce Core。
8. 独立官网 `web`。

每个阶段完成后再进入下一个阶段，并记录：测试范围、通过项、失败项、遗留风险和部署要求。
