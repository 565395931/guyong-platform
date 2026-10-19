# 拼多多工作台 UIA / 视觉读取工具集

**拼多多商家工作台**（客户端 3.7.3.12，内核 `pddbrowser104` 定制 Chromium 104）
的本地读取方案。因为该客户端**不提供 UI Automation 无障碍树**（详见
[`REPORT-pinduoduo-uia.md`](REPORT-pinduoduo-uia.md)），本工具集采用
**截图 + PaddleOCR（百度飞桨）+ Windows 原生能力**的视觉路线：

- **截图**：`PrintWindow(PW_RENDERFULLCONTENT)`，窗口被遮挡也能截（但**最小化时读不到**）；
- **识别**：PaddleOCR（中文质量远优于 Windows OCR）；
- **触发**：区域差分哨兵（2 秒心跳、毫秒级），探测到变化才做完整读取。

## 目录与脚本

| 脚本 | 作用 |
| --- | --- |
| `probe.py` | UIA 可行性探针（只读）：枚举窗口、尝试附加渲染宿主、判定 UIA 是否可读 |
| `pdd_client.py` | 基础能力：截图（`PrintWindow`）、OCR 调度（Paddle 优先 / Windows OCR 回退）、点击、键盘输入 |
| `pdd_reader.py` | 客服聊天读取器：分组解析、方向判定（气泡底色 + 发送者标签锁定）、首次全量回翻、增量指纹去重、**区域差分哨兵** `PddSentinel` |
| `pdd_backfill.py` | 历史回翻：滚到顶（认"没有更多了"）→ 从上往下逐屏读（步长小于一屏，屏间重叠）→ 回到底部 |
| `pdd_layout.py` | 气泡版面识别（按颜色框选消息气泡，备用方案） |
| `pdd_paddle.py` | PaddleOCR 封装：单例复用、缓存目录重定向、MKLDNN 关闭、ASCII 路径切换 |
| `ocr.ps1` | Windows OCR 回退（PowerShell + WinRT，`chcp 65001` 修复编码）+ 结果 JSON 输出 |
| `REPORT-pinduoduo-uia.md` | UIA 不可读的证据链 + 可行路线评估 |

## OCR 安装与模型位置（重点）

### 安装（PyPI）

```powershell
python -m pip install paddlepaddle==3.3.1 paddleocr==3.7.0
```

- 实测版本：`paddlepaddle 3.3.1`、`paddleocr 3.7.0`（Python 3.12）；
- 首次 import 会加载 `paddleocr` 及其依赖（paddlex、opencv 等，安装体积约 2GB，**在 Python 的
  site-packages 里，无法随项目迁移**——模型部分我们已经搬到了项目内，见下）。

### 模型下载源

PaddleOCR 3.x 的模型由 PaddleX 自动下载，**默认下载源（BOS）**：

```
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model
```

- 默认拉取两个模型：`PP-OCRv6_medium_det`（文本检测）+ `PP-OCRv6_medium_rec`（文本识别）；
- 可用环境变量 `PADDLE_PDX_MODEL_SOURCE` 切换下载源，支持 `BOS`（默认）/
  `HuggingFace` / `ModelScope` / `Aistudio`；
- 首次使用前 PaddleX 会做下载源连通性检查；如需跳过，设置
  `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`。

### 模型存放位置（随项目目录）

模型缓存根目录由环境变量 `PADDLE_PDX_CACHE_HOME` 指定，**本项目已在
`pdd_paddle.py` 中固定指向项目目录**（不再使用默认的 `C:\Users\<用户>\.paddlex`）：

```
Rag/tools/pinduoduo-uia-probe/paddlex_home/
└── official_models/
    ├── PP-OCRv6_medium_det/    # 检测模型
    └── PP-OCRv6_medium_rec/    # 识别模型
```

