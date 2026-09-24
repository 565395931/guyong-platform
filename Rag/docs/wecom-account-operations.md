# 企业微信账号管理运维说明

## 当前范围

当前版本完成企业微信“微信客服”的账号管理基础：

- 一个系统可保存多个企业微信主体。
- 每个主体通过官方 API 同步多个微信客服账号。
- 企业凭据加密保存，前端只显示脱敏 CorpID 和 `open_kfid`。
- 支持从前端新增连接、替换凭据、验证并同步账号。
- 支持测试账号白名单成员维护、运行时安全停用和操作日志查询。
- 新同步账号默认锁定、AI 关闭、白名单开启。
- 名称为“客服1号”的账号固定为生产保护，当前 API 和前端都不能解除。

企业微信官方回调验签、消息同步和受保护文本发送适配器已在本地完成，但尚未配置真实公网回调或生产发送。账号同步成功不等于消息链路已经上线。

## 运行条件

后端目录：`rag-server`

必要环境变量：

- `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`
- `JWT_SECRET`
- `PLATFORM_CREDENTIAL_KEY`：32 字节随机值的 Base64 编码

`PLATFORM_CREDENTIAL_KEY` 用于解密已经保存的企业凭据。存在连接数据后不能随意更换；生产环境应由密钥管理服务注入，不应写入代码、文档或聊天记录。

启动后端：

```powershell
cd E:\project\project\Rag\rag-server
npm start
```

启动前端开发服务：

```powershell
cd E:\project\project\Rag\platform-web
npm run dev
```

MySQL 是账号管理的必要依赖。Redis 是 AI 队列、发送锁、配置缓存和发布订阅的必要依赖；Redis 不可用时不得启用 AI 自动发送。

## Windows 本机部署

当前电脑可使用项目内的一键脚本启动 Redis、企业微信网关、Rag 后端和生产前端：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\project\project\Rag\tools\local-deploy\start-local-platform.ps1
```

脚本会自动识别当前局域网 IPv4，已有端口会安全跳过，不会重复启动服务。也可以显式指定前端监听地址：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\project\project\Rag\tools\local-deploy\start-local-platform.ps1 -FrontendHost 192.168.1.4
```

