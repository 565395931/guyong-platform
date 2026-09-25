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
# 后端：当前基线 536 项
Set-Location Rag/rag-server
npm.cmd test

# 前端：当前基线 148 项；界面或构建配置变更还需 build
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

### 2026-09-25 — 同时开放本机与局域网工作台入口
- 改动：Vite 预览服务改为监听 `0.0.0.0:3003`，启动完成和状态命令同时显示本机 `LocalUrl` 与局域网 `LanUrl`，并额外打印两个工作台入口。
- 位置：`Rag/tools/local-deploy/start-local-platform.ps1`、对应测试、`ops/Platform.Common.ps1`、`ops/Start-Platform.ps1`、`ops/Get-PlatformStatus.ps1`、README。
- 验证：部署 dry-run、启动 dry-run、PowerShell 语法、状态表双地址输出和 CodeGraph 审查通过。
- 待办：新电脑拉取后结束旧前端进程并重新启动一次，使新的监听地址生效。

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
