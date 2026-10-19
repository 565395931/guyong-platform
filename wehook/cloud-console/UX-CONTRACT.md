# Lonely Warrior Cloud — UX Contract

## Roles and route ownership

- `operator`: may access `/admin`, mutate tenants, WeCom installation metadata and manual credit grants, configure the shared OpenAI-compatible model gateway, read tenant-isolated WeCom conversations, generate AI drafts and manually send replies.
- `tenant_admin`: may access only its tenant account overview and issue/revoke local device credentials.
- Device credentials authenticate machine API calls only and never create browser sessions.
- Server-side authorization is authoritative. Forbidden direct access returns HTTP 403, not a disguised 404.

## Authentication

Browser sign-in uses username/password and an HttpOnly, Secure, SameSite=Strict signed session cookie. Invalid credentials always produce one generic error. Password values are never logged or persisted in browser storage. Session expiry returns the user to sign-in while preserving only the intended surface, not form secrets.

## Canonical UI map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | `.form-field` + `form[novalidate]` | `cloud.js` and this contract | sign-in / create / grant | browser + unit API tests |
| Entity choice | `.choice-field` radio-card group | `cloud.js` and this contract | customer / authorized enterprise | keyboard + validation + browser |
| Modal | modal factory in `cloud.js` | `cloud.js` and this contract | standard / consequential | keyboard, Escape, focus restore |
| Toast | toast factory in `cloud.js` | `cloud.js` and this contract | success / warning / error | live region |
| Table | `.data-table` + table renderer | `cloud.js` and this contract | tenant / WeCom / ledger / devices | empty, loading, 20-row page |
| Scrollbar | global `cloud.css` | `DESIGN.md` | table region geometry only | computed style/manual |
| Auth | signed session cookie | server authorization | operator / tenant_admin | API integration tests |
| CRUD | JSON API + audit entry | server domain services | create / grant / issue | integration tests |
| Model config | `#model-form` + encrypted server store | `cloudMessagingService.js` | save / test | integration + live failure state |
| Message inbox | `.inbox-shell` | `cloudMessagingService.js` | empty / selected / AI draft / sent | integration + browser |
| Shop config | `#shop-form`, settingsField and choiceField | `wechatShopService.js` | create / edit / saved-credentials test | API tests + browser |
| Customer profile | local workbench only | local conversation authorized update | remote remark UI retired; legacy write returns 410 | shop-customer-context tests |
| Shop disconnect/delete | shared consequential modal + scoped domain API | localWorkbenchPairing.js / wechatShopService.js | preserve registration / permanently remove shop-owned data | pairing, shop deletion and outbox tests |
| Customer orders | shared modal + explicit cursor load more | `shopCustomerOrders.js` | first query / partial / retry / next page | shop-customer-context + HTTP tests |

Native select and date pickers are not part of the first release. Add an authored shared primitive before introducing either when popup geometry becomes product-owned.

## 微信小店商家自研通道

接入页只显示已登记店铺分页列表和新增店铺按钮，不显示说明或操作指南。新增/编辑复用共享弹窗；客户选择、店铺名称、AppID、AppSecret、服务器地址、Token、消息密钥集中配置。新增时服务器创建两小时有效的加密草稿，地址立即可响应 GET 验证；保存后沿用该地址并接收消息。未保存草稿不能处理消息或调用小店接口。

弹窗所有输入明文显示，文本字段右侧复制；AppSecret 仅显示本次填写值，不从服务器回显，编辑留空保留原值。回调参数仅运营管理员鉴权 POST 返回，同源保护、no-store、非敏感审计；列表无密钥、浏览器不持久保存。弹窗底部左为重新生成新的回调，右为保存小店配置。新增重新生成会替换临时草稿，原草稿立即失效；已有店铺换密钥须二次确认保存。弹窗独立滚动、锁背景滚动、焦点约束、关闭恢复焦点，登录失效清除明文。列表保留测试接口连接，不发送客服消息；地址验证、凭据有效与实际收发分别验收。不会切换外部客服模式或自动回复。

An unconfigured model gateway defaults to DeepSeek's official OpenAI-compatible endpoint with model `deepseek-flash`, temperature `0.8`, and a 2,000-token output cap. The model form keeps labels and actionable errors, but omits persistent field-help copy; saved-key presence remains visible in the panel header without exposing the key.

Internal UUIDs are never typed or copied by operators. When an operation targets a customer or an authorized enterprise, show the recognizable name plus its public identifier (`客户编号` or `CorpID`) in the canonical radio-card choice group; submit the internal ID invisibly.

Inbound image messages use an authenticated same-origin media endpoint. The WeCom media identifier remains encrypted at rest and never appears in inbox JSON or a public URL. The browser reserves image geometry, uses an informative alt label, and replaces a failed preview with inline retry guidance. The current test implementation proxies the temporary WeCom media and does not establish a permanent retention policy. Generating an AI suggestion sends the complete real conversation history, excluding unsent AI drafts. Available inbound images are resolved server-side and sent as OpenAI-compatible image content; an expired temporary image is represented explicitly instead of silently omitted.