只检查服务状态，不启动进程：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\project\project\Rag\tools\local-deploy\start-local-platform.ps1 -Status
```

本机部署的端口范围：

- `3003`：生产前端，仅绑定当前局域网地址，供同一局域网电脑访问。
- `3001`：Rag 后端；前端通过同源 `/api` 和 `/socket.io` 代理访问。
- `8787/8788`：企业微信网关 WebSocket 和健康接口，只绑定 `127.0.0.1`。
- `6379`：项目内 Memurai/Redis 兼容服务，只绑定 `127.0.0.1`，启用 AOF 持久化。

运行日志位于 `Rag/logs`，Redis 持久化数据位于 `Rag/data/redis`。迁移电脑时必须同时迁移 MySQL 数据、知识库和媒体文件、Redis 数据、`PLATFORM_CREDENTIAL_KEY`、`WECOM_RUNTIME_CONFIG_KEY` 及企业微信凭据；迁移后重新检查企业微信回调地址和可信 IP。任何迁移都不能把 AI 自动发送直接扩大到“客服1号”。

## 权限

- `admin`：新增企业连接、替换凭据、验证同步、发布/停用网关和修改账号策略。
- `supervisor`：查看企业连接和账号，修改非生产保护账号的测试策略与白名单。
- `agent`：不能进入平台账号管理接口。

权限由后端校验，不能只依赖前端菜单是否显示。

## 新增企业主体

1. 使用管理员账号登录系统。
2. 打开“平台账号”。
3. 点击“添加企业主体”。
4. 填写连接名称、CorpID、微信客服 Secret、回调 Token 和 EncodingAESKey。
5. 保存后点击该连接的“验证并同步”。
6. 检查连接状态、账号数量、最近同步时间和状态说明。

Secret、Token 和 EncodingAESKey 保存后不会返回前端。不要使用“客服1号”做首次联调，先在企业微信后台创建独立的“AI测试客服”。

## 替换凭据

在企业连接行点击“替换凭据”。连接名称和脱敏 CorpID 只读，三个密钥字段必须完整重新填写。替换后连接回到待验证状态，必须再次执行“验证并同步”。

替换凭据不会自动开启 AI，不会修改企业微信接待人员、欢迎语或在线状态。

## 账号保护

- `生产保护`：AI 关闭，白名单和 AI 开关不可操作。“客服1号”固定使用此模式。
- `锁定`：新账号默认状态，AI 关闭。
- `测试模式`：仅用于独立测试账号。开启 AI 前必须保持白名单开关开启。

当前页面的白名单开关控制测试账号是否强制执行白名单发送策略。账号切换为“测试模式”后，可以从账号行进入白名单抽屉，按企业微信 `external_userid` 添加或移出测试联系人。移出采用软停用，操作记录会保留。

连接为“运行中”时，账号策略和白名单只能查看、不能修改。必须先由管理员执行“停用网关”，等待网关确认停用后再修改；修改完成后重新“发布到网关”。媒体二进制下载/上传和真实公网试运行仍未完成，这些能力完成前不要对生产客户启用 AI。

## 发布到本地网关

企业连接完成“验证并同步”且至少存在一个已同步账号后，管理员可以点击“发布到网关”。系统会：

1. 在 Rag 内存中解密企业凭据并生成带版本号的运行快照。
2. 使用 `WECOM_RUNTIME_CONFIG_KEY` 将快照再次加密后，通过已认证 WebSocket 发给 `wehook`。
3. `wehook` 只持久化密文，拒绝旧版本或同版本不同内容。
4. 只有网关返回相同连接和版本的应用确认后，连接状态才变为“运行中”。

发布运行配置不会修改企业微信后台的接待人员、欢迎语、在线状态或回调地址，也不会发送消息。网关未连接、共享密钥不一致或配置被拒绝时，连接不会被错误标记为已启用。

## 停用网关与配置修改

管理员在运行中连接上点击“停用网关”并二次确认后，系统会生成更高版本的加密快照，以 `status=disabled` 发给网关。只有网关确认应用后，MySQL 中的连接状态才会变为“已停用”。停用失败时仍保留原运行状态，并显示健康错误，不能继续修改账号策略或白名单。

安全修改顺序固定为：

1. 停用网关并等待页面显示“已停用”。
2. 修改非生产基线账号的测试策略或白名单。
3. 检查“操作日志”中的变更对象、操作人和脱敏摘要。
4. 重新发布到网关。

替换凭据和重新验证同样要求连接不处于运行中。“客服1号”即使连接已停用，也不能解除生产保护或进入白名单管理。

两侧必须配置同一个 32 字节 Base64 密钥：

```text
WECOM_RUNTIME_CONFIG_KEY=<由密钥管理服务注入的 32 字节 Base64 值>
```

`wehook` 还使用以下路径保存密文运行配置和非敏感同步游标：

```text
WECOM_RUNTIME_CONFIG_STORE_PATH=./data/wecom-runtime-configs.json
WECOM_SYNC_STATE_STORE_PATH=./data/wecom-sync-states.json
```

## Public callback rollout (2026-08)

This section is the operational contract for the Enterprise WeCom public callback. It is intentionally separate from the local account-management workflow above.

### Fixed endpoints and runtime boundaries

```text
WECOM_PUBLIC_CALLBACK_BASE_URL=https://wecom.thelonelybrave.cn
Public callback: https://wecom.thelonelybrave.cn/webhooks/wecom/<callbackKey>
ECS loopback forward: 127.0.0.1:18788
Local gateway health: 127.0.0.1:8788
Scheduled task: Rag-WeCom-Reverse-Tunnel
```

The ECS public virtual host may expose only the ACME challenge and `/webhooks/wecom/`. Nginx proxies that callback path to `127.0.0.1:18788`; the restricted SSH reverse tunnel forwards it to the local gateway at `127.0.0.1:8788`. Keep ports `18788`, `8787`, `8788`, `3001`, `3003`, Redis, and MySQL closed to the public Internet.

Required order:

```text
verify and sync -> publish runtime -> copy callback URL -> save callback in Enterprise WeCom -> controlled inbound test
```

Saving the callback in Enterprise WeCom is a separate action from publishing the local runtime. A successful account sync alone does not mean the public message path is live.

### Approval gates

These approvals are required at action time even though the implementation design is approved:

```text
Approval A: submit or change ICP filing data.
Approval B: create/change Alibaba Cloud DNS records, security-group rules, ECS users, SSH configuration, Nginx, or certificates.
Approval C: save the callback URL in Enterprise WeCom.
Approval D: send the first real manual test reply.
```

The first test uses only the independent `AI测试客服` account and one allowlisted test customer. Keep `客服1号` as the production baseline with AI disabled.

### Safe rollback

Disable the local tunnel task before changing its identity or forwarding settings:

```powershell
Disable-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
Stop-ScheduledTask -TaskName 'Rag-WeCom-Reverse-Tunnel'
```

Product rollback order:

```text
1. Disable runtime from platform-web and wait for gateway confirmation.
2. Disable the callback in Enterprise WeCom.
3. Stop and disable the Windows tunnel task.
4. Preserve connection, account, message, and audit data.
```

Do not delete the platform connection, rotate either runtime encryption key, or bypass account protection while rolling back. If certificate issuance or readiness checks fail, leave the bootstrap HTTP host in place and do not save the callback in Enterprise WeCom.

### Secret handling and readiness

CorpID Secret, callback token, EncodingAESKey, runtime encryption keys, SSH private keys, access tokens, callback query strings, and customer message bodies must stay in the local secret store or the approved password manager. They must not be placed in this runbook, source code, scheduled-task arguments, Nginx logs, or chat.

Before a real callback change, run the local contract tests and the readiness checker. The checker emits one JSON object with booleans and safe error codes only; it must exit `0` only when the local gateway, DNS, TLS, public controlled `404`, and ECS loopback probe all pass.

Use a dedicated read-only ECS probe account/key for the readiness command. Do not use the `wecom-tunnel` reverse-forward runtime key for this probe. If the probe key is restricted with a forced command, that command must only check `http://127.0.0.1:18788/healthz`.

