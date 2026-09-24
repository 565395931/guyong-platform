# 客户画像、每日沟通报表与智能复联设计

## 背景与目标

现有客户管理页只维护手机号、备注和订单统计，现有会话池也只提供单会话的长期跟进提醒。本次扩展把客户画像、每日沟通总结、成交后的复联任务和三层账号权限串成一条可追溯的客户运营链路。

目标：

- 同一客户同一自然日无论聊多少轮只计 1 次沟通，并自动标记首次、二次、三次及后续沟通次数。
- 每天为当前可见范围内的客户生成一份日报，展示沟通数量、沟通阶段、成交和待复联情况，并为每个客户保留可回溯摘要。
- 订单进入 `paid`、`delivered` 或 `closed` 后自动识别成交并创建复联任务；AI 根据账号信息、历史沟通内容、订单状态和客户行为信号直接调整提醒时间。
- 普通用户只能看到自己负责的客户和会话，主管和管理员能看全量并可代办；管理员拥有系统配置权限。
- 保留现有左侧导航、折叠状态、移动端抽屉和内容区视觉习惯。

## 范围与非目标

本次只扩展现有 `Rag/rag-server` 与 `Rag/platform-web`。不重做统一导航，不新增左侧栏目，不改现有会话池的领取/释放规则，不把 AI 变成自动发送消息的机器人。

AI 只输出可解释的销售沟通行为信号（例如价格敏感、决策周期长、关注交付保障）和跟进时间建议，不推断敏感身份、心理疾病或其他不必要的敏感属性。AI 输出必须带来源、模型和时间，失败时退回确定性规则，不阻塞消息和页面访问。

## 方案

### 数据模型

继续使用现有 `customers`、`conversations`、`plat_messages`、`orders` 表，新增：

1. `customer_identities`
   - `id`、`customer_id`、`channel`、`account_id`、`external_user_id`、`phone`、`display_name`、`created_at`、`updated_at`
   - 唯一键 `(channel, account_id, external_user_id)`；手机号只作为辅助匹配字段。

2. `customer_communication_days`
   - `id`、`customer_id`、`communication_date`、`message_count`、`first_message_at`、`last_message_at`、`owner_id`、`conversation_ids`、`summary`、`stage_label`、`created_at`、`updated_at`
   - 唯一键 `(customer_id, communication_date)`；索引 `customer_id + communication_date` 和 `owner_id + communication_date`。
   - `stage_label` 按客户历史沟通日序号写入 `first`、`second`、`third`、`nth`，并保留 `communication_index` 数字值。

3. `customer_followups`
   - `id`、`customer_id`、`conversation_id`、`order_id`、`type`、`status`、`due_at`、`completed_at`、`assigned_to`、`source`、`ai_reason`、`ai_confidence`、`ai_signals`、`overridden_by`、`override_reason`、`created_at`、`updated_at`
   - `type` 至少支持 `won_first`、`won_second` 和 `manual`；`status` 支持 `pending`、`due`、`completed`、`skipped`、`cancelled`。
   - 同一个成交订单和任务类型只能有一条有效任务，避免订单同步重试产生重复提醒。

4. `customer_daily_reports`
   - `id`、`report_date`、`scope_type`、`scope_id`、`customer_count`、`first_count`、`second_count`、`third_count`、`won_count`、`due_count`、`overdue_count`、`summary`、`details`、`model_name`、`generated_at`、`updated_at`
   - `scope_type=agent` 表示普通用户自己的日报，`scope_type=all` 表示主管/管理员全量日报；唯一键 `(report_date, scope_type, scope_id)`。

5. `customer_ai_audit_logs`
   - 记录 AI 每次画像/摘要/提醒判定的输入摘要、结构化输出、模型、置信度、实际变更和错误信息，用于解释与人工追踪。

在 `customers` 上增加可编辑的 `display_name`、`owner_id`、`won_status`、`won_at`、`ai_profile`、`ai_profile_updated_at` 字段。迁移采用现有 `database.js` 的幂等建表/加列模式，不删除旧字段和数据。

### 事件与计算

- 消息入库成功后，将客户身份解析为 `customer_id`，对当天的 `customer_communication_days` 做幂等 upsert。客户入站消息和人工坐席出站消息计入 `message_count`；AI 单独出站不产生新的沟通日。
- 新增沟通日后，按客户历史沟通日重新计算序号和阶段标签，并把最近沟通摘要标记为待 AI 重算。
- 订单状态变为 `paid`、`delivered` 或 `closed` 时，按客户身份匹配客户，更新 `won_status` 并幂等创建 `won_first`/`won_second` 任务。订单取消或退款时取消未完成成交任务。
- 后台每 60 秒扫描待 AI 重算的客户和到期任务：加载账号信息、最近沟通日摘要、最近消息、订单摘要和现有提醒；调用结构化 AI 服务；校验输出；写入画像、日报明细和任务时间。扫描任务必须防重入，单个客户失败不影响其他客户。
- 日报按 `APP_TIMEZONE`（默认 `Asia/Shanghai`）计算自然日。当天日报可实时读取统计，AI 总结异步生成；跨日后由定时扫描补齐前一天报告。

