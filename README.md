# PatchPaw

PatchPaw 是一个自托管的 GitHub App 服务：它接收已签名的 Pull Request / issue comment 事件，按仓库配置运行代码审查、CI 修复、冲突分析和对话，并把结果发布回 GitHub。它还提供一个用于管理仓库、Prompt、Skill、模型和命令的 React 控制台。

[English documentation](README.en.md)

## 先了解安全边界

PatchPaw 会在目标仓库的工作区执行 Git、测试和模型生成的命令。应用本身不是容器或沙箱；不信任的仓库应在隔离的服务账号、容器或虚拟机中运行。生产部署必须由操作员提供 HTTPS、限制运行账号权限并保护运行目录、`.env`、GitHub App 私钥、Webhook secret 和模型凭据。

命令权限是显式配置的一部分：`review`、普通对话和冲突分析默认只读；`repair`、`ci` 等修复路径可以获得读写能力，并可能提交、推送或在 GitHub 上发表评论。打开 Pull Request、收到被动 PR 事件或运行健康检查不会自动启动模型任务。

## 架构概览

- GitHub App 负责安装授权和 Webhook 签名；服务端校验事件后读取 GitHub 状态。
- 控制面数据库保存仓库级 Prompt、Skill、Provider、Model、Command 和只读会话配置。
- 每次执行先固定不可变配置快照，运行证据、日志和工作区状态写入运行目录。
- `/api/setup` 在登录前只公布来源地址、Webhook URL、HTTPS 状态和管理员认证是否配置；它不返回任何凭据或文件路径。
- 前端使用相对 API URL 和 HttpOnly 会话 cookie。管理员 token 只在登录请求中发送，服务端不会回显或提供找回接口。

## 环境要求

- Node.js 22.22.0 或更新的兼容版本
- Git
- 一个已安装到目标仓库的 GitHub App
- 用于反向代理/TLS 的公开 HTTPS 域名（本地开发可使用明确的 localhost HTTP 来源）
- 至少一个受支持的模型提供方凭据；模型请求可能产生费用，按提供方条款处理数据

PatchPaw 本身支持 Linux、macOS 和 Windows 原生 Node.js。目标仓库自己的检查命令仍可能要求特定 shell 或工具链。

## 安装和首次启动

```sh
git clone https://github.com/fengyincheng/patchpawwww.git
cd patchpawwww
npm ci
cp .env.example .env
npm run generate:admin-token
npm run check
npm test
npm run build
npm run start
```

Windows PowerShell 可使用 `Copy-Item .env.example .env`，然后运行相同的 npm 命令。把 token 生成命令输出的单行内容放入服务端 `.env`，不要把命令输出写入仓库或日志。`npm run start` 默认只监听本机地址；生产环境通过反向代理发布。

## 配置 GitHub App、域名和 Webhook

1. 在 GitHub 创建一个仅供自己部署使用的 App，设置唯一的 App slug 和 App ID，并只安装到需要管理的仓库。
2. 将 `PATCHPAW_PUBLIC_ORIGIN` 设置为公开的 scheme + host，不要带路径，例如 `https://patchpaw.example.com`。浏览器访问的来源、该值和 GitHub App 的 Webhook URL 必须使用同一个来源。
3. 将 GitHub App Webhook URL 设置为 `https://patchpaw.example.com/github/webhook`，并设置一个新的随机 Webhook secret。启用应用需要的事件：`pull_request`、`issue_comment`；如需安装状态同步，再启用安装相关事件。
4. 仓库权限按实际功能授予最小范围：Metadata 至少为 Read；Pull requests、Issues/issue comments、Contents、Checks/Actions 等权限只在对应审查/修复流程需要时开启。需要提交或推送的修复命令才授予 Contents write；只读审查不应获得写权限。
5. 下载 App 私钥一次，放在运行目录之外或受限的 secrets 目录中，设置 `PATCHPAW_GITHUB_PRIVATE_KEY_PATH`。不要提交 PEM 文件。Webhook secret 和私钥必须分别轮换；任何泄露都应立即在 GitHub 撤销并重新生成。
6. DNS 将域名指向反向代理。代理负责 TLS，转发 `/`、`/api/*` 和 `/github/webhook` 到本机 PatchPaw 监听端口，并保留正确的 `Host`/来源行为。确认代理不会缓存 `/api/setup` 或管理 API 响应。

