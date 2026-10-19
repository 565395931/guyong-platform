# 千帆客服工作台 UIA 工具集

小红书商家客服客户端「千帆客服工作台」（Electron/Chromium，安装目录代号 `eva`）的
Windows UI Automation 工具集：窗口捕捉（只读）、订单定时采集（点击导航）、
建号检测探针。流程与结论参考 `../feige-uia-probe/`（抖店飞鸽）。

**捕捉结论见 [`REPORT-qianfan-capture.md`](REPORT-qianfan-capture.md)；采点配置见
[`profiles/xiaohongshu_qianfan.json`](profiles/xiaohongshu_qianfan.json)。**

> **结论**：千帆工作台界面**可以**通过 UI Automation 读取。方法与飞鸽相同：必须附加到
> 渲染宿主子窗口 `Chrome_RenderWidgetHostHWND`（实测：客服工作台视图 97 节点 / 29 文本，
> 智能客服视图 307 节点 / 96 文本），从顶层 `Chrome_WidgetWin_1` 附加只有空壳（29 节点 /
> 4 文本）。**不需要窗口置顶**（捕捉时前台是 ZCode）。切换左侧导航时渲染宿主 HWND 不变、
> 整棵内容树被替换，捕捉会自动跟随并按视图名另存产物。当前客户端无进行中会话，
> 会话列表与消息区的字段结构待有真实会话时复测。
>
> **订单采集（点击导航）已打通**：左侧导航点按走元素级 UIA 动作（零坐标），
> 订单表格 11 列全字段可读（实测 18 条真实订单），采集后自动点回客服页。

## 三个脚本的分工

| 脚本 | 性质 | 作用 |
| --- | --- | --- |
| `qianfan_capture.py` | **纯只读** | 窗口枚举（`enum`）/ 元素树捕捉（`capture`）/ 只读自证（`selfcheck`） |
| `qianfan_orders.py` | **点击导航**（有状态变更） | 订单采集：点进订单 → 重置条件+搜索 → 抓表格 → 点回客服（`collect`） |
| `detect.py` | 只读 | 建号检测探针：单行 JSON（店铺名/在线状态/机器指纹），供后端「一键检测建号」调用 |
| `qianfan_nav_probe.py` | 只读 | 诊断：视图识别、渲染宿主分布、导航项动作可用性（排查自动化前的客户端状态） |

## 只读保证

`qianfan_capture.py` / `detect.py` / `qianfan_nav_probe.py` 只做**读取**：

- 只用 UIA 读取能力（属性、GetChildren 遍历）与 Win32 查询类 API；
- 不调用变更类 Pattern，不点击、不输入、不发送；
- 不 OCR、不截图、不注入进程、不读进程内存、不抓包；
- 不读取密码、Cookie、登录态或客户端本地数据库；
- 不改窗口状态（不 `SetForegroundWindow` / `ShowWindow` / `SetWindowPos`）。

`python qianfan_capture.py selfcheck` 用 AST 扫描真实调用点自证，期望输出 `"verdict": "PASS"`。

`qianfan_orders.py` 的**点击约束**（有状态变更，但范围收窄）：

- 只点击左侧导航（订单/客服）与两个查询按钮（重置条件/搜索），点击前校验名称精确匹配，
  并维护黑名单（发送/确定/提交/删除/关闭）拒绝误点；
- **不使用屏幕坐标、不模拟鼠标**：所有点击走 UIA 元素动作
  （`LegacyIAccessible.DoDefaultAction` → `InvokePattern`）；
- 采集窗口仅把千帆窗口提到前台（元素动作在窗口被遮挡时不可用，见下），
  结束后还原前台；`try/finally` 保证无论成败都点回客服页。

## 依赖与用法

```powershell
python -m pip install uiautomation
cd Rag\tools\qianfan-uia-probe

# 0. 只读自证 / 诊断当前客户端状态
python qianfan_capture.py selfcheck
python qianfan_nav_probe.py inspect

# 1. 窗口枚举 + 元素树捕捉（只读）
python qianfan_capture.py enum
python qianfan_capture.py capture

# 2. 订单采集（点击导航；抓完自动点回客服）
python qianfan_orders.py collect
python qianfan_orders.py collect --no-click   # 只读当前视图（需已在订单页）

# 3. 建号检测（单行 JSON）
python detect.py --pretty
```

产物写入 `out/`（已 gitignore，含未脱敏界面文本与本机订单数据，只在本机排查用）：

- `qianfan_windows.json` — 窗口枚举结果；
- `qianfan_tree_raw.json` / `qianfan_tree_<视图名>.json` — 元素树捕捉；
- `qianfan_orders_<时间戳>.json` / `qianfan_orders_latest.json` — 订单采集结果。

## 关键实测结论（2026-10-13）

1. **渲染宿主的位置会动态变化**：客户端窗口被压到后台/被遮挡时，Chromium 会把渲染宿主
   缩进隐藏容器 `Chrome_WidgetWin_0`——此时 **UIA 动作（DoDefaultAction/Invoke）全部
   失效**（返回 ELEMENTNOTAVAILABLE，`GetClickablePoint` 恒 False），但**读取不受影响**。
   把窗口提到前台约 1~2 秒后宿主搬回可见主窗口，元素动作立即恢复。
   因此定位渲染宿主必须按**进程全窗口**扫描，不能只看主窗口子级。
2. **点击用元素不按坐标**：导航项是自定义元素（不是标准按钮），`DoDefaultAction` 可用；
   提窗 + 真实鼠标坐标点击也可以，但坐标随窗口移动而失效，已弃用。
3. **视图判断不能用文档名**：客户端故障时 DocumentControl 名会固定显示
   '你访问的页面不见了'，必须用内容标记（'当前会话' / '订单管理'）。
4. **订单查询状态是粘性的**：遗留一次空查询后列表会一直停在"查询结果为空"，
   重进模块也不恢复；采集前必须"重置条件 → 搜索"拉回默认集。
5. **订单表格结构**：`TableControl` → 表头（`HeaderControl`×11，包装层级有两种实测形态）
   + 行 `CustomControl`（`DataItemControl` 单元格×11，文档序与表头一一对应）。

## 与飞鸽流程的差异

| 项 | 飞鸽（抖店） | 千帆（小红书） |
| --- | --- | --- |
| 进程名 | `doudian.exe` | `千帆客服工作台.exe`（代号 `eva`） |
| 主窗口定位 | 标题匹配 `^\[商家\]` | 标题是 `eva`，**无信息量**，只能按进程 + `Chrome_WidgetWin_1` + 可见 定位 |
| 渲染宿主 | 主窗口下 1 个 `Chrome_RenderWidgetHostHWND` | 主窗口下 **2 个**（主内容区 + 48px 标题栏条），按节点数取主内容区；且会被缩进隐藏容器（见上） |
| 导航 | 飞鸽顶部 Tab | 左侧 53px 图标导航（客服/智能客服/数据/管理/订单） |
| 会话列表容器 | `chantListScrollArea` | `farmer-contact-list` |
| 设计系统前缀 | `rc-`（React 组件） | `walle-`（小红书 Walle 设计系统） |
| 订单 | 开放平台 API | 客户端订单页采集（无 API 通路） |
