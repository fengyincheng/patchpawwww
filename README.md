# PatchPaw

自托管的 GitHub App：在 Pull Request 评论中与 Agent 对话、请求代码审查、修复 CI、分析冲突，通过 Web 控制台管理仓库、模型、Prompt、Skill 和命令。

[English](README.en.md) · [运维说明](docs/OPERATIONS.md) · [安全边界](docs/SECURITY-MODEL.md) · [贡献指南](CONTRIBUTING.md)

这是早期版本，适合愿意自行部署和维护的用户。当前发布支持 Linux、macOS，生产部署推荐 Linux。**暂不支持原生 Windows，目前没有官方 Docker 镜像；未来会考虑提供可在 Windows Docker 环境运行的 Linux 镜像，暂无时间表。**

## 准备清单

- 一台可长期运行的 Linux 主机或 macOS，Node.js **22.22.0+ 的 22.x 版本**、npm、Git。
- 一个域名或已有域名的子域名，可以配置 DNS 和 HTTPS 反向代理。
- 一个你有权创建并安装到目标仓库的 GitHub App，下面会逐项引导。
- 模型 API 凭据：支持 Zhipu/Z.ai、DeepSeek、OpenRouter、Kimi、Qwen。需自行确认模型、端点、费用和数据政策。
- 目标项目运行检查所需的工具链，例如 Python、编译器或包管理器；PatchPaw 不会自动准备所有项目依赖。

PatchPaw 不提供域名、服务器或模型额度。它会执行仓库代码和模型生成的命令，**不是安全沙箱**。使用专用非 root 账号；不信任的 PR 应放在隔离主机或虚拟机上执行，不要与其他重要凭据共用环境。

## 1. 确定公开地址

假设使用 `https://patchpaw.example.com`：

| 用途 | 地址 |
| --- | --- |
| 浏览器控制台 | `https://patchpaw.example.com/` |
| GitHub App Webhook | `https://patchpaw.example.com/github/webhook` |
| 公开部署信息 | `https://patchpaw.example.com/api/setup` |
| 健康检查 | `https://patchpaw.example.com/health` |

**前端、API 和 Webhook 共用同一个域名和后端进程。** 不需要另一个前端域名或独立前端服务。`PATCHPAW_PUBLIC_ORIGIN` 填 `https://patchpaw.example.com`，不要加子路径或 `/github/webhook`。这个变量声明公开地址，不会自动配置 DNS、证书或监听端口。

## 2. 创建并安装 GitHub App

