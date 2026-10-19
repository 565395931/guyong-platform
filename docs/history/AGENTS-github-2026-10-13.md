# Agent 操作手册与变更记录

本文件是新 Agent 进入项目后的第一入口。目标是利用已经建立的 CodeGraph 索引定位功能，只读取与当前任务直接相关的代码，避免每次重新扫描整个仓库。

## 新窗口建议首句

可以把下面这句话直接发给新 Agent，再接上本次具体任务：

> 先阅读项目根目录的 `AGENTS.md`。必须优先使用 CodeGraph 定位本次功能，只读取命中的文件及其直接引用/依赖，不要重新扫描全仓库。完成后运行相关测试，并把本次改动简洁追加到 `AGENTS.md` 的变更记录顶部。

## 固定范围

- 项目根目录：本文件所在目录。
- 当前产品只验收桌面端，不做移动端页面或移动端适配。
- 当前主系统边界见 `SYSTEMS.md`，不要把独立官网、旧前端和实验 PoC 混入主启动链路。
- 不得在文档、日志或提交说明中记录密码、Token、数据库凭据或私钥。
- 工作区可能存在用户尚未提交的修改；不要重置、覆盖或顺手清理无关文件。

## 新任务的最小读取流程

1. 先读本文件。
2. 任务跨系统时再读 `SYSTEMS.md`；身份、授权或渠道容器任务再读 `Rag/docs/commercialization/README.md`。
3. 用 CodeGraph 搜索功能名、路由名、组件名或符号，只打开命中的文件。
4. 查看该符号的引用、调用者或文件依赖，确定影响范围后再修改。
5. 优先运行目标模块测试；只有共享层或跨模块修改才扩大测试范围。
6. 完成后在“变更记录”标题下方追加一条简短记录，让最新改动始终排在最前。

不要把 `codegraph orient` 当作每个任务的固定第一步。只有任务描述很模糊或确实需要重新了解系统边界时才运行，并使用小预算。`codegraph.config.json` 已排除依赖、构建产物、日志和历史审计目录。

## CodeGraph 定位方式

在项目根目录执行，按需要选择一条命令：

```powershell
# 不确定功能位置：搜索代码、路径和文档
codegraph search "登录" --root .

# 已知类、函数或组件名：先找声明
codegraph symbols "createAuthRouter" --root .

# 已知文件或符号：读取定义与当前源码
codegraph goto "Rag/rag-server/src/routes/auth.js::createAuthRouter" --root .
codegraph file "Rag/rag-server/src/routes/auth.js" --offset 1 --limit 220 --root .

# 修改前确认引用、调用关系和文件依赖
codegraph refs "Rag/rag-server/src/routes/auth.js::createAuthRouter" --root .
codegraph callers "Rag/rag-server/src/routes/auth.js::createAuthRouter" --root .
codegraph deps "Rag/rag-server/src/routes/auth.js" --root .
codegraph rdeps "Rag/rag-server/src/routes/auth.js" --root .
```

规则：

- 已知目标时直接用 `goto`、`refs`、`callers`、`deps`，不要先做全库概览。
- 精确文案、错误日志、环境变量和配置键使用 `rg`，例如 `rg -n "AUTH_MODE" Rag/rag-server`。
- 返回结果出现 `truncated`、`omitted` 或 `mixed/reduced analysis` 时，缩小查询范围后再判断。
- CodeGraph 是静态证据，修改后仍必须运行测试或真实接口验证。
- 禁止递归读取整个仓库、批量输出所有源码，或扫描 `node_modules`、`.tmp`、`dist`、日志和离线镜像。

## 常用入口

| 目标 | 位置 |
| --- | --- |
| 一键启动 | `start-all.bat` |
| 查看状态 | `ops/Get-PlatformStatus.ps1` |
| 启动编排 | `ops/Start-Platform.ps1` |
| 密码恢复 | `reset-admin-password.bat` |
| 后端 | `Rag/rag-server` |
| 桌面工作台 | `Rag/platform-web` |
| 渠道网关 | `wehook` |
| 系统边界 | `SYSTEMS.md` |
| 商业化预留 | `Rag/docs/commercialization/README.md` |
| 前端设计约束 | `Rag/platform-web/DESIGN.md` |
| 初始重构基线 | `REFACTOR_BASELINE_2026-09-23.md` |

## 验证命令

只运行与改动相关的最小集合；准备交付或修改共享边界时再跑完整集合。

```powershell
# 后端：当前基线 541 项
Set-Location Rag/rag-server
npm.cmd test

# 前端：当前基线 152 项；界面或构建配置变更还需 build
Set-Location Rag/platform-web
npm.cmd test
npm.cmd run build

# 网关：初始基线 46 项
Set-Location wehook
npm.cmd test

# 运行状态
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\Get-PlatformStatus.ps1
```

正式环境、真实平台发送、OAuth、公网回调以及需要专用数据库的集成测试，不得因为单元测试通过就宣称已验证。

## 每次修改的记录格式

每轮完成后在“变更记录”顶部追加一节，控制在四行以内：

```markdown
### YYYY-MM-DD — 功能名称
- 改动：一句话说明完成了什么。
- 位置：列出主要目录或文件，不罗列生成文件。
- 验证：写实际运行并通过的测试或接口；未验证必须明确写出。
- 待办：没有则写“无”，有则写下一步和边界。
```

只记录功能、架构、配置、数据迁移和部署行为的变化。格式化、临时截图、缓存与构建产物不进入记录。

## 变更记录

### 2026-09-25 — 热重载与客户升级协议预留
- 改动：后端开发命令启用 Node watch 热重载；新增客户升级清单 Schema、HTTPS/SHA-256/Ed25519 合同校验及安全升级边界，尚未启用自动下载或安装。
- 位置：`Rag/rag-server/package.json`、`ops/update`、README。
- 验证：后端 541 项、更新清单正反例合同、JSON 解析、PowerShell 语法和 CodeGraph 审查均通过。
- 待办：确定正式更新域名和签名公钥后，再实现独立更新器、版本包、健康检查回滚及管理员“检查更新”入口。
### 2026-10-13 — 拼多多客服场景全链路打通（读会话→点开→读消息→回复发送）
- 改动/发现：①`pdd_client.py` 扩展为完整客服操作工具：`click-text`（OCR 定位文字→提窗→真实点击）、`click-input`（几何定位输入框）、`type-text`（SendInput Unicode 打字，中文免输入法）、`press-enter`、`click-point`（窗口坐标点击）、`read`（截图+OCR）。全程按窗口相对/实时计算坐标，无写死位置。②**真实发送实测通过**：向会话"拼多多米白白"发送测试消息（消息区与会话列表摘要双确认）。③**关键踩坑（已修复）**：客户端窗口不在前台时 Chromium 停止渲染，PrintWindow 截到**停更旧帧**——回车发送后立即截图核对误判"未发出"，导致同一消息重复发送两次；修复为 `capture_and_ocr` 默认校验前台、非前台自动提窗 0.8s 再截（`--no-raise` 可跳过）。今后所有"操作后立即核对"的读取必须先确保窗口前台。④已知边界：短气泡文字 OCR 会漏（需局部裁剪放大识别）、历史消息需滚动拼接（未做）。
- 位置：`Rag/tools/pinduoduo-uia-probe/{pdd_client.py,REPORT-pinduoduo-uia.md}`（报告新增第 7 节）。
- 验证：全链路实测（数对话 3 个、点开"拼多多米白白"、读取消息区、输入"我爱你"、回车+按钮两种方式均真实发送成功、会话列表摘要更新为"我爱你"）。
- 待办：①结构化封装（会话列表/消息区 JSON、滚动读历史）；②未读检测轮询与"客服监控"场景组装；③短气泡/链接/数字的局部放大识别增强。

### 2026-10-13 — 拼多多启动参数透传实验（结论：不可行）+ 视觉路线在新版复验通过
- 改动/发现：①方案 B（`--force-renderer-accessibility` 启动参数）在 3.7.3.12 上做了干净复测：外壳**不透传未知参数**（浏览器进程 10 秒正常启动但命令行无该参数）；参数模板不在任何根目录 DLL 中（动态/混淆构造，无配置文件入口）；直接启动浏览器进程不可行（外壳私有 IPC 通道 + `--extra-cmd` 加密配置拿不到）；IFEO 注册表劫持理论可行但客户端装有风控组件 `sentinel.exe`，且**每次重启都要重新扫码登录**（两次实测），不建议走。②**本客户端重启不保留登录态**（强制重启后必须手机扫码，实测两次），涉及重启的调试都要用户配合。③视觉路线（截图+OCR）在 3.7.3.12 上复验通过：读取工作台首页 30 行（含"今日咨询人数""买家订单/商品管理/售后退款"模块、"AIEBS汽车用品旗舰店"页签等）；OCR 中文数据经码点校验正确（终端 stdout 的显示乱码与文件数据无关，`pdd_client.py` 已加 stdout 强制 UTF-8）。
- 位置：`Rag/tools/pinduoduo-uia-probe/{pdd_client.py,REPORT-pinduoduo-uia.md}`（报告新增第 6 节；`out/pdd_browser_cmdline_before/after.txt` 为透传实验存档）。
- 验证：透传实验（前后命令行对比）、DLL 全目录扫描、新版视觉读取（30 行带坐标，码点校验通过）。
- 待办：①用户重新登录后，在视觉路线上做结构化读取（先做消息/客服页：会话列表 + 未读 + 消息区；订单侧可优先走官方 API）；②重启保留登录态的优雅关闭方式未验证（下次重启前先试正常退出而非 taskkill）；③UIA 路线仅剩 IFEO 一条（已评估，不推荐，除非将来有官方支持）。

