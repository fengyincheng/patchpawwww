# 平台与运行目录

原生部署支持 Linux、macOS，生产环境推荐 Linux。原生 Windows 暂不支持，也不作为 CI 发布门槛。代码中已有的 Windows 分支属于未完成的兼容工作，不代表可用性承诺。

官方 Docker 发行方式运行 Linux container，目标架构为 `linux/amd64` 和 `linux/arm64`，可用于支持 Linux containers 的 Linux、Windows Docker Desktop/WSL2 和 macOS Docker Desktop。Docker Desktop 上的 PatchPaw 仍是 Linux 版；Windows-only 的目标仓库测试/构建需要真正的 Windows runner。Android/iOS 不支持；FreeBSD 和特殊 NAS 仅在其 Linux-container 兼容时 best effort，32-bit 不支持。镜像和部署流程见 [Docker 部署指南](DOCKER.md)。

## 持久化目录

Linux/macOS 默认使用运行账号的 `~/.patchpaw`，可通过 `PATCHPAW_HOME` 指定其他位置。它保存数据库、仓库缓存、工作区、执行记录、快照、日志、备份、锁和服务端凭据，不是临时缓存。

Docker 默认使用 `/var/lib/patchpaw` 并挂载单个 Docker named volume。Windows/macOS Docker Desktop 应使用 named volume；不建议把 SQLite/WAL、锁和 Unix socket 放在宿主共享目录、SMB、NFS、OneDrive 等文件系统上。一个 runtime home 只支持一个活动服务实例。

服务应使用专用非特权账号，并保护运行目录、`.env` 和 PEM 私钥。Provider credential slot 目录和文件使用 `0700/0600` 权限。切换账号或进程管理器时保持同一个运行目录；删除目录会丢失数据。

## 迁移和目标项目

迁移前停止旧服务、worker 和定时任务，确认它们不再使用旧目录，并完成备份。Linux 会检查进程引用；macOS 没有同等通用的引用清单，更依赖操作员确认停机。运行时锁和迁移日志也会参与检查。

目标仓库的 shell、测试工具和依赖仍由操作员准备。GitHub 和 GitLab 的 CI 读取都按精确提交 SHA 关联；平台 CI 通过不保证任意项目的命令可用，命令读写权限也不提供 OS 隔离。GitLab 设置见 [GitLab setup](GITLAB.md)，部署边界见 [安全模型](SECURITY-MODEL.md)，安装步骤见 [README](../README.md)。
