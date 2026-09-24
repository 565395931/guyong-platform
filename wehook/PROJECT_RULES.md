# 云渠道网关项目规则 v1.2

> 最后核对：2026-07-21。本文只保存必须遵守的现行规则；背景见 `memory/MEMORY.md`，专题设计见 `docs/README.md`。

## 1. 项目定位

本项目是计划部署到云服务器的渠道接入服务，负责公网平台与本地 `D:\project\Rag\rag-server` 之间的可靠消息桥接。

云网关负责：

- 接收各平台公网 HTTP 回调，维护千牛等平台长连接。
- 回调验签、消息解密、OAuth 授权和 token 刷新。
- 平台账号、密钥和 token 的加密保存。
- 将不同平台消息转换为统一格式。
- 通过经过认证的 WebSocket 可靠推送给本地 rag-server。
- 接收本地发送命令，调用平台官方接口，并回传发送结果、送达状态和错误。
- 本地离线期间持久缓存消息，恢复后按协议重放。

云网关明确不负责：

- 客服会话池、智能入口路由、AI/RAG、翻译或客服业务状态。
- 坐席、角色、账号可见性、抢单、长期跟进和统计口径。
- 直接向 platform-web 或其他客服前端推送业务消息。
- 替代 Rag 的 `messagingService`、会话落库或 WebSocket 前端推送模块。

## 2. 两项目边界

- 云网关拥有：平台回调协议、平台 OAuth/token、外部账号凭据、外部发送 API、云端缓存和重放状态。
- Rag 拥有：内部 `accountId`、StandardMessage 消费、幂等入库、会话创建/路由、AI/人工处理和客服前端推送。
- 云网关只向 rag-server 交付标准化事件；rag-server 接收后再决定进入哪个会话池和是否触发 AI。
- 跨项目契约主文档为 `docs/rag-integration-contract.md`；变更契约前必须对照 `D:\project\Rag` 当前代码。
- 默认不跨仓库修改；需要两侧联动时分开说明修改和验证结果。

## 3. 入站消息流程

```text
平台 HTTP 回调/长连接事件
→ 验签、解密、结构校验
→ 平台事件幂等去重
→ 转换为统一事件
→ 持久化待投递
→ WebSocket 推送 rag-server
→ 等待应用级 ACK
→ 标记已投递；超时重试或重连后重放
```

- 验签和解密必须在业务解析之前完成；失败事件不得进入 Rag。
- 每个事件必须有稳定 `eventId`；平台提供消息 ID 时同时保存 `channelMessageId`。
- 投递语义采用“至少一次”，不能假设 WebSocket 发送成功等于 Rag 已处理成功。
- 只有收到 Rag 应用级 ACK 后才能标记完成；重试必须保持同一 `eventId`。
- 单个坏消息进入死信/人工排查，不得阻塞同账号全部消息。

## 4. 出站发送流程

```text
rag-server 发送命令
→ 云网关认证、校验和幂等检查
→ 解析平台账号与目标用户
→ 调用官方发送接口
→ 保存平台消息 ID 和结果
→ 回传 accepted/sent/delivered/read/failed 等状态
```

- 每条发送命令必须有稳定 `commandId` 和幂等键；重复命令不得重复发送。
- 接收命令与平台实际发送成功是两个状态，不得混为一谈。
- 平台限流、token 过期、临时错误和永久错误要分类处理；只有可重试错误进入退避重试。
- 发送结果和后续送达状态均通过标准事件回传 Rag，不直接推送客服前端。

## 5. 统一消息和账号规则