### AI 合约与回退

AI 输入是结构化 JSON，包含渠道/账号、客户名称或外部 ID、沟通阶段、最近若干条消息、沟通日摘要、订单阶段和历史任务。输出必须符合：

```json
{
  "summary": "string",
  "signals": [{"code": "price_sensitive", "label": "价格敏感", "evidence": "string"}],
  "nextFollowupAt": "ISO-8601 datetime or null",
  "followupType": "won_first | won_second | manual | null",
  "confidence": 0.0,
  "recommendedTone": "string"
}
```

服务层限制 `confidence` 为 0 到 1，并拒绝未定义的任务类型、非日期值和过长文本。模型超时、解析失败或未配置时，使用确定性回退：成交首次默认 +10 天、第二次默认 +15 天，且不覆盖人工已设置的时间；同时记录 `fallback` 审计事件。

### API 与权限

在现有 `/api/v1/customers` 下增加：

- `GET /daily-report?date=YYYY-MM-DD&owner_id=`：返回当前角色可见日报、客户明细、统计和生成状态。
- `POST /daily-report/regenerate`：主管/管理员可重算指定日期；普通用户只能重算自己的日报。
- `GET /:id/profile`：保留现有订单数据，增加沟通日、阶段标签、AI 画像、跟进任务和可见会话摘要。
- `POST /:id/won`、`POST /:id/followups/:followupId/complete`、`POST /:id/followups/:followupId/skip`、`PATCH /:id/followups/:followupId`：执行成交修正、任务完成/跳过和人工修改。

所有查询先执行角色范围条件再分页：普通用户/坐席只允许 `owner_id`、`conversations.claimed_by` 或 `conversations.agent_id` 与当前用户一致；主管和管理员不加负责人限制。无权访问客户、会话或任务统一返回 404，避免泄露存在性。

### 前端交互

- `CustomersView.vue` 保留原有客户列表，在内容区增加“客户列表 / 今日报表”切换。报表使用 KPI、阶段分布、成交/待复联卡片和客户明细列表；点击客户进入现有画像页，点击会话打开当前工作台会话。
- `CustomerProfileView.vue` 保留订单统计和图表，增加沟通画像卡、阶段标签、AI 信号、最近摘要、沟通日时间线和复联任务时间线。操作按钮只出现在用户有权限的客户上。
- 普通用户不显示负责人全量筛选；主管/管理员显示负责人、渠道和账号筛选。所有加载失败显示可重试状态，AI 尚未生成时显示规则摘要而不是空白页面。
- 不修改 `AppSidebar.vue` 的菜单结构、宽度、折叠逻辑和移动端行为。

## 错误处理与一致性

- 所有日统计和任务创建都使用数据库唯一键或事务，消息/订单重复事件必须幂等。
- AI 服务只在后台异步调用；API 先返回已落库的规则数据。模型调用失败只影响 AI 字段，不回滚沟通日、成交状态或人工修改。
- 任务被人工修改后记录 `overridden_by` 和理由，后续 AI 重算只能更新建议字段，不能覆盖人工锁定的 `due_at`。
- 删除客户前检查是否有会话、订单或任务；现有删除接口改为明确拒绝或软删除，避免破坏历史报表。

## 测试策略

- 后端单元测试：自然日幂等计数、阶段序号、成交任务幂等、AI 输出校验与回退、人工覆盖保护、角色范围过滤。
- 后端路由测试：普通用户/主管/管理员的日报、画像和任务操作权限；无权资源返回 404；重复消息和重复订单不会重复写入。
- 前端模块测试：报表响应归一化、阶段标签显示、角色筛选条件和跟进操作状态；保留现有导航测试，确保左侧菜单未变化。
- 构建验证：`node --test` 运行新增及现有后端测试，`npm run build` 验证 `platform-web` 生产构建。

## 验收标准

1. 一个客户当天发送 30 条消息，只出现 1 个沟通日；跨三天显示首次、二次、三次沟通。
2. 普通用户看不到其他负责人的客户、消息、日报明细和任务；主管能看到全量并代办；管理员还能管理相关配置。
3. 订单状态变为成交态只创建一次成交任务；AI 会生成可解释的摘要/行为信号和下一次提醒时间；模型失败时仍有默认规则提醒。
4. 每日客户报表可以按日期查看，能逐个回到客户画像和原会话。
5. 左侧导航、折叠、移动端抽屉和既有客户/订单功能继续工作。
