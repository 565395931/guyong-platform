# AI 入站消息审核与运营配置设计

**日期：** 2026-07-31  
**范围：** `rag-server`、`platform-web`  
**目标：** 为客户入站消息增加“AI 主审、人工兜底”的审核闭环，同时交付 AI 配置管理页，修复多渠道状态指示器验收问题和当前前端生产构建故障。

## 1. 已确认的产品边界

审核对象是客户发来的入站消息，不是 AI 已生成但尚未发送的回复。

系统先使用硬规则和 AI 审核器判断风险。高置信度正常消息自动放行到现有会话路由；不确定、规则冲突、模型异常，以及 AI 建议“不回复”的消息进入人工审核台。命中审核的消息不得触发对应 AI 自动回复。

AI 永远不能执行“不回复”终局决定。任何“不回复”都必须由坐席、主管或管理员人工确认，并选择原因。人工也可以编辑并发送回复，然后关闭审核项。

审核任务采用“会话负责人优先、公共池兜底”：有在线负责坐席时直接分配；没有负责人，或分配后超过配置时限未处理，则进入公共审核池。主管和管理员可以查看及处理全部任务。

## 2. 总体架构

新增独立的 `message-review` 后端模块，放在入站消息已经持久化、AI 回复任务尚未创建的边界上。模块由五个单元组成：

1. `reviewPolicy`：执行不可绕过的硬规则，合并 AI 结果并给出最终路由决定。
2. `reviewClassifier`：读取有限会话上下文，调用配置的审核模型，返回结构化风险判定。
3. `reviewRepository`：负责审核表的创建、查询、领取和条件更新。
4. `reviewService`：组织判定、分配、状态流转、审计和回复操作。
5. `reviewRoutes`：向工作台暴露分页列表、详情、领取、回复和不回复接口。

前端新增独立的审核视图和 AI 配置视图。审核视图使用已确认的三栏布局：左栏为任务队列，中栏为会话上下文，右栏为风险依据和终局操作。

## 3. 入站处理流程

`processInboundMessageAfterStore` 在调用现有会话路由和创建 AI 回复任务前调用审核服务：

1. 根据 `message.id` 或持久化消息 ID 执行幂等检查。
2. 硬规则初筛。硬规则可直接要求人工审核，但不能直接作出“不回复”。
3. 审核开关开启时，读取最近 N 条上下文并调用 AI 审核器。
4. 合并硬规则和 AI 结果：
   - 硬规则要求审核：进入人工审核，AI 不能覆盖。
   - AI 建议不回复：进入人工审核。
   - AI 置信度低于自动放行阈值：进入人工审核。
   - 模型超时、返回无效结构或调用失败：进入人工审核。
   - 其余高置信度正常消息：放行到现有会话路由。
5. 进入审核时，创建或更新审核任务，清理该会话尚未执行的 AI 回复任务，并返回 `reviewQueued: true`。当前消息不会加入 AI 回复队列。
6. 放行时，继续现有 `routeIncomingMessage` 和 AI 回复入队逻辑。

连续消息合并只作用于同一会话中仍为 `pending`、尚未被领取的审核任务，并使用配置的短窗口。新消息 ID 追加到任务的消息集合，风险等级只升不降。任务进入 `claimed` 后不再静默合并，以免坐席处理期间上下文变化。

## 4. AI 审核输出契约

审核模型必须返回可验证 JSON：

```json
{
  "riskLevel": "low | medium | high",
  "confidence": 0.0,
  "recommendedAction": "allow | review | no_reply",
  "reasonCode": "prompt_injection | suspicious_link | abusive | ambiguous | low_confidence | other",
  "reason": "面向坐席的简短中文依据"
}
```

服务端使用严格白名单验证枚举、置信度范围和文本长度。任何缺字段、非法枚举、非有限数字或超长文本都视为审核器失败，并安全降级到人工审核。

发送给模型的上下文只包含审核所需字段：消息角色、文本内容、时间和渠道，不包含密钥、账号凭据或内部配置。日志只记录审核项 ID、消息 ID、耗时、模型名、结果状态和原因代码，不记录完整客户消息。

## 5. 数据库设计