- 渠道标识使用稳定小写英文，例如 `whatsapp / qianniu / wechat / douyin`；新增值先与 Rag 对齐。
- `accountId` 指 Rag 内部渠道账号 ID；云端平台账号主键使用独立字段，不得混用。
- `channelUserId` 是平台侧用户/会话标识，保持平台原始稳定值，不擅自转换为手机号。
- `channelMessageId` 保存平台消息 ID，是 Rag 入站幂等的重要组成部分。
- `content.text` 保存客户原文；翻译属于 Rag 职责，云网关不改写正文。
- 媒体事件保存类型、MIME、文件名、平台媒体 ID/URL 等元数据；不要把大体积二进制直接塞进 WebSocket JSON。
- 时间戳统一使用 UTC ISO 8601 或 Unix 毫秒，并明确字段单位；不得传递无时区的本地时间字符串。

## 6. WebSocket 可靠性

- 默认由本地 rag-server 主动发起到云网关的持久 WSS 连接，云网关通过已认证连接双向推送事件和接收命令，避免要求本地暴露公网 WebSocket 服务。
- 云网关与 Rag 之间必须使用加密连接和双向认证能力（至少服务 token；生产优先考虑 mTLS）。
- 协议必须包含 `protocolVersion`、事件类型、唯一 ID、发送时间和负载。
- 必须实现心跳、断线检测、指数退避重连、应用级 ACK、未确认重试、重放游标和最大重试/死信策略。
- 同一账号需要保持可解释的消息顺序；跨账号不应相互阻塞。
- Rag 离线期间消息必须持久缓存，不能只保存在进程内存。
- 恢复连接时先完成身份验证和协议协商，再重放未确认事件。

## 7. OAuth、密钥与安全

- OAuth `state` 必须防 CSRF，授权回调必须校验来源、状态、租户和账号映射。
- access token、refresh token、app secret、验签密钥必须加密保存；日志、异常和 API 响应不得泄露明文。
- 加密主密钥不得与密文存储在同一数据库或提交到仓库。
- token 刷新需要并发锁，避免多个任务同时刷新导致旧 token 覆盖新 token。
- 回调需要时间戳/nonce/重放保护；签名比较使用安全方式。
- 管理接口、健康接口和指标接口按最小权限暴露，不把平台密钥提供给本地前端。

## 8. 数据、日志和运维

- 对账号、事件、命令、投递尝试、OAuth token 版本和错误分类建立可审计记录。
- 日志不得输出客户完整正文、密钥、token、签名原文或解密后的敏感负载；优先记录 ID、长度和状态。
- 数据保留周期、死信处理和个人数据删除需要可配置。
- 所有数据库写入使用事务和唯一约束保证幂等；禁止只依赖进程内 Map 去重。
- 生产部署必须提供健康检查、队列积压、重连次数、回调失败率、发送成功率和 token 刷新失败监控。

## 9. 文档和验证

- 依赖版本、框架和部署方式以未来实际代码和锁文件为准，本规则不提前绑定技术栈。
- 专题文档通过 `docs/README.md` 按需读取，不一次加载全部文档。
- 修改统一契约时至少验证：同事件重复投递、ACK 丢失、Rag 离线重放、乱序、token 失效、平台限流、永久发送失败和媒体消息。
- 与 Rag 对接时以当前代码为真值；发现冲突要同步更新契约文档和长期记忆。

## 10. 第一阶段实施基线：协议基础设施与 Mock 闭环

第一阶段的目标是完成“云网关 ↔ 本地 Rag”的可靠通信骨架和可重复的 Mock 闭环，不接入任何真实平台，不发起 OAuth，不调用真实发送接口，不替换现有 WAHA。

### 10.1 允许范围

- 云网关项目骨架、配置加载、结构化日志和健康检查。
- 云网关与本地 Rag 的独立 WSS 服务端/客户端连接。
- 握手认证、协议协商、心跳、断线检测、指数退避重连。
- 入站事件 Event Store/Outbox、投递尝试、应用级 ACK、重试、游标重放和死信。
- 出站 `channel.message.send` 命令、commandId 幂等、accepted/failed 状态和 Mock Provider。
- Rag 侧 `cloud_gateway` 连接器：接收入站事件、调用现有 `messagingService`、返回 ACK。
- Rag 侧出站命令分发和状态回传的最小实现；人工、AI、系统三类发送入口必须共用分发服务。
- 本地账号与 `gatewayAccountId` 的最小映射接口或迁移设计。
- 去敏后的单元测试、协议测试和离线重放测试。

