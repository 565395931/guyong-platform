# 抖店业务消息接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让系统可以安全配置抖店账号、验证官方事件推送、去重保存订单/退款/商品事件，并在统一前端展示真实能力状态。

**Architecture:** 在 `rag-server` 增加抖店官方事件适配器和统一事件收件箱，沿用现有渠道账号加密存储。前端增加共享渠道能力定义、抖店展开菜单、业务消息页和真实账号页；飞鸽客服收发保持禁用。

**Tech Stack:** Node.js、Express、Sequelize/MySQL、Vue 3、Element Plus、Node test runner

---

### Task 1: 渠道能力目录

**Files:**
- Create: `rag-server/src/modules/channel-capabilities/channelCapabilities.js`
- Test: `rag-server/src/modules/channel-capabilities/channelCapabilities.test.js`
- Modify: `rag-server/src/routes/channelAccounts.js`

- [x] 写失败测试，要求抖店声明订单/售后/商品事件可用、客户消息收发不可用。
- [x] 运行测试并确认因模块不存在而失败。
- [x] 实现能力目录并把能力附加到渠道字典 API。
- [x] 运行测试确认通过。

### Task 2: 抖店验签和事件规范化

**Files:**
- Create: `rag-server/src/modules/channel-adapters/douyin-commerce/douyinSignature.js`
- Create: `rag-server/src/modules/channel-adapters/douyin-commerce/douyinAdapter.js`
- Test: `rag-server/src/modules/channel-adapters/douyin-commerce/douyinAdapter.test.js`
- Modify: `rag-server/src/modules/channel-adapters/index.js`
- Modify: `rag-server/src/app.js`

- [x] 写失败测试覆盖 HMAC-SHA256、错误 App ID、篡改正文、`tag=0` 和订单事件规范化。
- [x] 运行测试确认预期失败。
- [x] 捕获 Express 原始正文，实现常量时间验签和事件解析。
- [x] 注册 `douyin_commerce` 适配器并运行测试。

### Task 3: 事件收件箱和回调

**Files:**
- Create: `rag-server/src/modules/channel-events/channelEventInbox.schema.js`
- Create: `rag-server/src/modules/channel-events/channelEventInbox.repository.js`
- Test: `rag-server/src/modules/channel-events/channelEventInbox.test.js`
- Modify: `rag-server/src/routes/channelWebhook.js`
- Modify: `rag-server/src/config/database.js`

- [x] 写失败测试覆盖建表、事件去重和状态记录。
- [x] 运行测试确认预期失败。
- [x] 实现幂等收件箱和抖店专用快速 ACK。
- [x] 运行测试确认通过。

### Task 4: 抖店账号表单与脱敏

**Files:**
- Create: `platform-web/src/modules/channels/channelCapabilities.js`
- Create: `platform-web/src/modules/channels/douyinAccountForm.js`
- Test: `platform-web/src/modules/channels/douyinAccountForm.test.js`
- Modify: `rag-server/src/routes/channelAccounts.presenter.js`
- Modify: `rag-server/src/routes/channelAccounts.presenter.test.js`
- Modify: `platform-web/src/api/channels.js`
- Rewrite: `platform-web/src/views/Settings/AccountManage.vue`

- [x] 写失败测试覆盖必填字段、凭据不回显和回调地址生成。
- [x] 运行测试确认预期失败。
- [x] 实现真实 API 驱动的账号表格和抖店配置表单。
- [x] 运行后端和前端测试。

### Task 5: 导航与业务消息页

**Files:**
- Modify: `platform-web/src/modules/navigation/channelNavigation.js`
- Modify: `platform-web/src/modules/navigation/channelNavigation.test.js`
- Modify: `platform-web/src/router/index.js`
- Create: `platform-web/src/views/Channels/ChannelEventsView.vue`
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`

- [x] 写失败测试，要求管理员看到抖店“业务消息/账号管理”，普通客服只看到业务消息。
- [x] 运行测试确认预期失败。
- [x] 增加路由、导航和能力限制提示。
- [x] 运行导航测试和生产构建。

### Task 6: 全链路验证

- [x] 用官方示例正文生成签名并 POST 本机回调。
- [x] 验证第一次写入、重复推送去重、篡改正文拒绝。
- [x] 运行全部后端、前端和网关测试。
- [x] 在真实浏览器检查桌面布局、展开菜单、账号页和业务消息页。
- [x] 更新运维文档，记录真实上线仍需 App Key/App Secret、店铺授权和公网 HTTPS 回调。

验收证据：探针返回 200 且不入库；正式事件首次写入 2 条，重复推送仍为 2 条，篡改正文返回 401，错店铺返回 409。管理员、绑定坐席和未绑定坐席的事件范围分别验证；临时账号、用户、绑定和事件均已精确清理。桌面及手机截图保存在 `output/playwright/task6-douyin/`，手机详情长 ID 修复后容器无横向溢出。最终后端全量测试 125/125、前端全量测试 39/39、云网关定向测试 11/11 通过，Vite 生产构建成功；运维要求见 `docs/douyin-commerce-operations.md`。