前端登录页和 Settings 会显示服务器看见的公开来源、派生 Webhook URL、HTTPS、token 配置状态，并比较浏览器 `window.location.origin`。出现 mismatch 时先修正 DNS、代理和 `PATCHPAW_PUBLIC_ORIGIN`，再尝试登录；修改环境变量后必须重启服务。

## 管理员登录凭据

```sh
npm run generate:admin-token
```

该命令通过系统密码学随机源生成一个 32 字节、64 个十六进制字符的 token，只打印一行，不创建文件、不写入运行目录，也没有 API 找回或回显接口。把它作为 `PATCHPAW_ADMIN_TOKEN` 放入仅服务端可读的 `.env`，重启后在 HTTPS 登录页输入。浏览器只会收到短期 HttpOnly session cookie；构建后的前端资源不包含 token。

轮换时生成新 token、替换 `.env` 中旧值并重启。重启会清除内存中的会话，因此旧登录会失效。丢失 token 无法恢复，只能生成并配置新的 token。建议使用专用服务账号和权限严格的环境文件，不要把 token 放进 Vite 公开变量、浏览器 localStorage、shell history、CI 日志或 issue。

## 环境变量速览

`.env.example` 是完整的通用模板。必填项包括 GitHub App ID/slug、Webhook secret、私钥路径、公开来源、监听端口和目标仓库；`PATCHPAW_ADMIN_TOKEN` 对控制台登录是必需的，但模板保持为空。`ZAI_*` 变量用于首次控制面 Provider 的可选初始化；之后也可以在 Models 页面管理 Provider，并且界面只展示凭据是否配置，不回显密钥。

`PATCHPAW_HOME` 为空时使用持久化运行目录：Linux/macOS 为 `~/.patchpaw`，Windows 为 `%USERPROFILE%\\.patchpaw`（通常是 `C:\\Users\\<user>\\.patchpaw`）。它不是临时缓存，包含数据库、仓库缓存、工作区、执行记录、快照、日志、备份、锁和服务端凭据引用。使用另一块磁盘或服务账号时显式设置 `PATCHPAW_HOME`，并用操作系统权限保护该目录；Windows 应配置限制到服务账号的 NTFS ACL。

## 安全检查与有副作用的命令

本地验证可以按以下顺序运行：

```sh
npm run check
npm test
npm run build
```

这些命令不应创建 GitHub 分支、Pull Request、提交或模型请求（测试夹具除外）。`npm run verify:frontend -- <url>` 只比较已构建前端资源；不要把真实 token 作为参数传入任何命令。

以下操作可能改变外部状态，必须在明确审批和备份后执行：

- `run-pr` 及启用修复权限的命令可能调用模型、修改工作区、提交/推送修复并发表评论。
- `bootstrap:control-plane`、Prompt/Skill/Provider/Command 管理会修改控制面数据库。
- `backup-runtime`、`restore-runtime`、`migrate-runtime` 会读写运行目录；恢复前确认目标和备份来源。
- Webhook 处理会持久化快照，issue comment 可能进入排队的执行流程；签名校验失败不会解析事件。

审查和修复的完整行为、输出契约和权限边界见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 限制和故障报告

PatchPaw 不是托管服务，不提供 DNS、证书、GitHub App provisioning、用户账号或 token 恢复服务。模型、GitHub API、目标仓库工具链和反向代理的可用性由操作员负责。跨平台支持表示 PatchPaw 的 Node 运行时路径支持 Linux/macOS/Windows，不表示每个目标仓库的 POSIX 命令都能在 Windows 执行。

请先阅读 [安全策略](SECURITY.md)，不要在公开 issue 中粘贴 token、私钥、Webhook payload、运行日志或私有仓库内容。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，许可证为 [Apache-2.0](LICENSE)。