### 2026-10-13 — 拼多多工作台视觉读取打通（截图+OCR）+ 客户端升级 3.7.3.12
- 改动/发现：①UIA 深度排查：内核 `chrome.dll` 有 `--force-renderer-accessibility` 开关（1 处）但 `UiaClientsAreListening` 等自动唤醒路径被切除（0 处）；系统屏幕阅读器标志 `SPI_SETSCREENREADER` 实测无法唤醒其无障碍树（40 秒无变化，已还原）；无监听端口/调试参数——UIA 路线除非以启动参数强启否则不可用。②**视觉读取路线打通**：`PrintWindow(PW_RENDERFULLCONTENT)` 遮挡可截（无需置顶）+ Windows 自带 OCR（zh-Hans-CN）；过程中发现 PowerShell 5.1 接收 WinRT 字符串会经 ANSI 代码页损坏（UTF-8→GBK），调用前 `chcp 65001` 修复。③新增 `Rag/tools/pinduoduo-uia-probe/{pdd_client.py,ocr.ps1}`（`capture`/`read`，只读），实测读取工作台界面 11 行文本（会话列表等，含坐标）。④客户端自动升级 3.7.2.14 → 3.7.3.12（升级在重启时应用；**升级后需重新登录一次**）；新版内核无障碍字符串与旧版一致。
- 位置：`Rag/tools/pinduoduo-uia-probe/{pdd_client.py,ocr.ps1,REPORT-pinduoduo-uia.md}`（报告新增第 5 节）。
- 验证：OCR 实测输出真实界面文本（"官方待办任务群 VIP / 拼多多米白白 / 官方群消息"等 11 行带坐标）；PrintWindow 遮挡场景实测通过；新旧版内核无障碍字符串对照一致；屏幕阅读器标志实验已还原系统设置。
- 待办：①**用户登录 3.7.3.12 后复验工具**（主窗口类名前缀 `g_wszPDDWindowClass` 是否变化需确认；登录页是原生窗口、无渲染宿主，工作台页才是 Web 内容）；②`--force-renderer-accessibility` 透传实验被升级打断，可重试（需重启客户端，可能再次要求登录，先与用户确认）；③视觉路线的结构化解析（会话列表/消息区/订单表格）与点击自动化（坐标由 OCR 实时定位）按需开发。

### 2026-10-13 — 拼多多工作台 UIA 可行性检测（结论：不可读）+ 千帆待做清单落档
- 改动/发现：①**拼多多工作台（3.7.2.14，`pddbrowser104` 定制 Chromium 104）UIA 不可读**：主窗口（`g_wszPDDWindowClass{…}`，"拼多多工作台"）下 4 个渲染宿主全部 **0 文本节点**，全窗口扫描（46 个顶层窗口 + 全部渲染宿主）只有窗口框架元素；连续轮询 + 数十分钟间断附加（已远超 Chromium 无障碍树的懒构建预热窗口）始终为 0，判定定制内核未启用/剥离了无障碍支持；相关进程无监听端口、命令行无调试参数（私有 IPC 通道不可用）。新增复检探针 `Rag/tools/pinduoduo-uia-probe/probe.py`（只读，客户端升级后重跑）+ `REPORT-pinduoduo-uia.md`（含证据链与三条备选路线评估）。②千帆链路的未完事项汇总为 `Rag/docs/qianfan-order-pipeline-todo.md`（数据完整性/联调验证/功能扩展/运维/长期维护五组 15 项，供后期排期）。
- 位置：`Rag/tools/pinduoduo-uia-probe/{probe.py,REPORT-pinduoduo-uia.md,.gitignore}`、`Rag/docs/qianfan-order-pipeline-todo.md`。
- 验证：探针实测输出稳定（渲染宿主 0 文本 ×4、主窗口 1 文本=自身标题）；结论由多重证据交叉确认（渲染宿主附加/全窗口扫描/长时预热/端口/命令行）。
- 待办：**拼多多接入路线待决策**——推荐走网页版 `mms.pinduoduo.com` 的浏览器自动化（关键证据：客户端命令行显示它加载的就是 `--ir-url-host=mms.pinduoduo.com --ir-url-path=/web/`，即工作台=该网页+定制外壳，网页版 DOM 完整可读可写；动工需商家账号扫码登录一次）；备选截图+OCR（Windows 自带 OCR 可用，只能读当前可见内容，可靠性明显更低）；订单侧已有官方开放平台通路（`pinduoduo-commerce` 适配器声明订单/售后事件能力，本机未配账号故 `sync_tick_completed accounts:0`），聊天无官方 API。

### 2026-10-13 — 千帆采集订单入库（WS `commerce.orders.scraped` + orders 表幂等 upsert）
- 改动：①协议新增消息类型 `commerce.orders.scraped`（`bridgeProtocol.js` 的 TYPES / payload schema / envelope 三处）；②网关新增 `orderIngestService` 分发（`bridgeGateway.js`）+ 装配（`desktop-bridge/index.js`、`app.js`）；③新服务 `modules/desktop-bridge/scrapedOrderIngestService.js`：订单行映射（状态词表映射、创建时间归一为 `YYYY-MM-DD HH:MM:SS`、客户字段/raw_payload 全行保留）、**按 order_no 幂等 upsert**（`INSERT ... ON DUPLICATE KEY UPDATE`，每天重采不产生重复行）、新订单写 `order_events` 轨迹、账号按渠道解析 desktop_bridge 账号；④节点 `bridge_node.py`：采集成功后读 latest JSON 上报订单，`event.ack` 回执带入库结果（`新增 N 条、更新 M 条`）记入节点日志；⑤人工补录脚本 `scripts/ingest-scraped-orders.js`（与节点走同一个入库服务）。
- **数据库运维发现（重要）**：本机 Windows MySQL80 服务（`D:\MySQL\Server80`）是 **9月25日前的遗留实例**——错误日志显示它 9月25日 09:18 正常关停后直到今天机器重启才被自动拉起；而平台自 9月25日采用 Docker MySQL（`rag-mysql` 容器 / `mysql-data` 卷），**平台数据全在 Docker 卷里**（MySQL80 的数据停在 9月25日，且 root 密码与 `.env` 不符）。今天重启后 MySQL80 抢占 3306，导致 `rag-mysql` 无法绑定宿主端口、平台起不来（启动脚本见端口被占会静默跳过 Docker MySQL，后端随即连库失败）。**已停掉 MySQL80**（`net start MySQL80` 可恢复），`rag-mysql` 已正常绑定 3306，`localhost:3306` 用 `.env` 凭据可连。建议把 MySQL80 服务改为手动启动或卸载，避免每次重启复现。
- 验证：真实采集 18 条全量订单（过程中自愈路径实测生效：客户端被遮挡 → 提窗 → 重试成功）→ 入库 **新增 18 条**；幂等复跑 **更新 18 条、总数与事件数不变**；状态映射实测分布 delivered 2 / closed 12 / cancelled 4，与页面原始状态（已签收 2 / 已完成·已关闭 12 / 取消发货 4）一致；节点生成的 WS 信封经服务端 zod 协议校验通过；后端 **611/611**（基线 599 + 新增 12 用例：入库服务 11 + 协议类型清单）。
- 待办：①**订单分页未覆盖**——列表页 20 条/页，总数超一页时只采当前页并记告警；②列表页没有商品明细与金额（`order_items`/金额字段为空），需要做订单详情页采集才能补；③运单号/发货仓/商家名称暂存 `raw_payload`，未写 `order_shipments`；④`payment_status` 是推断值（非草稿一律 `paid`），退款场景未区分；⑤**端到端 WS 全链路**（节点与服务端同时在线的定时采集→上报→ack）尚未组合实测，各组件已分别验证；⑥`scripts/cleanup_tables.js` 里有硬编码的 DB 密码兜底值（违反仓库自身的凭据规则），建议清理。

### 2026-10-13 — 千帆订单定时采集（元素级点击）+ 桥接节点多适配器 + 建号渠道参数化
- 改动：①**千帆订单采集器** `Rag/tools/qianfan-uia-probe/qianfan_orders.py`（新增）：定时点进订单页 → 重置条件+搜索 → 抓取订单表格（11 列全字段：订单号/状态/用户名/用户ID/手机号/商家名称/发货仓/收货地址/运单号/创建时间/操作列表）→ 点回客服页。**点击全部走元素级 UIA 动作（零坐标，不模拟鼠标）**：DoDefaultAction → Invoke，失败则提窗等状态恢复后重试；仅允许点左侧导航与重置条件/搜索，黑名单拒绝误点；try/finally 保证无论成败都点回客服页。②**解除"一台机器一个节点"硬约束**：`bridge_node.py` 的 `ADAPTER_IDS` 扩为 `["doudian.feige","xiaohongshu.qianfan"]`，两个平台共用一个节点（不再需要为千帆单起节点进程——provision 以机指纹幂等，再签发会把旧凭据顶掉）；节点新增千帆订单定时任务（`QIANFAN_ORDERS_ENABLED` / `QIANFAN_ORDERS_AT=HH:MM` / `QIANFAN_ORDERS_TIMEOUT_SECONDS`），子进程隔离执行、同日不重跑、执行期间聊天轮询暂停（飞鸽读界面无状态，恢复后按指纹补读，不丢消息）。③`qianfan-uia-probe/detect.py`（新增）：建号检测探针，单行 JSON 契约与飞鸽一致；机器指纹与飞鸽同算法（实测两平台指纹完全一致，账号绑定同一节点）。④服务端：`desktopBridgeAccountConfig.js` 新增渠道→adapterId 映射（douyin→doudian.feige，xiaohongshu→xiaohongshu.qianfan），prepare 按渠道强制并覆盖 config 里携带的错渠道值；`routes/channelAccounts.js` 检测接口按渠道选探针（`QIANFAN_PROBE_PATH`/`QIANFAN_PROBE_PYTHON`/`QIANFAN_PROBE_TIMEOUT_MS`，旧 `FEIGE_PROBE_*` 保留兼容），建号把 channel 透传给 prepare。
- 位置：`Rag/tools/qianfan-uia-probe/{qianfan_orders.py,detect.py,qianfan_nav_probe.py,README.md,REPORT-qianfan-capture.md}`、`Rag/tools/feige-uia-probe/bridge_node.py`、`Rag/rag-server/src/modules/channel-adapters/desktop-bridge/desktopBridgeAccountConfig.js`（+测试）、`Rag/rag-server/src/routes/channelAccounts.js`、`src/modules/desktop-bridge/bridgeBinding.test.js`。
- 验证：**真实采集 18 条订单**两轮全通过（含重置查询、视图还原、落盘）；节点定时任务真实触发（22s/轮，日志完整）+ 同日跳过逻辑验证；detect 探针输出正确（店铺名/在线/指纹）；后端 **599/599** 测试通过（新增 5 用例：按渠道 adapterId、错渠道覆盖、expectedAdapterIdForChannel、检测路由源码断言、建号透传 channel）；千帆工具全部编译通过。
- 待办：①订单数据目前**只落本机文件**（`qianfan-uia-probe/out/qianfan_orders_*.json`），未接入平台订单投影；②订单分页未覆盖——总数超一页（20 条）时只采当前页并记告警；③采集要求千帆窗口存在且未最小化，锁屏/睡眠下的行为未验证（定时任务建议机器不锁屏）；④前端 `AccountManage.vue` 尚未给小红书开放"本地桌面客户端"接入选项（API 层已支持）；⑤千帆聊天（会话/消息）尚未接入桥接，右侧客户面板与消息区字段待真实会话复测。