On desktop, the message workbench owns the remaining viewport height. The conversation list and message stream scroll independently inside that frame; additional messages never keep extending the whole document. While the inbox is visible, the client checks for updates every three seconds and only repaints when data changed. A repaint preserves an unsent reply, text focus, and the reader's scroll position. Polling pauses in a background tab or outside the inbox. A transient refresh failure keeps the current content visible and exposes a non-blocking retrying state.

## Mutation lifecycle

微信小店客户备注统一在本地工作台维护；远端入口已移除，旧修改接口返回 410，新接入不继承远端测试备注。“关联订单”保持原有授权查询方式。弹窗打开期间暂停收件箱重绘。

店铺行总是显示“断开连接”（未连接时禁用）与独立的危险“删除店铺”。断开仅撤销所选店铺的本地绑定，保留两端历史及登记，不影响同一客户端的其他店铺。删除需输入完整店铺名称，清理登记/加密凭据/会话/消息/旧资料与投递记录并解除绑定；保留其他店铺和客户账户，不删除本机数据、不切换外部客服模式。先保留受保护的加密备份，页面不提供撤销。提交中拒绝重复和关闭，失败内联并保留输入；删除后重新加载并夹紧列表分页，初始焦点放在取消。

订单查询由运营管理员明确点击触发，默认最近 7 天创建的订单，附带最近 10 张入站订单卡片；分页每次最多 20 个订单 ID，游标只用于当前会话且 15 分钟过期。官方接口和归属规则依据 `../docs/wechat-shop-integration.md` 客户身份与订单章节。返回前逐条验证 OpenID，礼物区分送礼人/收件人；不可读取和不属于当前客户分别计数，不暗示空列表意味着没有历史订单。只在弹窗内存显示安全摘要，不写入订单原文，不自动解密姓名、地址或电话，不给 AI 自动添加订单上下文。订单昵称仅为特定订单来源，不覆盖人工备注。

All mutation buttons keep their width while busy, reject duplicate submit and expose `aria-busy`. On success, close the modal, refresh the owning dataset and announce a concise toast. On failure, preserve entered values and show an inline actionable error. The first invalid field receives focus.

Manual credit grants are consequential and require an app-owned confirmation step naming the tenant and number of credits. They are append-only; correction is a compensating ledger entry, never history deletion. Payment and automatic recharge are out of scope until a verified billing contract exists.

## Tables and state

Tables show at most 20 rows per page, with total/range copy and explicit previous/next controls. Loading, empty, no-result and failure states keep the table panel footprint stable. IDs may be truncated visually but retain an accessible full value. No secret value appears in a table.

## Connection states

Canonical labels are `在线`, `离线`, `待配置`, `需处理`. A signal dot accompanies every label. “在线” means a recently authenticated local device connection; it does not imply that WeCom callbacks or AI model calls are healthy.

## Recovery and audit

Every admin mutation records actor, action, target type/id, timestamp and non-secret metadata. API idempotency keys protect credit reserve/settle/cancel operations. A failed page request offers Retry. A 401 returns to sign-in; a 403 shows a dedicated permission message.

## Message reply safety

Shop rows expose “连接本地工作台” using the existing shared modal. Pairing codes expire after five minutes, are copyable, and are cleared on close/session expiry. “本地接管” denotes ownership, not liveness. Remote replies remain blocked until ownership is explicitly revoked; disconnection must never silently switch senders.

During testing, model output is always stored and labelled as an unsent draft. Only the explicit `发送回复` action calls the WeCom send API. A failed or not-yet-authorized send preserves the reply text and shows an inline recovery error; it must never be presented as sent. Automatic reply is a later, per-tenant capability and is off by default.

## 模型余额（2026-10-10）

管理员直接设置客户人民币余额，须填写调整说明；基于读到的余额提交，余额并发变化则提示刷新，不覆盖。请求中禁重复，失败保留金额和说明。所有调整追加审计，历史套餐记录保留，发放套餐接口已移除。售价、成本、毛利分列；人工修改余额不等于实收。

## 按账号查看模型账单（2026-10-10）

默认不展示所有账号混合调用；客户行的“查看账单”选择该客户，只加载该客户最近 300 条调用，标题显示客户名。切换客户重置账单分页，加载/错误期间不显示旧客户数据；分页与余额修改保持当前选择。每账号调用日志按写入顺序滚动保留 300 条；累计扣费、成本、毛利及余额独立于日志保留。未完成计费请求保留必要结算状态，过期请求保留账本幂等摘要。

## 客户模型Key
生成动作只允许运营账号；窗口标明对应客户与扣费归属。生成中禁重复操作，成功只展示一次，复制失败可在窗口选取。仅模型网关接受此Key，不替代店铺连接凭据。