```powershell
node E:\project\project\Rag\tools\wecom-public-callback\check-readiness.js `
  --domain wecom.thelonelybrave.cn `
  --ssh-host $env:WECOM_ECS_SSH_HOST `
  --ssh-port 22 `
  --ssh-user wecom-probe `
  --identity-file E:\project\project\Rag\data\wecom-probe\id_ed25519
```

不要把共享密钥、平台 Secret、回调 Token 或 EncodingAESKey 写入代码、文档、启动脚本或聊天记录。

## 官方回调基础

网关提供以下回调路径：

```text
GET/POST /webhooks/wecom/<callbackKey>
```

当前实现包括 SHA1 验签、AES-256-CBC 解密、接收方校验、`sync_msg` 游标拉取、token 并发刷新、文本及媒体元数据标准化、稳定消息 ID、网关持久化、Rag ACK 和重复事件去重。出站目前只开放受保护的白名单文本路径；图片、语音、视频和文件只保存平台媒体 ID 元数据，尚未下载或上传二进制内容。

本地代码完成并不等于公网回调已经上线。首次真实联调仍必须使用独立“AI测试客服”和测试客户白名单，并单独配置 HTTPS、域名、反向代理、网关数据库和企业微信后台回调地址。

## 故障处理

- `待验证`：凭据已保存但尚未调用官方账号列表接口。
- `连接异常`：检查 CorpID、微信客服 Secret、网络和企业微信接口返回，再替换凭据并重新验证。
- 账号显示“需检查”：重新执行账号同步，不要直接删除历史账号记录。
- Redis 不可用：账号管理仍可检查，但 AI 队列和自动发送不得上线。
- MySQL 不可用：停止服务并恢复数据库连接，不要在网关侧绕过账号策略。

本阶段不开放删除连接。需要回退时先使用“停用网关”，保持所有账号锁定、AI 关闭；不要删除连接记录，不要更换 `PLATFORM_CREDENTIAL_KEY` 或 `WECOM_RUNTIME_CONFIG_KEY`。本地停用不会自动撤销企业微信后台的公网回调地址，真实上线后仍需按变更流程同步处理平台侧配置。

## 上线顺序

1. 只保存并验证企业凭据。
2. 同步账号，确认“客服1号”为生产保护。
3. 选择独立“AI测试客服”，准备测试客户白名单。
4. 完成回调、入站、人工发送、幂等和媒体测试。
5. 最后才对白名单测试账号启用 AI，并验证人工接管后 AI 停止发送。

任何步骤都不得自动扩大到“客服1号”或其他生产账号。