### 2026-10-13 — 小红书千帆本地捕捉（新工具目录 + 只读实测）
- 改动：新增 `Rag/tools/qianfan-uia-probe/`，把抖店飞鸽的本地捕捉流程复刻到小红书千帆客服工作台（进程 `千帆客服工作台.exe`，安装代号 `eva`，V1.2.6）：`qianfan_capture.py`（`enum` 窗口枚举 / `capture` 元素树捕捉 / `selfcheck` 只读自证）、`profiles/xiaohongshu_qianfan.json` 采点配置、`REPORT-qianfan-capture.md`。关键实测结论与飞鸽一致：**必须附加渲染宿主 `Chrome_RenderWidgetHostHWND`**（客服工作台视图实测 97 节点/29 文本，智能客服视图 307/96），从顶层 `Chrome_WidgetWin_1` 附加只有空壳（29/4）。两处与飞鸽不同：主窗口标题是 `eva`（安装目录代号，无店铺信息，不能按标题定位，只能按进程+class+可见）；主窗口下**有两个**渲染宿主（主内容区 + 48px 标题栏条），需按节点数取主内容区。切换左侧导航时渲染宿主 HWND 不变、内容树整体替换（DocumentControl 名即视图标识），捕捉自动跟随并按视图名另存产物。已定位会话列表容器 `farmer-contact-list`（小红书 Walle 设计系统，automation_id 前缀 `walle-`）。
- 位置：`Rag/tools/qianfan-uia-probe/`（`qianfan_capture.py`、`profiles/xiaohongshu_qianfan.json`、`README.md`、`REPORT-qianfan-capture.md`）。未改任何既有代码。
- 验证：`selfcheck` PASS（AST 扫描无禁用 API）；两轮全树读取文本完全一致（29/29）；捕捉时千帆在后台（前台是 ZCode）读取正常，不要求前台焦点；隐藏窗口渲染宿主实测只读到 1 节点/0 文本（与飞鸽一致）；两个视图连续捕捉成功（09:36 客服工作台 → 09:38 智能客服，同一渲染宿主）。当前客户端**无进行中会话**（消息区「暂无对话」、会话列表为空），会话项与消息区字段**未验证**。
- 待办：①有真实会话时重跑 `python qianfan_capture.py capture`，补会话列表项/消息区/未读徽标/右侧栏的字段结构；②确认冷启动预热行为（飞鸽实测 Chromium 无障碍树首次启用约需 15s，千帆未复测）；③识别输入框 automation id（只读流程不触碰，桌面桥接发送流程需要时再识别）。

### 2026-09-28 — 修「会话已从列表消失却还留在 AI 池」（列表可读 vs 读不到）
- 改动：现象是**会话明明已经从客户端会话列表消失，却一直留在 AI 自助池、不归档**。根因有两层：①上一轮我按"顶栏是当前会话的权威来源"给 `toArchive` 加了 `key !== currentKey` 的保护——**恰恰漏掉了真实场景**：客户会话倒计时结束后会从列表消失（容器里只剩"暂无会话中用户"），但界面仍停在那条会话上、顶栏还显示着它，于是"当前会话"永远被豁免，等不到归档。②`active_conversation_keys` 在"容器不存在"和"容器存在但为空"两种情况下都返回 `[]`，而后端需要区分这两件事：前者是**读不到**（不能归档，否则一次解析失败会清空所有会话），后者是**列表真的是空的**（该归档）。改法：节点新增上报 `conversationListReadable`（容器 `chantListScrollArea` 是否存在）与 `feige_extract.conversation_list_readable()`；后端据此判定——**列表可读 → 不在列表里的全部归档（含顶栏还停着的那个）**；列表读不到（或老节点不带该字段）→ 退回旧行为，只保留当前会话。同时把 `toRestore` 改成"只恢复没有被归档判定命中的当前会话"，避免同一次快照里先恢复又立刻归档。
- 位置：`Rag/tools/feige-uia-probe/{feige_extract.py,bridge_node.py}`、`Rag/rag-server/src/modules/desktop-bridge/accountSnapshotService.js`（+测试）。
- 验证：后端 **595/595**（改写并新增 3 个用例覆盖"可读但为空→含当前会话一起归档""读不到→保留当前会话""老节点无字段→保守回退"）；**真实场景实测通过**——重启后端与节点后日志出现 `[AccountSnapshot] 账号 4 归档 1 条、恢复 0 条（当前会话 01d3be83f264，列表 0 个）`，数据库 `conv_status='archived'`，前端实测「AI自助 = 0、已归档 = 1」。只读探针确认容器存在、内容为"暂无会话中用户"（列表确实为空）。
- 待办：`extract_conversation_list`（旧的会话项启发式）在同一时刻仍误报 1 条（nickname 摘要 `0c57d2b564bc`、无文本）——就是被弃用的那个把消息行当会话项的坑，`snapshot()` 还在用它，建议一并改用容器限定版。列表可读性依赖 `chantListScrollArea` 这个 automation_id，若飞鸽改版会退化成"读不到"（表现为不归档而不是误归档，安全方向是对的）。

### 2026-09-28 — AI 直接回复（去掉 review）+ AI 配置页补齐 env 里的项
- 改动：①**去掉 ai_mode='review'**：该字段代码里从没人读过（只是存着），但默认值写着 review 会让人以为"AI 回复要人工审核"；默认改为 `auto`，存量那条绑定也已改。②**AI 回复真的能发出去了**：`ai-auto-reply.service.js` 的两处发送分支原先只有「云网关 / WAHA(仅 WhatsApp)」，抖店没有分支 → 生成出来的 AI 回复发不出去（且被记成 sent）；现在两处都**按账号优先**加桌面桥接分支（与手动发送、审核发送同一套判定）。③**AI 配置页补齐**：新增 6 个可配置键——`ai_chat_base_url`（大模型接口地址，OpenAI 兼容）、`ai_chat_model`（默认模型）、`ai_suggestion_enabled`（AI 推荐回答开关）、`bailian_workspace_id/index_id/category_id`；百炼 **AccessKeyId/Secret 走加密凭据**（AES-256-GCM 密文存配置表，接口只回掩码，与供应商密钥同一套 cipher）。④**新增 `services/aiSettings.js` 统一取值口**：数据库配置 → .env → 内置默认，**每次调用现取**；原先这些值是模块加载时读死的，配置页改了不重启不生效。已把读取点改成现取：langchain 的 baseURL、handoff-keyword / conversation-router / rag.routes 的默认模型、rag.routes 的推荐开关、localParserService 的百炼应用标识（`bailianId()`）。保存配置时把「环境变量类」的键**同步一份到 `process.env`**（langchain 的 apiKey、百炼客户端凭据是按 env 现取的）。⑤页面新增「大模型接口」「百炼应用」两个分区；大模型 API Key 仍在页面顶部原有的供应商卡片里填（可测连接、同步模型、查余额）。
- 位置：`Rag/rag-server/src/{modules/conversation-pool/ai-auto-reply.service.js,modules/ai-provider/bailianCredentialService.js(新增),modules/ai-provider/*,services/aiSettings.js(新增),services/configService.js,modules/message-review/reviewConfig.js,modules/rag/{langchainService.js,rag.routes.js,localParserService.js},routes/conversations.js,modules/desktop-bridge/*}`、`Rag/platform-web/src/{views/Settings/AiConfigView.vue,modules/aiConfig/aiConfigForm.js,api/aiConfig.js}`。
- 验证：后端 **594/594**（基线 586 + 新增 8）、前端 **169/169**、生产构建通过，后端已重启。新增单测覆盖：新键可配置/可清空、开关仍是严格布尔、百炼凭据**密文里不出现明文**、状态只回掩码、清除后回退环境变量；浏览器实测 `/settings/ai` 出现「大模型接口」（接口地址/默认模型/AI 推荐回答）与「百炼应用」（workspace/index/category + AccessKey 输入）两个分区，`GET /bailian-credential` 返回 `configured:false, source:'none'`（与 .env 为空一致），页面回显与占位符正确。
- 待办：**AI 现在仍然跑不起来，卡在凭据**：`DASHSCOPE_API_KEY` 与 `ALIBABA_CLOUD_ACCESS_KEY_ID/_SECRET` 在 `.env` 里都是空的——在配置页填上大模型 API Key（顶部供应商卡片）之后 AI 才能生成回复。**还没接进配置页的读取点**（仍是模块级/写死，改了配置页不影响它们）：`translationService.js` 的 `DASHSCOPE_BASE_URL`（第 14/34/112 行）、`ragService.js:23`、`rag.controller.js:14` 的 `DASHSCOPE_MODEL` 默认值、`rag.routes.js:22`（另外两处 321/483 行）。百炼的「应用调用」还依赖 `@alicloud/*` SDK 与网络，未做真实联调。

