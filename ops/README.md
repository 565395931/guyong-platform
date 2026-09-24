# 本地启动编排

双击项目根目录的 `start-all.bat`，会按以下顺序启动当前主系统：

1. 本地 MySQL（端口未监听时，通过 `Rag/docker/mysql/docker-compose.yml` 启动）。
2. 本地 Redis（通过 Docker 离线镜像启动）。
3. `wehook` 云渠道网关。
4. `Rag/rag-server` 后端。
5. `Rag/platform-web` 工作台。

启动脚本只读取现有 `.env`，不会打印数据库密码或网关令牌。它不会自动安装依赖，也不会启动官网、旧管理端、旧聊天端或 Commerce PoC。

如果 Docker 命令已安装但 Docker Desktop 尚未运行，启动脚本会自动启动 Docker Desktop，并等待引擎就绪后再创建本地 MySQL。

MySQL 使用项目自带的离线镜像包 `Rag/docker/mysql/images/mysql-8.0.46-amd64.tar`。如果 Docker 中还没有 `mysql:8.0`，脚本会先从该文件导入；Compose 启动采用 `--pull never`，不会临时连接 Docker Hub。镜像包约 780 MB，请勿当作源码文本编辑。

Redis 同样使用项目自带的 `Rag/docker/redis/images/redis-7.4.11-alpine-amd64.tar`。启动脚本不再依赖 Windows 本机的 Memurai，可直接随项目迁移到安装了 Docker Desktop 的其他 Windows 机器。

查看状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\Get-PlatformStatus.ps1
```

只检查启动计划、不启动服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\Start-Platform.ps1 -DryRun
```

核心进程日志写入 `Rag/logs`。MySQL 日志通过 Docker 查看。