在个人或组织的 **Settings → Developer settings → GitHub Apps → New GitHub App** 创建。个人账号可从 [GitHub App 设置](https://github.com/settings/apps) 进入。

### 基本信息

| GitHub 表单项 | 怎么填 |
| --- | --- |
| GitHub App name | 全 GitHub 唯一的名字，例如 `my-team-patchpaw` |
| Homepage URL | 你的公开地址，例如 `https://patchpaw.example.com` |
| Callback URL、Setup URL | 留空；控制台不使用 GitHub OAuth 登录 |
| Request user authorization (OAuth) during installation | 不勾选 |
| Enable Device Flow | 不勾选 |
| Webhook → Active | 勾选 |
| Webhook URL | `https://patchpaw.example.com/github/webhook` |
| Webhook secret | 自己生成的随机 secret，稍后原样写入 `.env` |
| SSL verification | 保持启用 |

生成 Webhook secret，单独保存，不要与管理员 token 共用：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Repository permissions

以下权限覆盖审查、PR 评论和 CI 读取。需要推送修复时再开启对应写权限：

| 权限 | 设置 | 用途 |
| --- | --- | --- |
| Metadata | Read-only（自动提供） | 仓库基础信息 |
| Contents | Read-only；需要修复推送时改为 Read and write | 拉取代码、推送修复 |
| Pull requests | Read and write | 读取 PR、发布审查及 PR 评论 |
| Commit statuses | Read-only | 读取提交状态 |
| Checks | Read-only | 读取检查结果 |
| Actions | Read-only | 读取 workflow、job 和失败日志 |
| Workflows | 默认 No access；需要修改 `.github/workflows/*` 时开启 Read and write | 推送 workflow 文件改动 |

其他权限保持 No access，包括 Organization permissions、Account permissions、Administration。当前处理 PR 普通评论，Pull requests 写权限可用于该评论接口，**不需要另开 Issues 写权限**。App 的写权限与控制台命令的读写权限是两个层次：拥有推送权限不等于每个命令都会推送。

### Subscribe to events

勾选 **Pull request** 和 **Issue comment**。后者包括 PR 的 Conversation 页普通评论，不是行内审查评论；不要用 Pull request review comment 代替。当前不需要手动订阅 Push、Check run 或 Workflow run，CI 信息在执行时读取。

**Where can this GitHub App be installed?** 自用选 Only on this account；要安装到其他账号或组织才选 Any account。创建后：

1. 记录 **App ID**，不是 Client ID 或 Installation ID。
2. 从 App 页面地址 `https://github.com/apps/<slug>` 确认 slug，例如 `my-team-patchpaw`。
3. 在 **Private keys → Generate a private key** 下载 PEM，稍后上传服务器。
4. 左侧 **Install App → Install**，选择账号/组织，再选 **Only select repositories**，只授权目标仓库。只创建 App 不安装，无法访问仓库。
5. 以后增加权限，安装所属账号还需批准新权限。

服务尚未启动时，首次 ping 失败是正常的，部署后再检查投递。参考：[GitHub 注册指南](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)、[权限指南](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)、[PR 评论接口权限](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)。

## 3. 安装并填写配置

在运行服务的专用账号下执行：

```sh
git clone https://github.com/fengyincheng/patchpawwww.git
cd patchpawwww
npm ci
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
npm run generate:admin-token
```

将最后一条命令生成的 token 存入密码管理器，并填到 `.env` 的 `PATCHPAW_ADMIN_TOKEN`。把下载的 PEM 上传为 `secrets/github-app.private-key.pem`，执行：

```sh
chmod 600 secrets/github-app.private-key.pem
```

编辑 `.env`，替换所有占位值：

```dotenv
PATCHPAW_GITHUB_APP_ID=123456
PATCHPAW_GITHUB_APP_SLUG=my-team-patchpaw
PATCHPAW_GITHUB_WEBHOOK_SECRET=replace-with-your-webhook-secret
PATCHPAW_GITHUB_PRIVATE_KEY_PATH=./secrets/github-app.private-key.pem
PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com
PATCHPAW_PORT=3000
PATCHPAW_GITHUB_TEST_REPO=owner/repository
PATCHPAW_ADMIN_TOKEN=replace-with-your-generated-admin-token
PATCHPAW_HOME=
```

管理员 token 必须填写；保留空的 `PATCHPAW_ADMIN_TOKEN=` 会导致配置校验失败。`.env` 文件和 secrets 目录虽然已被 Git 忽略，也不要把它们上传到 issue 或日志。`.env.example` 是公开模板，不要在其中填写真实凭据。

`PATCHPAW_GITHUB_TEST_REPO` 当前仍为必填，用于被动 PR 事件快照；**它不会自动把仓库加入控制台**，下一步需要显式初始化。`PATCHPAW_HOME` 留空使用运行账号的 `~/.patchpaw`，包含数据库、仓库缓存、工作区、执行记录和服务端凭据，不是临时缓存。换账号或服务管理器时保持数据目录一致。

若使用 Zhipu/Z.ai，在 `.env` 填好 `ZAI_API_KEY`、`ZAI_BASE_URL`、`ZAI_MODEL`；使用其他提供方可先留空，随后在控制台配置并重新绑定模型。完整说明见 [.env.example](.env.example)。

## 4. 初始化仓库并启动

```sh
# 替换为 App 已安装的真实仓库，多个仓库用空格分隔
npm run bootstrap:control-plane -- owner/repository
npm run check
npm run build
npm start
```

初始化会写本地数据库，创建默认 Prompt、Skill、`/review`、`/CI`、`/conflict` 和普通对话配置。默认绑定是 Zhipu 模型；初始化成功不表示模型凭据已可用。**默认 /CI、/conflict 配置具有读写权限**，请在首次使用前检查或禁用不需要的命令。

服务只监听 `127.0.0.1:3000`（端口由配置决定）。在另一个终端执行 `curl http://127.0.0.1:3000/health` 确认响应。长期运行请使用 systemd 或已有进程管理器，以同一账号、同一份配置和数据目录启动；普通前台进程会随终端关闭而退出。修改 `.env` 后重启。

开发/发布验证还应运行 `npm test`。测试使用本地夹具，不需要真实 GitHub 或模型凭据。

## 5. 配置 HTTPS 反向代理

在 DNS 提供商处把子域名指向部署主机，用反向代理把此域名的**全部路径**转发到 `127.0.0.1:3000`。证书申请、续期和公网入口由你维护。

已有 Nginx 和有效证书时，核心配置示例：

```nginx
server {
    listen 443 ssl;
    server_name patchpaw.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

替换证书路径；此示例不会自动申请证书。不要缓存 `/api/*`，不要给 `/github/webhook` 加浏览器登录挑战或改写请求体。无需公网开放 3000 端口，只开放 HTTPS 入口即可。

## 6. 登录并绑定模型

1. 打开公开域名，确认登录页显示的公开地址和 Webhook URL 正确，没有 origin mismatch。
2. 输入第 3 步生成的管理员 token；不是 GitHub 密码或 Webhook secret。
3. 在 Models 页面配置 Provider 地址、凭据和模型标识，确认启用。选择具有所需工具调用能力的模型。
4. 在目标仓库的 Commands 和普通对话配置中选择实际可用的模型并保存。**添加 Provider 不会自动替换默认的 Zhipu 绑定。**
5. 检查命令启用状态、Prompt/Skill 绑定和读写权限；先尝试普通对话或 `/review`，再使用修复流程。

浏览器通过 HttpOnly cookie 保持会话，前端构建不包含管理员 token。忘记 token 时重新生成、修改配置并重启，旧会话失效，没有找回接口。模型密钥只显示是否配置，不回显原值。

## 7. 验证第一条 PR 评论

在 GitHub App 的 **Advanced → Recent Deliveries** 检查投递，修正失败原因后可 Redeliver。`ping` 成功仅表示入口可达，不代表模型可用。

用仓库 owner/member/collaborator 身份，在已安装仓库的 PR **Conversation** 页发表新评论，替换成自己的 App slug：

```text
@my-team-patchpaw /review
```

也可以普通对话：

```text
@my-team-patchpaw 请解释这个 PR 的主要改动
```

不要把固定的 `@patchpaw` 当作自己的 App 名称。普通 Issue、行内审查评论、编辑旧评论都不会按此流程触发；仅打开或更新 PR 不会自动启动模型任务。

Webhook 返回 `202 verification_pending` 表示已入队，还需确认机器人实际回复。修复命令可能提交和推送，受 App 权限、命令配置、分支保护约束，不要为首次验证关闭分支保护。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 启动失败 | Node 版本、必填配置、App ID 数字、PEM 路径/权限、端口占用 |
| `frontend_not_built` | 在同一 checkout 执行 `npm run build` |
| 登录来源不匹配 | 浏览器域名、PUBLIC_ORIGIN、代理 Host 一致；改配置后重启 |
| Webhook 401 | GitHub 与本地 secret 一致、代理未改请求体 |
| GitHub 403/404 | App 安装范围、权限批准、仓库名称、分支规则 |
| 评论无反应 | slug、Issue comment 订阅、PR 普通新评论、作者身份、初始化和命令启用状态 |
| Provider unavailable / 配置不完整 | 密钥、端点、模型及命令/对话绑定 |
| 重启后数据消失 | 账号或 PATCHPAW_HOME 改变，检查实际目录 |

## 维护与限制

升级前停止服务并备份运行目录、`.env` 和 App 私钥，备份含敏感信息。更新后执行 `npm ci`、`npm run check`、`npm test`、`npm run build` 再启动。备份、恢复和迁移说明见 [运维文档](docs/OPERATIONS.md)，先阅读脚本参数再操作。

本项目是单管理员自托管工具，不提供租户隔离或 OS 沙箱。模型结果需要人工审阅；平台 CI 通过也不表示所有目标项目工具链可运行。安全报告见 [SECURITY.md](SECURITY.md)，不要公开上传凭据、私有代码或未脱敏日志。许可证：[Apache-2.0](LICENSE)。