### 2026-09-28 — AI 回复逻辑对齐 / 渠道待人工红点 / 渠道异常红光 / 会话消失即归档
- 改动：①**AI 回复与手动发送对齐**：审核通过后的发送（`message-review/sendHumanReviewReply`）原先用 `getAdapterByChannel(channel)` **按渠道**解析适配器，抖店会拿到官方抖音适配器（固定返回"开放平台未提供客服消息 API"）→ **审核过的 AI 回复永远发不出去**；改为**按账号优先判定**（`desktop_bridge` → 桥接适配器，与 `routes/conversations.js` 的手动发送一致），并传 `localMessageId` 把指令绑回消息行。②`sendAiReply` 的 `send_status` 原先**写死 'sent'**（发送失败也记成功）→ 改为由调用方传 `sendStatus`，4 处失败分支如实记 `failed`；前端的在途/失败展示因此与手动发送一致。③**渠道待人工红点**：池统计新增 `pendingByChannel`，左侧菜单「抖店」这类渠道条目右边显示红色数字（仅「平台消息」组）。④**渠道异常红光**：`/channels/status` 新增桌面桥接健康判定（**有节点持有未过期租约=在线**，节点每 15s 续租），前端新增共享的 `channelHealth` 单例（订阅计数轮询），侧边栏渠道条目与客服账号管理页在异常时**闪红光**（账号页横幅放在嵌入判断之外——工作台里的账号管理是嵌入渲染的，放进 `v-if="!props.embedded"` 里等于不显示）。⑤**会话消失即归档**：`accountSnapshotService` 原先只保留"节点当前打开的会话"、其余全归档；改为用节点上报的 `activeConversationKeys`（客户端会话列表）判断，**列表里已经没有的才归档**；列表读不到（空数组）时退回旧行为，绝不当成"都不在列表里"。
- 位置：`Rag/rag-server/src/modules/{message-review/index.js,messaging/messaging.service.js,conversation-pool/{ai-auto-reply.service.js,pool.service.js},desktop-bridge/accountSnapshotService.js}`、`src/routes/channelStatus.js`（+测试）、`Rag/platform-web/src/{components/Layout/AppSidebar.vue,views/Settings/AccountManage.vue,modules/channels/channelHealth.js}`（+测试）。
- 验证：后端 **586/586**（基线 580 + 新增 6）、前端 **169/169**（165 + 新增 4）、生产构建通过，后端已重启。浏览器实测：侧边栏「抖店」显示红色待人工数字 **1**（造了一条待人工会话，验完已改回）；渠道异常时侧边栏该条目 `animationName=app-sidebar-channel-alert-…`、账号管理页横幅文案「渠道「抖店」连不上（本地客户端未连接）…」且 `animationName=account-channel-alert-…`、下拉选项带「连不上」标记；真实接口在节点在线时报 `douyin=CONNECTED / overall=HEALTHY`（验证异常态用的是页面内伪造响应，未动真实渠道状态，验完已刷新清除）。**未验证**：真实掉线（停节点等租约过期）时的端到端表现——那会中断你正在用的客户端收发，所以没做。
- 待办：**AI 自动回复现在也发不出去，但原因不是代码**：`DASHSCOPE_API_KEY` 与 `ALIBABA_CLOUD_ACCESS_KEY_ID` 在 `.env` 里都是空的，模型调用会直接抛 `InvalidCredentials`，所以 AI 根本生成不了回复（数据库里 `sender_type='ai'` 为 0 条、日志里没有任何 AI 回复尝试）。配好模型凭据后再验一遍 AI 自助回复。另外 `desktop_bridge_bindings.ai_mode` 是 `review`（审核后发送），代码里**没有任何地方读它**；AI 直发路径（`sendAiReply`，不经审核）也没有抖店/桥接分支，要不要让 AI 在抖店直接发（绕过审核）需要你定。

### 2026-09-28 — 快捷话术面板接真实接口（复制 / 编辑 / 分层增删）
- 改动：面板原先**整棵树的示例话术都写死在组件里**（`id: 1, label: '个人话术'`…），没有任何接口调用，`emit('insert')` 也没有任何父组件监听（点了没反应），是块未完成的占位实现。①改为读后端 `quick_replies` 并把**扁平数据拼成三层树**：归属（个人话术 / 公共话术，按 `created_by` 是不是我）→ 分类（`category`）→ 话术内容；②**点击话术=复制**（不再往输入框里塞），新增 `copyText()` 兜底——`navigator.clipboard` 只在安全上下文可用，而工作台平时是从局域网 `http://IP:3003` 打开的，那里它是 undefined，必须退到 textarea + `execCommand`；③每行右侧常驻小图标：**话术**行=编辑+删除，**分类/归属**层=添加+删除（整层删除会收集子节点并写明"及其中的 N 条话术"再确认）；④新增/编辑弹窗含归属、分类（可选已有或直接输入新分类）、标题、触发词、内容；后端 `requireManager` 只放 admin/主管，坐席不显示这些按钮。⑤**后端小改**：`POST/PUT /quick-replies` 新增 `shared` 字段——原来 `created_by` 恒为当前用户，界面上根本建不出「公共话术」；现在 `shared=true` 写空 `created_by`（不传则不改归属，避免"只改内容"把公共话术挪成个人）。⑥把面板里原有示例话术**原样写入库**（7 条，个人 4 + 公共 3），否则接上真实接口后面板会变空。
- 位置：`Rag/platform-web/src/components/Panel/QuickReplyPanel.vue`（重写）、`src/api/messages.js`（新增 3 个 CRUD 函数）、`src/modules/quickReplies/quickReplyPanel.test.js`（新增）、`Rag/rag-server/src/routes/quickReplies.js`。
- 验证：前端 **165/165**（基线 162 + 新增 3）、后端 **580/580**、生产构建通过；后端已重启。浏览器实测：树按创建人正确分成人话术/公共话术两层、13 个节点每行按钮数正确；点击话术的提示为"已复制话术内容"，并**用 PowerShell `Get-Clipboard` 独立验证系统剪贴板里确实是那条话术**；在「开场白」下添加→弹窗标题/归属/分类预填正确→保存后新条目落在该分类下；编辑→弹窗带出原值→保存后内容替换；删除单条→提示"已删除 1 条"且条目消失；分类删除的二次确认文案实测为「确定删除「物流查询」这一层，及其中的 1 条话术吗？」（已取消，未动真实数据）。**副作用**：这 7 条话术现在也能被输入框的 `/` 命令面板搜到（此前该面板是空的）。
- 待办：`GET /quick-replies` 单页上限 100 条，面板一次取 100——超过 100 条会截断，需要分页取全。归属/公共话术的区分只是 `created_by` 是否为空，**不等于权限**（任何 admin/主管都能改公共话术）；若以后要"个人话术只有本人能改"，需要给表加字段并改权限判定。话术的启用/停用（`PATCH /:id/status`）面板暂未暴露。

### 2026-09-28 — Tab 跟随推广到"任何归属变化" + 发送即时显示复测
- 改动：①**Tab 跟随不再只认「认领成 private」**，而是"当前查看的会话换了归属就跟着切"（AI 池 ↔ 我的 ↔ 待人工 ↔ 已归档）。原来只判 `toPool === 'private'`，其它归属变化（归档、转 AI、复活）会话照样从当前列表里消失、要用户自己去找。归档/复活走的是 `conversation_update`（不带 `pool_type`），而且归档被 `pushService` 当作 `pool_change` **广播到公共池房间、payload 里只有 `type` 没有 `toPool`**，所以新增按事件类型推目标 Tab（`TAB_BY_EVENT_TYPE = { archived: 'archived' }`）；目标栏限定为界面上真实存在的四栏（`public`/`long_term` 已从界面移除，切过去只会是空白列表）；`_shouldShowInActiveTab` 同步按后端口径把归档会话保留在「我的」里，否则池变更会把它从「我的」删掉。②**发送即时显示复测**：实测点击到"气泡 + 转圈"进入 DOM 只要 **84 毫秒**，排版也正确（最后一条、在视口内），无需再改代码——上一轮的排序修复已经消除了"看不见"的根因。
- 位置：`Rag/platform-web/src/api/websocket.js`（`_handlePoolChange`/`_handleConversationUpdate`/`_shouldShowInActiveTab`/新增 `_followConversationTab`）。
- 验证：前端 **162/162** + 生产构建；浏览器实测——点击后 **84ms** 气泡与 16×16 转圈（"发送中…"）出现在**最后一条且在视口内**，失败后正确显示"发送失败，点击重试"（本次刻意在浏览器内拦截该 POST，不落库、不打扰正在对话的客户）；Tab 跟随实测 `我的 → AI自助`（transfer-to-ai）、`AI自助 → 已归档`（archive）、`→ 待人工`（revive）三种方向，每次会话都保持打开、右侧不丢。
- 待办：**页面不会自动热更新**——预览服务发的是带 hash 的产物，已打开的标签页会一直跑它加载时那份 JS，必须刷新页面才生效；改动后若仍看到旧行为，先刷新一次再判断。`accountSnapshotService` 直接改库、**不发任何 WebSocket 事件**，所以它把会话从归档拉回 AI 池时前端列表和 Tab 不会跟着变（仍是空窗）。归档的 `CONVERSATION_UPDATE` 只在 `claimed_by` 非空时才发到个人房间，未认领的会话收不到那条（本次靠 `pool_change` 兜住）。

