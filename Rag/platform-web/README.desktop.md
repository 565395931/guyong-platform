# 客户服务聚合工作台桌面端

桌面端是现有 Vue 工作台的 Windows 应用，使用 Electron 打包。业务 API、Socket.IO、数据库和企业微信/平台连接仍由中心服务负责。客户端保存中心服务地址和工作台登录会话，不包含平台 Secret、数据库或业务服务器。

当前版本：1.0.1（2026-09-17）。安装包是 Windows x64 NSIS 安装程序；未使用商业代码签名证书。安装后可从桌面或开始菜单打开“客户服务聚合工作台”。

## 开发

```powershell
npm ci
npm test
npm run desktop:dev
```

开发模式默认打开 `http://127.0.0.1:3003`，前端仍通过 Vite 代理访问 `http://localhost:3001`。

如果 3003 已被使用，可设置 `RAG_DESKTOP_DEV_PORT` 为其他空闲端口。桌面开发使用本机 HTTP；普通网页开发在 `certs` 存在本地证书时继续使用 HTTPS。源码包不包含私钥，无证书时使用 HTTP。

## 构建

```powershell
npm run desktop:build   # 生成未安装目录，用于验收
npm run desktop:dist    # 生成 Windows NSIS 安装包
```

如果构建机无法访问 Electron 官方下载源，electron-builder 已配置镜像；安装开发依赖时也可以设置 `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`。

## 首次连接中心服务

桌面包默认使用 `http://127.0.0.1:3001`。可以从登录页、工作台顶部或“工作台 → 连接设置”菜单填写中心服务地址，例如 `https://central.example.com`。这里只填工作台后端地址，企业微信回调专用域名未必是工作台服务器。地址只允许 `http`/`https` origin，不接受账号、密码、路径或查询参数。

保存后清除旧登录状态并重新加载。通过管理员提供的工作台账号登录；不能直接使用企业微信账号登录。中心服务、MySQL、Redis 必须正常运行；只安装客户端不能接收公网回调。

应用采用 hash 路由，支持 `file://` 离线加载；生产包禁用 Node 集成、启用上下文隔离和沙箱，并拦截未知页面导航。

版本检查与已知限制见 `../docs/testing/project-audit-2026-09-17.md`。本轮交付属于内测版本，尚未通过全平台商用上线验收。
