# 飞鸽 UI Automation 只读探针

用于 Desktop Bridge 的采集可行性验证与字段提取：飞鸽（抖店工作台，Electron/Chromium +
webview 嵌套文档）能否通过 Windows UI Automation 读到店铺、会话列表、未读状态与消息正文。

**完整检测结论见 [`REPORT-feige-uia-probe.md`](REPORT-feige-uia-probe.md)。**

> **结论**：飞鸽的完整聊天数据**可以**通过 UI Automation 读取。店铺名、客服状态、会话列表
> （含未读徽标）、客户昵称、当前会话的发送者/时间/正文/已读状态全部可读，实测单次读取拿到
> 630 节点 / 168 文本节点。**不需要窗口置顶，也不需要 OCR。**

## 最重要的一条：附加目标

**必须附加到子窗口 `Chrome_RenderWidgetHostHWND`（Chromium 的 "Chrome Legacy Window"），
不要附加到顶层 `Chrome_WidgetWin_1` 窗口。**

| 附加目标 | 节点数 | 文本节点 | 结果 |
| --- | --- | --- | --- |
| 顶层 `Chrome_WidgetWin_1` | 7 | 1 | 只有空的 PaneControl 链 |
| 子窗口 `Chrome_RenderWidgetHostHWND` | **630** | **168** | **完整飞鸽 UI** |

主窗口走 Direct Composition 渲染路径，渲染宿主 HWND 是隐藏的，顶层窗口的 UIA 提供程序
不把内容链接进来；但渲染宿主自身有独立的 UIA 提供程序，直接附加即可拿到完整树。

定位方式：

```
EnumWindows  → class=Chrome_WidgetWin_1 且标题匹配 ^\[商家\]
EnumChildWindows(main) → class=Chrome_RenderWidgetHostHWND
ControlFromHandle(render_host_hwnd)
```

`feige_extract.py` 已封装为 `resolve_render_host()`。

## 只读保证

本目录所有脚本只做**读取**：

- 只用 UIA 读取能力（属性、TextPattern.GetText、ValuePattern.Value）与 Win32 查询类 API；
- 不调用 Invoke / Toggle / Select / SetValue 等变更类 Pattern，不点击、不输入、不发送；
- **不触碰 `im-input-box`**（输入框，已识别其 automation_id 并显式排除）；
- 不 OCR、不截图、不注入进程、不读进程内存、不抓包；
- 不读取密码、Cookie、登录态或客户端本地数据库；
- 不改窗口状态（不 `SetForegroundWindow` / `ShowWindow` / `SetWindowPos`）。

`python feige_probe.py selfcheck` 用 AST 扫描真实调用点自证，期望输出 `"verdict": "PASS"`。

## 依赖

```powershell
python -m pip install uiautomation
```

需要 Python 3.9+，以及正在运行的抖店飞鸽客户端。

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `feige_extract.py` | **主提取器**：渲染宿主解析 + 店铺/客服状态/会话列表/消息提取 + 指纹 + `dedupe`/`watch` |
| `feige_probe.py` | 基础探针：`selfcheck` / `discover` / `dump` / `snapshot` / `report` |
| `win_enum.py` | Win32 只读窗口枚举（进程、顶层窗口、子窗口、z 序）。**定位句柄从这里开始** |
| `deep_probe.py` | 对比从顶层 / 渲染宿主附加的结果，验证正确附加目标 |
| `a11y_matrix.py` | 可读性 × 遮挡率矩阵 |
| `surface_probe.py` | 悬浮小组件 / 消息浮窗的字段提取与指纹验证 |
| `map_fields.py` | 按 automation_id 打印子树，字段映射用 |
| `analyze_tree.py` | 元素树结构分析，`--raw` 打印未脱敏文本 |
| `diagnose_fp.py` | 指纹漂移逐条诊断 |
| `profiles/doudian_feige.json` | 采点配置。`verified` = 已实测，`unverified` = 尚未确认 |

## 用法

```powershell
cd Rag\tools\feige-uia-probe

# 0. 只读自证
python feige_probe.py selfcheck

# 1. 定位窗口
python win_enum.py

# 2. 验证渲染宿主才是正确附加目标（对比两次附加的节点数）
python deep_probe.py

# 3. 读取全部字段
python feige_extract.py read

# 4. 指纹稳定性与去重
python feige_extract.py dedupe --rounds 3 --interval 2
python diagnose_fp.py              # 定位是哪条消息在漂移

# 5. 监听新消息
python feige_extract.py watch --seconds 60 --interval 2

# 6. 探索元素树
python feige_probe.py dump --hwnd <渲染宿主句柄> --raw --out raw/tree_raw.json
python map_fields.py raw/tree_raw.json --list-aids
python map_fields.py raw/tree_raw.json --aid chantListScrollArea --depth 6
```

## 重要使用注意

1. **不要用遍历 UIA 根子节点的方式找窗口。** 会对上百个无关窗口逐个读属性并长时间阻塞。
   先 `win_enum.py` 拿 HWND，再按句柄附加。
2. **窗口最小化或隐藏时读不到；被其他窗口覆盖不影响；不需要前台焦点。**
3. **排序必须用文档顺序（树序），不能用屏幕坐标。** 未布局的消息节点 `rect` 是 `@0,0 0x0`，
   但它们在树里、内容可读——历史消息不依赖滚动。代价是几何信息不可用。
4. **三个业务窗口标题不同，必须按标题区分**：`[商家]<店铺名>` 是主窗口（附加到其渲染宿主），
   `悬浮小组件` 是计数面板，`商家消息窗口` 是新消息浮窗（这两个渲染宿主 `vis=1`，附加顶层即可）。
5. **`out/` 与 `raw/` 已 gitignore。** `raw/` 含未脱敏界面文本，只在本机排查用，禁止提交。

## 指纹设计要点

原生协议 `message.inbound` 要求 `channelMessageId`，但界面抓取拿不到平台真实消息 ID，
只能用本地指纹充当，因此指纹稳定性是**正确性关键属性**，不是优化项。

```
sha256( adapter_id | surface | conversation_key | direction | sender_key | time_text | content_digest | occurrence )
```

主窗口消息带**绝对时间戳**（`17:43:23`），所以指纹用绝对时间，天然规避了浮窗相对时间
（`1小时`）的漂移问题。

**实测（3 轮 × 8 条真实消息）：7 条稳定，1 条漂移。** 漂移那条是富媒体商品卡消息，
正文长度三读为 265/267/268，根因是卡片内懒渲染子节点（销量、物流提示、悬停态）出现/消失；
且该条时间戳只有分钟精度（`17:43`）。

接入生产前必须完成的加固：

1. **富媒体消息只哈希稳定锚点**（时间戳 + 发送者 + 商品 ID / 首行标题），不要哈希整段累积文本；
2. **优先用秒级时间戳** `HH:MM:SS`；
3. 若 `wrap_persist:<id>` 对消息可用，优先用该 ID 替代内容哈希。

## 已知缺陷（尚未可用于生产）

- **会话列表字段切分不可靠**：按"头像"锚点切段会把商品卡价格 `¥260.00` 误判为未读徽标
  （实测出现 `未读=260`），需要按真实 DOM 层级重写。
- **发送者归属不完整**：8 条消息中只有 2 条识别出 `system`、1 条识别出 `in`，其余 5 条为 `unknown`。
- **末尾未闭合块无时间戳**：最新一条消息可能还没渲染出时间节点。

详细说明与实测数据见 `REPORT-feige-uia-probe.md`。