### 2026-09-28 — 发送后消息不立即出现（两条时间路径基准不一致）
- 改动：现象是"点发送后看不到消息，要重新点一次会话才出现"。真因是**同一屏消息的两条时间来源差 8 小时**：①REST 列表 `GET /:id/messages` 直接返回 DATETIME，而连接是 `timezone: '+00:00'`（`config/database.js`），库里的本地墙上时间被当成 UTC，前端再 +8 小时 → 整屏历史时间偏到 8 小时后（19:38 的消息显示成 `09-29 03:38`）；②WebSocket 推送用的是真实时间（`timestamp: new Date()`）。前端按时间戳排序，于是"最新"的消息反而落在历史中间、在当前滚动位置不可见；重新点会话走 REST 重载、全部按同一（偏移）基准排序，它就跑到末尾了——这正是"重新点一次才刷新"的来源。修法：①列表接口 `created_at` 改 `DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s')` 输出**墙上时间**（本文件与 `customers.js` 早就在用这个写法），两条路径对齐；②前端新发出的消息用 `nextOutboundTimestamp()`（"最后一条 + 1 毫秒"）兜底，保证永远排在末尾，且**整轮发送（乐观占位 → 服务端确认 → 失败）复用同一个时间戳**，避免状态一变就跳位。
- 位置：`Rag/rag-server/src/routes/conversations.js`、`Rag/platform-web/src/components/Chat/ChatWindow.vue`。
- 验证：后端 `npm test` **580/580**、前端 **162/162**；浏览器实测——点发送那一刻新气泡即为**最后一条且在当前视口内**（index=44 / total=45、`visibleInViewport=true`、时间 `20:48` 正确），直到发送完成都不发散，`sending` 转圈到 +8s、状态归位后不再有指示器；历史消息时间从 `09-29 03:38` 恢复为真实 `20:10~20:46`；真实发送成功（节点日志 `发送成功 …（legacy_set_value+default_action）`，12 字）。**顺带修正**：整屏消息时间此前整体偏 8 小时。
- 待办：`config/database.js` 的 `timezone: '+00:00'` 与"库里存本地墙上时间"的约定仍然矛盾，凡是**直接返回 DATETIME** 的接口都有同样偏移风险（会话列表的 `c.last_message_time` 尚未核对；`lastMessageTime` 那两处已有 `DATE_FORMAT`）。建议统一按 `DATE_FORMAT` 输出，或改成真正按 UTC 存储。本轮只修了消息列表这一处。

### 2026-09-28 — 抖音抖店链路四项修复（乐观更新 / Tab 跟随 / 归档双显 / 发送不抢焦点）
- 改动：①**乐观更新**：气泡左侧新增发送状态——点发送立刻转圈，后端**确认后**变绿勾并约 2 秒后自动消失，失败标红可点击重试（消息不消失、失败不再静默）；重试沿用原请求负载，媒体消息不会退化成纯文本。②**「我的」Tab 跟随认领**：会话被认领成 private 时（发送前的 `ensureClaimedForReply`、抢单）自动把列表 Tab 切到「我的」并保持该会话选中。③**归档双显**：三条归档路径本就只写 `conv_status`/`status`、**不动 `pool_type`/`claimed_by`**，所以只需让「我的」的列表查询不再排除 archived，同一会话即同时出现在「我的」与「已归档」。④**发送不抢焦点**：真因**不是** `Invoke` 而是 **`ValuePattern.SetValue`**（把前台挪走后逐段实测：`resolve_render_host`/`find_input_box` 都不动，SetValue 之后飞鸽才变前台），写入改 `LegacyIAccessiblePattern.SetValue`、触发改 `DoDefaultAction`。⑤**修 BridgeExpiry×AccountSnapshot 互相覆写**：TTL 扫描跳过"节点当前打开的会话"（新增 `currentConversationRegistry`），此前 `conv_status` 每 30 秒在 archived/ai_serving 间横跳、发送约一半概率被 409「会话已归档」挡下。⑥**修 `feige_send` 会话校验键**：原按会话列表派生，列表读不到时返回 None，发送被 `NO_OPEN_CONVERSATION` 挡死；改取**顶栏**（与入站同一个 `current_customer()`、同一公式），键值不变但不再依赖列表。
- 位置：`Rag/platform-web/src/components/{Chat/MessageBubble.vue,Chat/ChatWindow.vue,Conversation/ConversationList.vue}`、`src/api/websocket.js`、`Rag/rag-server/src/routes/conversations.js`、`src/modules/desktop-bridge/{currentConversationRegistry.js,bridgeExpiryService.js,accountSnapshotService.js}`（含新增单测）、`Rag/tools/feige-uia-probe/feige_send.py`。
- 验证：后端 `npm test` **580/580**（基线 572 + 新增 8）、前端 **162/162** + 生产构建通过；**真实发送 4 条全部成功**（节点日志 `发送成功 …（legacy_set_value+default_action）`，DB 对应行 `send_status=sent`）；浏览器实测状态时序 `sending` 0→5.5s → `sent`（绿勾，+7s，**只在后端确认后**）→ +10s 消失，6 条失败态标红且可重试，Tab 在 +400ms 切到「我的」且会话保持选中；API 实测归档后「我的」与「已归档」各一条（`mine_count=1`/`archived_count=1`）；发送前后前台窗口全程停在 ZCode（未被抢走）。**未验证**：其它渠道（WhatsApp/云网关）的发送状态时序——`received` 现在按"仍在途中"处理。本机验证使用了自签的本地会话令牌，用完已删除；CodeGraph CLI 本机未安装，本次定位用 `rg` + 定向读取。
- 待办：**①「我的」显示已归档会话是按"所有我曾处理过的会话"实现的**——归档路径本来就保留认领关系，"只显示进行中、归档时保留 pool_type/claimed_by"那套改法在当前代码上没有落点；若本意是只显示进行中，需回退 `routes/conversations.js` 里 private 的归档豁免。**②重试会新增一条 `plat_messages` 行**（`sendOutboundMessage` 每次发送都 INSERT），所以重试后库里是"一条失败 + 一条成功"、刷新后旧气泡仍是红的；要"重发同一行"需后端支持。**③`currentConversationRegistry` 只增不减**：节点离线后最后登记的那条会被 TTL 永久豁免归档，需在节点断开时清理。

### 2026-09-28 — 飞鸽出站发送打通（桌面桥接）
- 改动：节点新增 `message.send` 指令执行（写入飞鸽输入框 + 点发送）；前端抖音解除只读；发送路由新增 `desktop_bridge` 分支**放在云网关之前**（此前账号虽是 `desktop_bridge`，发送却按渠道解析到官方适配器，报"发送到 WhatsApp 失败 + 抖店未提供 API"，这就是渠道污染）；错误文案不再硬编码 WhatsApp。
- 位置：`Rag/tools/feige-uia-probe/{bridge_node.py,feige_send.py}`、`Rag/rag-server/src/{routes/conversations.js,modules/channel-adapters/desktop-bridge/desktopBridgeAdapter.js,modules/desktop-bridge/bridgeCommandService.js}`、`Rag/platform-web/src/views/PlatformMessages/PlatformMessagesView.vue`。
- 验证：**真实发送成功**（节点日志 `发送成功 d49dca5d（invoke）`，客户实际收到）。**未验证**：状态回报准确性（见下条修复后未复测）。
- 待办：发送会把飞鸽窗口拉到最前（`InvokePattern.Invoke()` 的副作用，采集侧无此调用）；乐观更新未做。

### 2026-09-28 — 发送链路三处修复（指令 id / 状态回报 / 超时）
- 改动：①`commandId` 改从**信封层**读取（协议里它与 `payload` 平级，原来读 payload 拿到 None，节点从不回报状态）；②`commandStatusService` 改为 `{ handle: bridgeCommandService.handleStatus }`（网关调 `handle`，直接传对象会因 `handle` 为 undefined 而**静默丢弃状态回报**，表现为"消息已发出但程序显示超时失败"）；③`local_message_id` 是 NOT NULL，调用方没给时用 commandId 兜底，并由路由传入真实消息 id；④命令超时 20s → 60s（节点实测需 10s）。
- 位置：`Rag/rag-server/src/{app.js,routes/conversations.js,modules/desktop-bridge/bridgeCommandService.js}`、`Rag/tools/feige-uia-probe/bridge_node.py`。
- 验证：后端 572 测试通过。**未验证**：完整发送一次并确认界面显示"成功"（修复后尚未复测）。
- 待办：复测成功后做乐观更新（位置 `ChatWindow.vue:709 handleSend`）。

### 2026-09-28 — 消息时间与顺序修正（时区 + 排序）
- 改动：①`created_at` 改用**页面上消息的真实时间**并按批次加毫秒偏移——界面按 `ORDER BY created_at DESC, id DESC` 排序，原先用入库时刻会让整屏消息挤在同一秒、再按随机 UUID 兜底 → **顺序全乱**；②入站时间差 8 小时（`16:35+08:00` 被存成 `08:35`）：`processIncomingMessage` 自己按 UTC 写，而我的校正 UPDATE 依赖它的返回值 `messageId`（实际是 undefined，UPDATE 从未执行）。改为按 `channelMessageId` 定位 + 直接传本地时间字符串，不经过 Date 的时区转换。
- 位置：`Rag/rag-server/src/modules/desktop-bridge/inboundBridgeService.js`、`Rag/tools/feige-uia-probe/bridge_node.py`（payload 带 `batchIndex`）。
- 验证：清库重采 9 条，时间本地化正确、严格递增、方向与页面交替顺序一致。
- 待办：无。

### 2026-09-28 — 表情按标签、商品卡只留名字与售价（不再截图）
- 改动：①表情（`[抱紧自己]` 这类方括号标签）**只用标签文字、不截图**；②商品卡**识别但同样不截图**，只保留**名字 + 售价**，剔掉保障/优惠/物流/按钮等噪音（售价在元素树里拆成 `￥`/`252`/`.`/`00` 四个节点，需拼接还原）；③修正媒体判定——原按 `content_length<=4` 会把 `不会`/`转人工` 这类短消息误判成表情，改按方括号标签。
- 位置：`Rag/tools/feige-uia-probe/{feige_extract.py,bridge_node.py}`。
- 验证：实测分类正确（8 条消息中文本/表情/商品卡各归其位），商品卡抽出 `名字='孤勇者玻璃隔热镀膜喷剂…' 售价='￥252.00'`。
- 待办：无。

