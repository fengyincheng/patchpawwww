# 平台与运行目录

PatchPaw 的原生 Node.js 运行时支持 Linux、macOS 和 Windows。

| 平台 | 默认运行目录 |
| --- | --- |
| Linux | `~/.patchpaw` |
| macOS | `~/.patchpaw` |
| Windows | `%USERPROFILE%\\.patchpaw`，通常为 `C:\\Users\\<user>\\.patchpaw` |

使用 `PATCHPAW_HOME` 将目录移动到其他磁盘或服务账号目录。目录保存持久状态，而不只是可删除的缓存：数据库、仓库缓存、工作区、runs、snapshots、日志、备份、锁和服务端凭据引用都可能位于其中。删除它可能丢失运行历史和控制面数据。

Linux/macOS 服务应使用专用的非特权账号并保持 Unix 权限收紧；应用会对 Provider credential slot 目录和文件保持严格的 `0700/0600`。Windows 应使用专用服务账号，并通过 NTFS ACL 仅允许该账号访问运行目录、`.env` 和 PEM 文件，因为 POSIX mode bits 不是 Windows 上等价的秘密边界。写入 Provider credential slot 时，PatchPaw 会调用系统自带的 PowerShell/.NET ACL API：移除继承和现有 DACL 项，为当前 Windows 身份授予 Full Control，并再次读取 ACL 验证；验证失败时不会接受或读取凭据。管理员仍应保护整个运行目录，因为拥有接管权限的系统管理员可以改变 ACL。

如果从旧版运行目录迁移，Linux 会检查进程的工作目录、环境和打开的文件描述符；macOS 和 Windows 没有同等通用的进程引用清单，因此迁移前必须手动停止旧服务、worker 和相关定时任务，并确认它们不再使用旧目录。所有平台都会继续检查活动标记、迁移锁和迁移日志，遇到不确定状态会拒绝迁移。

PatchPaw 使用 Node.js 路径和平台进程能力。目标仓库的验证命令仍由仓库自行决定：一个只支持 POSIX shell 的项目可能需要在 Windows 上配置替代命令、WSL2、容器或虚拟机。对不信任代码的更强隔离应由操作员部署容器或 VM 提供。