新增表 `message_review_items`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `CHAR(36)` | 审核任务 UUID |
| `conversation_id` | 与现有会话 ID 一致 | 关联会话 |
| `primary_message_id` | 与现有消息 ID 一致 | 首条触发消息 |
| `message_ids` | `JSON` | 合并窗口内的入站消息 ID 集合 |
| `status` | `VARCHAR(20)` | `pending/claimed/replied/dismissed` |
| `risk_level` | `VARCHAR(10)` | `medium/high`；低风险不创建任务 |
| `confidence` | `DECIMAL(6,5)` | AI 置信度，可为空 |
| `reason_code` | `VARCHAR(40)` | 稳定原因代码 |
| `reason_text` | `VARCHAR(500)` | 坐席可读依据 |
| `recommended_action` | `VARCHAR(20)` | `review/no_reply` |
| `rule_hits` | `JSON` | 命中的硬规则代码 |
| `model_name` | `VARCHAR(100)` | 实际审核模型 |
| `assigned_to` | 用户 ID，可为空 | 负责人优先分配结果 |
| `claimed_by` | 用户 ID，可为空 | 实际领取人 |
| `claimed_at` | `DATETIME` | 领取时间 |
| `resolved_by` | 用户 ID，可为空 | 终局处理人 |
| `resolution_reason` | `VARCHAR(100)` | 不回复原因或回复结论 |
| `outbound_message_id` | 消息 ID，可为空 | 人工回复产生的出站消息 |
| `resolved_at` | `DATETIME` | 关闭时间 |
| `created_at/updated_at` | `DATETIME` | 创建与更新时间 |

约束与索引：

- `primary_message_id` 唯一，防止重复 webhook 创建重复任务。
- 索引 `(status, assigned_to, created_at)` 支持“我的审核”。
- 索引 `(status, risk_level, created_at)` 支持公共池和主管总览。
- 领取操作使用 `UPDATE ... WHERE status='pending' AND (assigned_to IS NULL OR assigned_to=:operator)`；受影响行数为 0 时返回冲突。
- 终局操作使用 `UPDATE ... WHERE status='claimed' AND claimed_by=:operator`。主管和管理员代办时必须先通过原子接管操作转移 `claimed_by`，避免“先释放、后领取”产生抢占窗口，并记录实际处理人。
- 审核记录不提供删除接口。

不新增第二张审计表。终局字段保留当前决定，操作过程继续写入现有系统日志；这样满足审计要求，同时控制本次范围。

## 6. 状态和权限

状态流转为：

```text
pending -> claimed -> replied
pending -> claimed -> dismissed
claimed -> pending（人工释放或离线/超时回收）
```

- `agent`：查看分配给自己的任务和公共池；领取公共任务；处理自己领取的任务。
- `supervisor/admin`：查看全部任务；领取或处理任意未关闭任务；查看审核统计。
- 只有 `admin` 可以修改 AI 审核配置。
- `dismissed` 表示人工确认不回复，必须提交受控原因代码，可附加简短备注。
- `replied` 必须在现有出站发送成功并取得消息 ID 后才能落终局；发送失败时审核项保持 `claimed`，前端显示错误并允许重试。

## 7. 后端接口

新增 `/api/v1/message-reviews`：

- `GET /`：分页查询。支持 `scope=mine|public|all`、状态、风险等级、渠道和关键字筛选。
- `GET /stats`：返回我的待处理数、公共池数、高风险数。
- `GET /:id`：返回任务、关联消息和最近会话上下文。
- `POST /:id/claim`：原子领取。
- `POST /:id/release`：领取人主动释放；管理角色可代释放。
- `POST /:id/takeover`：仅主管和管理员可用，原子接管他人已领取但未关闭的任务。
- `POST /:id/reply`：复用现有人工消息发送服务，成功后原子关闭为 `replied`。
- `POST /:id/dismiss`：校验人工身份和原因，关闭为 `dismissed`。

所有写接口返回最新任务版本。冲突统一返回 HTTP 409，前端刷新当前任务并提示“该任务已被其他坐席处理”。

## 8. 三栏审核工作台

新增路由 `/message-reviews`，所有登录角色可进入，侧栏显示“消息审核”以及当前用户可处理的待审数量。

左栏：

- 标签为“待我审核 / 公共池 / 全部”，其中“全部”只对主管和管理员显示。
- 默认按高风险优先、创建时间升序排列。
- 展示风险等级、客户/渠道、消息摘要、等待时间和分配状态。
- 支持渠道和风险筛选；首版不做批量终局操作。

中栏：

- 展示只读会话上下文，并突出全部触发审核的消息。
- 选择任务时获取最新详情；任务被其他坐席处理后立即切换为只读结果态。
- 不复制完整会话工作台的客户资料和文件面板，避免扩大范围。

右栏：