### 2026-09-28 — 截图能力弃用（坐标系陷阱）+ 头像改用昵称首字
- 改动：①**发现坐标系陷阱**：UIA 的 `BoundingRectangle` 在窗口**可见**时是绝对屏幕坐标，**最小化**时变成相对窗口坐标，而截屏 API 永远要绝对坐标——把相对值当绝对值用会截到无关内容（实测截到灰色渐变）。加了守门：窗口不可见/最小化时**拒绝截图**；②头像截图**关闭**，改用昵称首字（前端 `getConversationAvatarText` 本来就是取显示名首字）；③表情与商品卡截图一并取消，**节点现在完全不做截屏**。
- 位置：`Rag/tools/feige-uia-probe/{feige_capture.py,bridge_node.py}`。
- 验证：窗口最小化时正确跳过并提示；`user_avatar` 为 null 时前端显示首字。
- 待办：无。

### 2026-09-28 — 会话释放改为归档、3 分钟过期归档
- 改动：①「释放」不再进公共池（该池已从界面移除），改为**直接归档**；②新增 `bridgeExpiryService`：douyin 会话 **3 分钟无消息活动即归档**，与飞鸽客户端行为一致。实现上**不加字段、不写重置逻辑**——过期时间由 `conversations.last_message_time + TTL` 派生，任何一方（客户/AI/我方）发消息都会自然刷新；③清理了 2 条孤儿 `desktop_bridge_bindings`（删账号时未联动清理）。
- 位置：`Rag/rag-server/src/{app.js,modules/desktop-bridge/bridgeExpiryService.js}`、`Rag/platform-web/src/components/{Chat/ChatWindow.vue,Conversation/ConversationList.vue}`。
- 验证：后端 572 / 前端 162 测试通过；启动日志 `[BridgeExpiry] 已启动：douyin 会话 idle > 3 分钟即归档`。
- 待办：**删除渠道账号时应联动删除其桥接绑定**（现在会留孤儿）；会话右侧显示飞鸽的等待倒计时（需先读其文本格式，只在列表切「等待时长」排序时出现）；按"倒计时消失即归档"细化归档（当前用 3 分钟近似）。

### 2026-09-28 — 关闭 AI 推荐回答（默认）
- 改动：`suggestionStreamHandler` 增加 `AI_SUGGESTION_ENABLED` 开关，**默认关闭**，未启用直接返回 503 不调用模型。原因：未配置模型凭据时每次请求都抛 `InvalidCredentials` 并刷错误日志，而它会被新消息触发，噪音大还掩盖真实问题。
- 位置：`Rag/rag-server/src/modules/rag/rag.routes.js`。
- 验证：重启后灌入新消息，`backend.err.log` 完全为空（噪音消失）。
- 待办：配置 `DASHSCOPE_API_KEY`（或阿里云 key）后设 `AI_SUGGESTION_ENABLED=true` 即可启用。

### 2026-09-28 — 飞鸽消息正文污染修正（署名 / 角色标签 / 控件文案）
- 改动：①**本店署名此前被并进正文**（`孤勇者隔热材料\n你好`），改为从数据里**学出**署名（跨消息块出现最多的非角色标签短文本——窗口标题是"孤勇者**科**隔热材料"而消息署名是"孤勇者隔热材料"，字符串匹配对不上），并从正文剔除；②署名/角色标签在块根下**第 3 层**（前有两层未命名包装），限深 3 层且不限控件类型才能取到；③方向判定优先按署名，空缺时**默认客户**（原保守设为 out 会把 `No`/`我会被晒黑吗` 这类客户消息全丢掉）；④消息块限定在 `workspace-chat` 容器内并加控件词黑名单——此前把界面统计挂件当消息采进去了（`飞鸽平均响应时长\n48\n秒\n店\n1\n今日接待人数…`）。
- 位置：`Rag/tools/feige-uia-probe/feige_extract.py`。
- 验证：实测 `in 5 / out 5 / system 3` 逐条正确，正文干净。
- 待办：无。

### 2026-09-28 — 商家消息独立入库 + 桥接会话默认入 AI 池
- 改动：①商家在客户端手工回复的消息此前被**主动跳过**（`processIncomingMessage` 把 `direction` 硬编码为 `inbound`，走它会把商家消息写反）；新增 `persistOutbound` 按 `outbound/agent` 落库，节点不再跳过 out/system；②桥接会话默认归 AI 池（`ai_self/ai_serving`），仅 `pending_claim` 且无人认领时迁移，不抢人工正在处理的会话。
- 位置：`Rag/rag-server/src/modules/desktop-bridge/inboundBridgeService.js`、`Rag/tools/feige-uia-probe/bridge_node.py`。
- 验证：清库重采后 `outbound/agent` 正确落库，会话为 `ai_self/ai_serving`。
- 待办：无。

### 2026-09-28 — 归档规则改为以「当前会话」为准
- 改动：`accountSnapshotService` 不再扫会话列表，改用节点上报的 `currentCustomerKey`（顶栏 `topbar-left-info`，是当前会话的权威来源）——不是当前会话的归档，重新成为当前会话的拉回 AI 池。**读不到当前会话时什么都不做**，绝不当成"没有会话"（否则一次误判会清空所有会话）。原列表方案会把聊天区的消息行误认成会话项、算出错的键，导致真会话被误归档。
- 位置：`Rag/rag-server/src/modules/desktop-bridge/accountSnapshotService.js`、`Rag/tools/feige-uia-probe/bridge_node.py`。
- 验证：后端 572 测试通过。
- 待办：**需实测**——归档/恢复在真实会话切换下的表现尚未验证。

### 2026-09-25 — 管理员一键重启后端
- 改动：用户下拉菜单新增仅管理员可见的“重启后端”，包含二次确认、重启中锁定、进程 PID 恢复检测和持久错误提示；后端通过独立 Windows 脚本安全拉起新进程，启动器会在源码更新后自动重建前端。
- 位置：`Rag/platform-web/src/components/Layout/AppHeader.vue`、`Rag/platform-web/src/api/systemControl.js`、`Rag/rag-server/src/routes/systemControl.js`、`Rag/tools/local-deploy`。
- 验证：后端 540 项、前端 152 项、前端生产构建、两个 PowerShell 脚本的语法与 dry-run、Premium UI 严格审计均通过。
- 待办：无。

### 2026-09-25 — 同时开放本机与局域网工作台入口
- 改动：Vite 预览服务改为监听 `0.0.0.0:3003`，启动完成和状态命令同时显示本机 `LocalUrl` 与局域网 `LanUrl`，并额外打印两个工作台入口。
- 位置：`Rag/tools/local-deploy/start-local-platform.ps1`、对应测试、`ops/Platform.Common.ps1`、`ops/Start-Platform.ps1`、`ops/Get-PlatformStatus.ps1`、README。
- 验证：部署 dry-run、启动 dry-run、PowerShell 语法、状态表双地址输出和 CodeGraph 审查通过。
- 待办：新电脑拉取后结束旧前端进程并重新启动一次，使新的监听地址生效。
### 2026-09-28 — 飞鸽入库昵称、归档按会话列表、去掉公共/长期池
- 改动：①节点上报**真实客户昵称**（此前填的是消息发送者标签，客户消息会回落到字面量"客户"，且被脱敏，导致界面认不出客户）；②新增 `accountSnapshotService`，按"会话是否仍在客户端当前列表"维护归属——**消失即归档、重现即从归档拉回 AI 池**，通道用协议里既有但一直被忽略的 `account.snapshot`；③会话列表移除「公共池」「长期跟进」两个 Tab（当前单店单客服不涉及）。
- 位置：`Rag/tools/feige-uia-probe/{feige_extract.py,bridge_node.py}`、`Rag/rag-server/src/modules/desktop-bridge/{accountSnapshotService.js,bridgeGateway.js,index.js}`、`src/app.js`、`Rag/platform-web/src/components/Conversation/ConversationList.vue`。
- 验证：后端 `npm test` **568/568**、前端 **158/158**、前端 build 通过。昵称取源改为顶栏 `topbar-left-info`，实测得到 `呓🐟`（与输入框占位符"发送给 呓🐟"互相印证）。**更正**：本条先前把"会话列表项"启发式取到的 `我会被晒黑吗` 记为昵称，实为**客户发的消息正文**——该启发式会把聊天区的消息行（头像+文本+时间）误认成会话列表项，已弃用并加注释。
- 待办：**出站发送尚未接通**（`bridgeCommandService`/`desktopBridgeAdapter` 已就位，但 `bridge_node.py` 还没处理 `message.send` 帧，前端抖音仍标只读）；**正文仍混入发送者署名与角色标签**（实测 `孤勇者隔热材料\n你好`、`系统消息\n我们是玻璃纳米…`），且部分本店发出的消息被方向判定为 `in`、会当作客户消息入库——**修好前不应继续采集**；`pool_type` 的 `public`/`long_term` 后端取值保留未删。

### 2026-09-25 — 飞鸽桌面桥接打通消息通路（阶段二）
- 改动：把 Desktop Bridge 真正接进主系统——`app.js` 挂载 WSS 网关（`BRIDGE_ENABLED=true` 开关）、新增 `inboundBridgeService` 把 `message.inbound` 接入既有 `processIncomingMessage`（复用其 `channelMessageId` 去重与会话创建）、新增 `POST /api/v1/desktop-bridge/provision` 与 `GET /nodes`、新增常驻节点 `bridge_node.py`（hello→ready→取租约→轮询→上报→心跳续租）、补上 `bridgeRepository.provisionNode` 与 `leaseService.reclaim`。修复 A5 会话键缺陷（`bridge_adapter.py` 原先只按店铺名派生，多客户会共用同一指纹）。
- 位置：`Rag/rag-server/src/{app.js,routes/desktopBridge.js,modules/desktop-bridge/*}`、`Rag/tools/feige-uia-probe/bridge_node.py`。
- 验证：**端到端实测通过** —— 节点连上 `/bridge/v1`、`node.ready` 下发账号与租约、3 条客户消息经 WS 落库为 `conversations` 1 行（unread=3）+ `plat_messages` 3 行（全 `direction=inbound`、`sender_type=customer`）；**重复上报后仍为 3 条，证明 `channelMessageId` 去重生效**。后端 `npm test` **568/568 通过**（新增 12 项），前端 158/158。
- 待办：**商家自己发出的消息（客户端里手工回复的）尚未入库** —— `processIncomingMessage` 把 `direction` 硬编码为 `inbound`（`messaging.service.js:594`），走它会把商家消息写成语义相反的 inbound，因此节点当前**主动跳过** out/system 消息（日志会打印跳过条数），需要单独的入库路径；`bridgeGateway` 的 `handleFrame` 捕获异常后只 `closePolicy` **不写日志**，协议校验失败表现为"连接莫名关闭"，排查时先看关闭码。