- 总大小约 **133MB**，已加入 `.gitignore`（`paddlex_home/`），**不会提交到仓库**；
- 重新下载：删除对应模型目录后重跑任意读取命令，PaddleX 会自动重新下载到该位置；
- 想换位置：改 `pdd_paddle.py` 里 `PADDLE_PDX_CACHE_HOME` 的取值即可（注意下面的中文路径坑）。

### 两个必须知道的坑

1. **中文路径**：飞桨 C++ 层不能稳定读取非 ASCII 模型路径。代码现在为实际模型目录
   自动创建唯一的 ASCII 目录联接，入口位于 `%TEMP%/guyong-ocr-links/<路径摘要>`，
   模型实体仍在上面的项目目录。无需复用旧机器的 `E:\guyong-platform`。
   支持通过 `PADDLE_PDX_CACHE_HOME` 指定其他 ASCII 缓存目录；如果临时目录也含中文，
   需显式指定该变量。迁移或清理临时入口后，下次运行会重建联接。
2. **MKLDNN 兼容坑**：PaddlePaddle 3.x 的 oneDNN 后端在部分 CPU 上报
   `ConvertPirAttribute2RuntimeAttribute not support`。`pdd_paddle.py` 已设置
   `FLAGS_use_mkldnn=0` 并传 `enable_mkldnn=False`。

### Windows OCR 回退

`ocr.ps1` 用系统自带 `Windows.Media.Ocr`（zh-Hans-CN）兜底。两个要点：

- 调用前必须 `chcp 65001`，否则 PowerShell 5.1 会把 WinRT 返回的中文字符串按 ANSI 解码成乱码；
- WinRT `StorageFile.GetFileFromPathAsync` **不接受相对路径**（会报 "Wait 时发生异常"），
  `pdd_client.ocr_image` 已统一转绝对路径。

## 用法

```powershell
cd Rag\tools\pinduoduo-uia-probe

# UIA 可行性探针（只读）
python probe.py
python probe.py --warmup 30          # 附加后预热观察（排除懒构建）

# 单次读取（当前打开会话：标题 + 消息）
python pdd_reader.py once --json out/read.json

# 历史回翻（滚到顶 → 从上往下读 → 回到底部）
python pdd_backfill.py --max-scrolls 30 --json out/history.json
python pdd_backfill.py --ingest --account-id <实际账号ID>      # 另存入库 payload（与实时上报同指纹格式，入库自动去重）
```

节点集成（`../feige-uia-probe/bridge_node.py`）：

```powershell
$env:PDD_READER_ENABLED="1"        # 启用拼多多读取线程（哨兵 2 秒心跳 + 触发式完整读取）
$env:PDD_READER_INTERVAL_SECONDS="60"   # 兜底全量读取间隔（即使哨兵没触发）
```

## 关键设计要点

- **读取窗口必须可见**：最小化/隐藏时读不到（`PrintWindow` 拿不到实时帧），程序会拒绝并在日志里说明；
- **旧帧陷阱**：后台窗口的截图可能是`停更的旧画面`——任何"操作后立即核对"的读取都会先确保窗口在前台；
- **方向判定**：客户=白色气泡；我方=浅蓝气泡或带"机器人/自动回复/主账号"发送者标签
  （标签出现后紧随的消息锁定为我方——自动回复是白底样式，靠颜色判不出来）；
- **多平台隔离**：所有窗口检查只认拼多多进程（`PddWorkbench` / `pddwebworkbench` / `PDDWBGd`），
  飞鸽、千帆等其它平台的窗口/通知不会触发本工具；截图区域也只按拼多多窗口矩形计算；
- **首次全量 / 后续增量**：新客户第一次从最顶部完整回翻；之后每轮只核当前页，
  按指纹（会话+方向+正文+出现序号）去重，只上报新增。

## 产物

`out/`（gitignore）存放截图与 OCR 中间结果（`pdd_capture.png`、`pdd_region.png`、
`pdd_bubble_*.png`、`pdd_history*.json`、`pdd_ingest_payloads.json` 等），仅本机排查用；
`paddlex_home/` 为模型缓存（gitignore，约 133MB）。