- 展示硬规则命中、AI 风险等级、置信度、模型和判断依据。
- 未领取任务先显示“领取审核”。
- 领取后提供“回复并关闭”和“不回复”两条路径。
- 回复复用现有文本发送能力；首版不在审核台发送媒体文件。
- 不回复使用固定原因下拉框并允许选填备注；没有原因不能提交。

前端对 409、发送失败、模型依据缺失和任务已关闭分别展示明确状态，不进行乐观终局更新。

## 9. AI 配置管理页

新增管理员路由 `/settings/ai` 和侧栏“AI 配置”。页面不直接展示 `getAllConfig()` 的全部内部键，而是通过前端白名单分组展示稳定配置：

- 审核：`message_review_enabled`、`message_review_model`、`message_review_allow_threshold`、`message_review_context_count`、`message_review_timeout_ms`、`message_review_merge_window_seconds`、`message_review_assignment_timeout_seconds`。
- 现有 AI 回复：回复模型、建议模型、校验模型、超时、并发和上下文条数。
- 安全策略：以只读说明展示“AI 不得自动不回复、硬规则不可被覆盖、模型失败进入人工”，不提供关闭控件。

服务端增加配置键白名单、类型和范围验证，避免现有通用更新接口接受任意键或非法值。本次可继续使用 `conversation_pool_config`、Redis 缓存和 Pub/Sub 刷新机制，不另建配置表。

保存采用逐项更新；每项成功后显示已生效状态。失败项保留用户输入并显示服务端校验错误。敏感凭据不纳入此页面。

## 10. 多渠道状态指示器与构建修复

本次同时完成截图中的剩余验收：

- `resolveChannelChrome` 恢复 `showWahaStatus` 契约，使微信页面不显示 WhatsApp 专属状态，共享页和 WhatsApp 页面保持显示。
- 顶栏继续使用聚合 `ChannelStatusIndicator`，但必须有后端状态接口单元测试和前端状态映射测试。
- 修复 `DashboardView.vue` 引用不存在的 `exportReport`：以统计 API 的真实后端能力为准；若已有导出路由则补齐 API 客户端，否则移除不可工作的按钮和引用，不制造假实现。
- 修复源码中本次触及文件的乱码文本和破损模板标签；不进行全仓库无关编码重写。

## 11. 错误处理与可观测性

- 审核模型失败采用 fail-closed：创建中风险人工审核项。
- 数据库创建审核项失败时，不得继续创建 AI 回复任务；记录高优先级系统错误并让上游重试入站事件。
- 清理 AI 任务失败时不关闭审核创建事务的业务结果，但必须让 AI worker 在执行前检查消息是否处于待审核状态，形成第二道防线。
- 记录 `review_created`、`review_claimed`、`review_taken_over`、`review_replied`、`review_dismissed`、`review_released` 和 `review_classifier_failed` 事件。
- 统计 AI 自动放行数、人工审核数、AI 建议不回复数、人工改判数、平均等待时间和平均处理时间，为后续调整阈值提供依据。

## 12. 测试与验收

后端单元测试：

- AI 输出解析与非法输出降级。
- 硬规则优先于 AI 放行。
- AI 建议不回复必定进入人工。
- 模型异常进入人工。
- 消息 ID 幂等、未领取任务合并、已领取任务不合并。
- 领取和终局条件更新的并发冲突。
- 回复成功后关闭、发送失败保持领取状态。
- 不回复缺少原因或非人工身份时拒绝。
- 配置键、类型和范围白名单。

后端集成测试：

- 入站消息进入审核后不创建 AI 回复任务。
- worker 在审核待处理时拒绝执行遗留 AI 任务。
- 正常消息保持现有路由和回复行为。
- API 权限、分页和 HTTP 409 契约。

前端测试：

- 审核列表筛选和高风险排序。
- 领取冲突刷新。
- 回复和不回复表单校验。
- 路由与角色菜单。
- AI 配置表单规范化和边界校验。
- 渠道顶栏状态契约。

最终验收必须包含：完整相关测试、`platform-web` 生产构建、`rag-server` 测试、真实本地页面加载，以及至少一条“自动放行”、一条“AI 建议不回复进入人工”、一条“人工回复关闭”和一条“人工不回复关闭”的接口级流程验证。

## 13. 非目标

- 不做自动训练、在线学习或根据人工结果自动修改阈值。
- 不允许 AI 自动执行不回复。
- 不做批量审核终局操作。
- 不在审核台支持媒体回复。
- 不替换现有会话池、消息发送或身份体系。
- 不接入第二个模型做双模型交叉审核。