### 2026-09-25 — 账号列表移除「今日配额」展示与建号表单的每日上限
- 改动：账号列表去掉「今日配额」列，添加账号对话框去掉「每日事件上限」输入。原因是该配额只被促销活动模块（批量私信/评论承接/关键词触发）消费，与客服自动回复无关；且 `daily_quota` 在后端**从无重置逻辑**，名为"今日"实为终身累计；桌面桥接账号更是永远用不到（`bridgeCommerceAdapter.sendMessage()` 恒返回 `bridge_required`）。后端仍按默认值 1000 写入 `max_daily_quota`，行为不变。
- 位置：`Rag/platform-web/src/views/Settings/AccountManage.vue`（表格列、表单项、孤立的 `.quota-value` 样式）。
- 验证：前端 `npm test` **158/158 通过**、`npm run build` 成功；确认无 `quota-value` / `今日配额` / `每日事件上限` 残留引用，`maxDailyQuota: 1000` 仍保留在表单状态与提交负载中（后端收到的值不变）。`account-meta` 样式仍被其它 8 处使用，未一并删除。
- 待办：`daily_quota` 无重置任务的问题仍然存在（促销活动模块的既有限制）。若将来需要按日重置，需另加定时任务。

### 2026-09-25 — 抖店账号新增「本地桌面客户端」接入方式（阶段一）
- 改动：在添加渠道账号对话框为抖音增加「接入方式」选择（官方 API / 本地桌面客户端）。选后者时不需要 App Key，改为【自动检测】——后端调用只读探针读取本机飞鸽，一键建号。建号时**同事务写入 `desktop_bridge_bindings`**，补上了此前完全缺失的绑定写入路径（缺绑定则 `leaseService.acquire` 必然抛 `ACCOUNT_NOT_BOUND`）。
- 位置：`Rag/tools/feige-uia-probe/detect.py`（新增，单行 JSON + 冷启动预热）、`Rag/rag-server/src/modules/channel-adapters/desktop-bridge/`（配置校验）、`src/modules/desktop-bridge/bridgeRepository.js`（`upsertBinding`，新增）、`src/routes/channelAccounts.js`（`connection_mode` 分支 + `POST /detect-desktop`）、`Rag/platform-web/src/modules/channels/desktopBridgeAccountForm.js`、`src/views/Settings/AccountManage.vue`、`src/api/channels.js`。
- 验证：后端 `npm test` **556/556 通过**（基线 536 + 新增 20）；前端 `npm test` **158/158 通过**且 `npm run build` 成功；`detect.py` 实测输出正确 JSON（店铺名、状态、会话数、机器指纹），并验证从任意 cwd 按绝对路径调用可用（模拟后端 execFile）。
- 待办：**运行中的后端尚未重启**，`node src/app.js` 无热重载，新接口需重启后生效（`POST /api/v1/channel-accounts/detect-desktop` 目前在鉴权前置中间件后返回 401，无法用它判断路由是否已加载）。阶段二（消息通路：`initDesktopBridge` 接线、`inboundBridgeService`、`bridge_node.py`、以及 A5 会话键缺陷）待阶段一验收后再做。

### 2026-09-25 — 飞鸽集成：接缝单元测试 + 测试清单
- 改动：新增桥接适配器与协议校验器，打通「抓取端 → 桥接协议」接缝；新增可供人工逐条执行的集成测试清单。
- 位置：`Rag/tools/feige-uia-probe/bridge_adapter.py`、`validate_envelope.js`、`TEST-PLAN-feige-integration.md`。
- 验证：适配器把 6 条真实消息转成 `message.inbound` 负载，用项目自带 `bridgeProtocol.js` 的 zod schema 校验 **6/6 通过**（含 `eventId` UUID、带时区 `clientTimestamp`、媒体声明）。**实测发现协议缺口**：`media.type` 枚举只有 `image|video|audio|file`，无 `sticker`，表情须声明为 `image` 并靠 `platformPayload.placeholder` 标注真实语义。
- 待办：**后端未接线** —— `Rag/rag-server/src/app.js` 完全未引用 `desktop-bridge`，需调用 `initDesktopBridge({httpServer, sequelize, eventEmitter})` 并提供 `inboundService` 才能跑端到端；适配器会话键当前只由店铺名派生，换客户会撞车，需改为按客户或 `wrap_persist:<id>` 派生。

### 2026-09-25 — 首次启动自动构建本地包
- 改动：启动器按协议包、投影账本、后端的依赖顺序自动补装并构建本地 TypeScript 包；发现后端已安装副本缺少 `dist/index.js` 时自动刷新依赖并验证产物。
- 位置：`ops/Platform.Common.ps1`、`ops/Start-Platform.ps1`、`ops/Start-Platform.test.ps1`、`ops/README.md`、`README.md`。
- 验证：两个本地包真实构建、后端模块解析、启动 dry-run、PowerShell 语法与 CodeGraph 审查通过。
- 待办：在发生过 `MODULE_NOT_FOUND` 的新电脑拉取后重新运行一键启动，确认自动恢复完整链路。

### 2026-09-25 — 保留离线文件目标目录
- 改动：为 Docker 安装包、MySQL 镜像和 Redis 镜像目录加入可追踪占位文件，并细化忽略规则，确保全新克隆后目录存在但二进制大文件仍不会进入 Git。
- 位置：`.gitignore`、`offline/docker/.gitkeep`、`Rag/docker/mysql/images/.gitkeep`、`Rag/docker/redis/images/.gitkeep`、`README.md`。
- 验证：三个占位文件可追踪、安装包和镜像文件仍被忽略；启动 dry-run 与 CodeGraph 审查通过。
- 待办：新电脑拉取后将三个网盘文件直接放入已创建的目标目录。

### 2026-09-25 — 固定 Docker 离线包位置
- 改动：启动器改为只检查和导入指定位置的 MySQL/Redis 离线镜像，不再联网拉取；新增 Docker Desktop 安装包固定路径，并在 README 写入网盘链接、提取码、目录结构和镜像校验值。
- 位置：`ops/Platform.Common.ps1`、`ops/Start-Platform.ps1`、`ops/Start-Platform.test.ps1`、`ops/README.md`、`README.md`、`.gitignore`。
- 验证：启动脚本 dry-run、PowerShell 语法、CodeGraph 改动审查、Markdown 链接和离线下载信息检查通过；启动器已加入镜像 SHA-256 校验。
- 待办：在全新 Windows 电脑按 README 放置三个离线文件并完成首次启动实测。

### 2026-09-25 — 新电脑首次启动自举
- 改动：缺少本地环境文件时自动从模板创建并生成机器独立密钥；缺少 Node 依赖时自动安装；离线 Docker 镜像不存在时改为联网拉取；自动生成本地网关 Token。
- 位置：`ops/Platform.Common.ps1`、`ops/Start-Platform.ps1`、`ops/Start-Platform.test.ps1`、`README.md`。
- 验证：启动脚本 dry-run、临时目录首次初始化与防覆盖测试、PowerShell 语法检查通过。
- 待办：在全新 Windows 克隆环境执行完整首次启动，确认 Node 包下载和 Docker Hub 网络可用。

### 2026-09-25 — 飞鸽发送通路实测（首个写操作）
- 改动：新增隔离的发送模块 `send_probe.py`（默认 dry-run，`--confirm-send` 才真正发送，写入后回读校验不一致即中止，单发不重试）。对真实客户实测发送成功。
- 位置：`Rag/tools/feige-uia-probe/send_probe.py`、`REPORT-feige-uia-probe.md`（「附：发送通路验证」一节）。
- 验证：发送「你好 我是一个人工智能客服」→ 输入框由 13 字符清空为 0、消息列表由 5 条增至 7 条、新消息块原文逐字一致（`孤勇者隔热材料` 署名 + 13 字符正文 + `10:26:39` + `未读`）。机制为 `ValuePattern.SetValue` + `InvokePattern`（不用 SendKeys，避免抢前台与误击）。只读探针 `selfcheck` 仍 PASS（写操作已隔离）。
- 待办：**已知缺陷** —— 人工点击发送的消息，正文会多出店铺署名（实测 13 字符记成 21），发送者回落为"客户"；该类消息署名节点是 `GroupControl` 而非 `TextControl`，需单独规则修复（放宽为「任何有名字的直接子节点」会误伤其它消息块，已回退）。另发现媒体消息（表情/图片）在树中只有占位文本如 `表情`，真实内容不可读，`media` 字段尚无来源。

### 2026-09-24 — 飞鸽采集：预热期量化与结论收敛
- 改动：把无障碍树的"预热期"从定性观察量化为实测结论 —— **仅冷启动需要预热**（首次启用 a11y 时异步构建，约 15 秒）；启用后静置 60 秒再附加仍第一次读取即完整，120 秒内节点数恒定。新增 `measure.py`（`warmup` 预热测量 / `convlist` 会话项结构诊断）。
- 位置：`Rag/tools/feige-uia-probe/measure.py`、`REPORT-feige-uia-probe.md` 第 6.4 节。
- 验证：`measure.py convlist` 确认会话项解析数与界面实际一致（此前报 2 是预热期瞬时状态，稳定后为 1）；`measure.py warmup` 三次场景实测（冷启动约 15s / 新进程附加 2.5s 即完整 / 静置 60s 后仍即完整且 120s 稳定）。
- 待办：真实新消息端到端识别、历史消息保留上限、多会话与多店铺切换、`wrap_persist:<id>` 能否作稳定会话 ID。