### 10.2 明确禁止

- 不接入企业微信、抖店、淘宝、千牛、拼多多、1688、小红书等真实平台。
- 不连接生产 Webhook、OAuth、token、平台账号或真实发送 API。
- 不修改或迁移现有 WhatsApp/WAHA/GOWS 链路。
- 不把具体平台协议适配器复制到 Rag；Rag 只实现通用 `cloud_gateway` 传输适配器。
- 不直接向 `platform-web` 推送云网关事件；必须经过 Rag 的 messaging/EventEmitter/Socket.IO。
- 不绕过 Rag service 直接写 `conversations` 或 `plat_messages`。
- 不使用进程内 Map 作为唯一持久化队列或幂等存储。

### 10.3 第一阶段最小事件集合

连接控制：`connection.hello`、`connection.ready`、`connection.ping`、`connection.pong`、`connection.close`。

入站：`channel.message.inbound`、`gateway.event.ack`。

出站：`channel.message.send`、`channel.message.accepted`、`channel.message.status`。

错误和运维：`gateway.error`、`gateway.replay.request`、`gateway.replay.completed`、`gateway.dead_letter`。

所有 envelope 必须包含 `protocolVersion`、`type`、唯一事件/命令 ID、时间戳和 `payload`。ACK 使用 `ackForEventId` 指向原事件；发送命令使用稳定 `commandId`，不得因重试改变。

### 10.4 第一阶段验收

- Rag 主动连接云网关，认证失败、心跳超时和断线均可被识别。
- Mock 入站事件先持久化，再推送 Rag；Rag 处理成功后才返回 processed ACK。
- 重复事件只产生一条本地消息；ACK 丢失会重试同一个 eventId。
- Rag 离线期间事件保留，重连后按游标重放；坏消息进入死信且不阻塞同账号后续事件。
- Mock 出站 commandId 重复不会重复发送；accepted 和 failed 状态能够回写本地消息。
- 人工、AI、系统发送路径都经过统一出站分发器。
- 现有 `new_message`、`message_update`、`conversation_update`、`pool_change` 等前端事件格式保持兼容。
- 所有测试不需要真实平台凭据、生产服务或真实外部网络。

### 10.5 跨项目修改规则

第一阶段如需同时修改 `D:\project\wehook` 和 `D:\project\Rag`，必须在任务说明中明确列出两侧变更；修改前读取双方 `AGENTS.md`、`PROJECT_RULES.md` 和集成契约，修改后分别更新当天 `memory/YYYY-MM-DD.md`。若只授权云网关仓库，则使用 Mock Rag client/test harness，不得自行写入 Rag。

## 11. 本地开发与线上网关并行路由

- 多平台并行开发时，已部署账号继续使用线上网关，新开发账号可以显式切换到本地网关；路由目标必须按渠道账号配置，不能只提供影响整个渠道或整个系统的全局开关。
- 管理后台必须展示每个账号的执行目标（至少 `cloud / local`）、目标网关连接、连接健康和最近切换时间；切换操作要求管理员权限、二次确认和审计记录。
- 同一渠道账号在任一时刻只能有一个有效入站归属和一个出站执行目标。禁止云端与本地同时消费同一平台回调，禁止因自动回退造成重复发送。
- Rag 出站 dispatcher 必须按 `accountId` 解析目标网关连接；线上与本地连接可以并存，不得继续依赖单一全局 `CLOUD_GATEWAY_URL` 作为最终架构。
- 切换到本地前必须验证本地网关已认证、协议版本兼容且账号映射有效；目标不可用时明确失败并保留原路由，不能静默改投其他环境。
- 平台回调地址、OAuth/token 和加密密钥的环境归属必须与路由目标一致。切换管理面不得向浏览器返回明文平台密钥，也不得把开发凭据写入仓库。
