# 本地平台升级基础协议

当前目录只建立升级协议和安全边界，尚未启用客户电脑自动下载或安装。没有配置正式更新服务器、公钥和发布包之前，工作台不会出现可执行的“升级”动作。

## 两种能力必须分开

- 开发热重载：前端使用 Vite，后端使用 Node `--watch`。它面向源码开发电脑，不负责版本校验、备份或回滚。
- 客户升级：由后端进程之外的独立更新器执行。它下载完整发布包，验证 HTTPS、SHA-256 和 Ed25519 签名，备份当前版本，停止平台进程，原子替换程序文件，重新启动并做健康检查；失败时恢复备份。

客户环境不得执行 `git pull`，也不应要求安装 Git、Node.js 或开发依赖。升级包只能包含运行文件和数据库迁移，不得覆盖以下本地状态：

- `Rag/rag-server/.env`、`wehook/.env` 和所有密钥；
- MySQL、Redis、Docker volume 与业务数据；
- `Rag/logs`、上传附件、客户文件及网关本地状态；
- Desktop Bridge 的本机绑定和授权信息。

## 已固定的清单合同

`manifest.schema.json` 定义第一版更新清单；`update-manifest.example.json` 是不可下载的占位示例。发布服务器最终应按渠道提供清单，例如：

```text
https://updates.example.com/guyong-platform/test/latest.json
https://updates.example.com/guyong-platform/stable/latest.json
```

发布流程必须在离线或受保护的发布机上使用 Ed25519 私钥签名。客户程序只内置公钥；私钥不得进入仓库、安装包、客户电脑或更新服务器。

本地校验示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\update\Test-UpdateManifest.ps1 `
  -ManifestPath .\ops\update\update-manifest.example.json
```

## 后续启用顺序

1. 建立统一平台版本号和可重复构建的发布 ZIP。
2. 完成发布包文件清单、数据库迁移前后兼容规则和备份范围。
3. 生成正式签名密钥，将私钥放入独立发布环境，只把公钥编入更新器。
4. 实现独立更新器及“下载—校验—暂存—替换—健康检查—回滚”状态机。
5. 最后才在管理员菜单加入“检查更新”，先开放 `test` 渠道，再灰度到 `stable`。

在第 4 步完成前，不允许仅凭版本号或 SHA-256 自动安装；哈希能检查传输完整性，但不能证明发布者身份。