### 2026-09-24 — 飞鸽采集字段加固（发送者归属 / 会话列表 / 指纹锚点）
- 改动：按实测消息块结构重写字段提取 —— 发送者归属改为结构性判定并落盘判定依据（`direction_basis`）；会话列表改为按结构定位，未读徽标只在左支查找；富媒体消息指纹改为锚定最长单个内容节点。并识别出 Chromium 无障碍树的**异步预热期**。
- 位置：`Rag/tools/feige-uia-probe/feige_extract.py`、`analyze_ext.py`、`diagnose_tree.py`、`feige_probe.py`（dump 扩展属性）、`analyze_tree.py`、`REPORT-feige-uia-probe.md`。
- 验证：5 轮 × 6 条真实消息指纹**跨轮稳定**，账本 6 条、30 次读取拦下 24 次重复；发送者归属实测正确（客户提问→`in`、AI 回复→`out 角色标签=智能客服`、商家配置发送→`out 发送方说明=商家配置发送`）；会话数由虚高的 8 纠正为 1，与页签 `当前会话(1)` 一致。**未验证**：真实新消息端到端识别、历史消息保留上限、多店铺切换、预热期时长的量化。
- 待办：桥接端落地预热判定（建议「连续两次读取总节点数一致」才开工）；确认 `wrap_persist:<id>` 是否可作稳定会话 ID；统一分钟级与秒级时间戳的补全策略。

### 2026-09-24 — 飞鸽 UI Automation 只读探针（结论修正）
- 改动：新增飞鸽只读采集探针并实测；**确认完整聊天数据可读**——店铺名、客服状态、会话列表（含未读徽标）、客户昵称、当前会话的发送者/时间/正文/已读状态全部可读。关键修复：必须附加到子窗口 `Chrome_RenderWidgetHostHWND`，附加到顶层 `Chrome_WidgetWin_1` 只能得到空树。
- 位置：`Rag/tools/feige-uia-probe/`（`feige_extract.py`、`feige_probe.py`、`win_enum.py`、`deep_probe.py`、`a11y_matrix.py`、`surface_probe.py`、`map_fields.py`、`diagnose_fp.py`、`profiles/`、`REPORT-feige-uia-probe.md`）。
- 验证：`selfcheck` AST 只读自证 PASS；从渲染宿主附加实测 630 节点/168 文本节点/158 文本叶子；8 条真实消息带绝对时间戳解析成功；指纹 3 轮去重拦下 14 次重复写入。**证伪**：早期"窗口被遮挡导致读不到"的结论是错的（遮挡率 0.029 时仍为空），且不需要前台焦点。**未验证**：真实新消息端到端识别、历史消息保留上限、多店铺切换。
- 待办：加固四项后才可接入 —— 会话列表字段切分（现会把商品卡价格 `¥260` 误判为未读徽标）、发送者归属补全（8 条中 5 条 unknown）、富媒体消息指纹锚定（商品卡正文长度三读抖动 ±1~3 字符）、确认 `wrap_persist:<id>` 能否作稳定 ID。

### 2026-09-24 — 根目录项目说明
- 改动：新增面向公开仓库的根目录 README，说明当前模块、启动迁移、敏感信息边界、测试基线和飞鸽 Desktop Bridge 的真实完成度。
- 位置：`README.md`、`AGENTS.md`。
- 验证：通过 CodeGraph 核对主应用入口、包版本、平台过滤与 Desktop Bridge 引用关系；确认当前后端主入口尚未初始化 Desktop Bridge。
- 待办：在飞鸽 Windows 电脑完成只读探针后，再更新聊天采集能力说明和部署步骤。

### 2026-09-24 — GitHub 源码同步准备
- 改动：新增根目录忽略规则与本地迁移清单，保留并排除真实环境配置、密钥、运行数据、客户附件、日志和大型离线依赖。
- 位置：`.gitignore`、`LOCAL_MIGRATION_CHECKLIST.md`。
- 验证：待提交文件清单与敏感信息扫描将在首次 Git 提交前完成；本地敏感文件未移动或删除。
- 待办：创建私有 GitHub 仓库并在飞鸽电脑重新配置必要的本地环境。

### 2026-09-24 — 多租户云端控制平面第一版
- 改动：新增运营后台、客户账户中心、租户/设备身份、企业微信安装登记和可审计 Token 额度账本，并部署受限 systemd 服务。
- 位置：`wehook/src/saas`、`wehook/cloud-console`、`wehook/ops`、`SYSTEMS.md`。
- 验证：网关 50 项测试、Node 静态检查、Premium UI 严格审计和服务器 localhost 健康检查通过；公网 HTTPS 因未备案域名的 HTTP-01 被 403 拦截尚未完成。
- 待办：备案生效后签发 `admin/account/api` 证书并启用 Nginx；接入正式企业微信第三方应用与模型代理前另做凭据联调。

### 2026-09-23 — Agent 工作方式与 CodeGraph 范围
- 改动：新增本操作手册，并通过 `codegraph.config.json` 排除依赖、构建产物、日志、缓存和历史审计目录。
- 位置：`AGENTS.md`、`codegraph.config.json`。
- 验证：CodeGraph 配置解析与小范围索引检查通过。
- 待办：后续每轮功能改动完成后在本节顶部追加记录。

### 2026-09-23 — 单机唯一管理员第一阶段
- 改动：增加首次管理员初始化，默认关闭公共注册，单账号模式隐藏并封锁系统账号管理，提供本机密码恢复入口。
- 位置：`Rag/rag-server/src/routes/auth.js`、`Rag/rag-server/src/modules/system-accounts`、`Rag/platform-web/src/views/Login`、`reset-admin-password.bat`。
- 验证：后端 536 项、前端 148 项通过；`admin` 登录、注册 403、单账号管理 403 的真实接口检查通过。
- 待办：离线授权、团队账号与渠道容器按需启动见商业化 README。

### 2026-09-23 — 一键启动与可迁移基础设施
- 改动：统一 BAT/PowerShell 启动流程，Docker Desktop 未启动时自动等待；MySQL 与 Redis 使用项目内离线镜像。
- 位置：`start-all.bat`、`ops`、`Rag/docker/mysql`、`Rag/docker/redis`。
- 验证：MySQL、Redis、网关、后端和前端均已在本机启动并通过端口检查。
- 待办：WAHA 不进入主启动链路，后续在 WhatsApp 接入页面按需启动。

### 2026-09-23 — 系统拆分与重构基线
- 改动：划分主系统、独立官网、暂停维护旧前端和实验 PoC，确定逐系统测试顺序。
- 位置：`SYSTEMS.md`、`REFACTOR_BASELINE_2026-09-23.md`。
- 验证：网关、后端和前端基线测试已建立；真实平台与专用环境集成测试仍单独执行。
- 待办：按 `SYSTEMS.md` 的顺序逐系统测试和重构。

### 2026-10-13 — 拼多多客服聊天打通（视觉读取→平台入库，端到端实测）
- 改动：①`pdd_reader.py` 适配客服工作台布局（左侧按状态分组：待回复/已超时/夜间待成交/已被自动回复/已回复；分组容错匹配；面板 3x 裁剪放大 OCR 提升小字识别）；②`bridge_node.py` 新增拼多多读取线程（PDD_READER_ENABLED/PDD_READER_INTERVAL_SECONDS），产出走既有 WS `message.inbound`（字段：platformCustomerId=会话键、direction in/out、指纹 channelMessageId）；③服务端注册 `pinduoduo → pinduoduo.workbench` 适配器；④新增 `scripts/create-desktop-bridge-account.js`（渠道通用建号脚本，账号 id=5 已建 + 绑定）。
- **重要运维发现**：本机有两份项目副本——`E:\平台建设\guyong-platform`（开发仓库，平时在跑）与 `E:\BaiduNetdiskDownload\孤勇者_客服平台\project`（旧快照，今天 13:55 被启动占用全部端口）。已停掉旧副本服务、用仓库版重新启动平台（3001/3003/8787 均为仓库进程）。
- **关键踩坑**：①`message.inbound` 的 `clientTimestamp` 为空时传了 `null` → 协议 `optional` 不允许 null → INVALID_ENVELOPE → 网关直接断开连接（表现为"上报后连接必断、消息不落库"）；改为缺省省略字段。②读取器误点左侧图标导航会把客户端切走模块（实测切到推广/应用中心）——已加保护：识别不到客服分组面板时**不做任何点击**，点击范围限制在会话项区域（0.045~0.23W）。③WinRT `GetFileFromPathAsync` 不接受相对路径（报"Wait 时发生异常"，易误判为 OCR 故障），`ocr_image` 已统一转绝对路径。
- 验证：**端到端实测通过**——真实客户会话"超***"（消息：转人工 / 你好,在吗老板? / 我方回复 你好 / 在呢）被读取并上报；DB 出现 pinduoduo 会话（账号 5，ai_serving）与 5 条 plat_messages（inbound/outbound 正确）；节点日志确认 `node.ready 下发 2 个账号（含 pinduoduo.workbench）` 即渠道连接成功。
- 待办：①**消息解析精修**（会话名取了 OCR 提示文字"添加备注信息"而非客户名"超***"——星号掩码名 OCR 难；横幅/底部提示/系统提示混入消息——需按气泡区域细化过滤）；②读取线程偶发 `OverflowError: int too long to convert`（捕获后继续，未定位）；③**C 盘仅剩 3.1GB（99%）**需清理；④回复发送（平台→客户端）未接；⑤AI 池中该会话的机器人回复链路未验证。

## 2026-10-19 索引归档

- 2026-10-10 公司联系方式拒答提示词修正与百炼五条来源诊断：[排查与验证](docs/changes/2026-10-10-grounded-company-contact.md)。
