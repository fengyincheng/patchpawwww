# 配置参考

PatchPaw 从项目根目录的 `.env` 读取启动配置。请以 `.env.example` 为模板，复制后逐项填写；`.env`、GitHub App 私钥、Webhook secret 和模型密钥都不应提交。

## 平台配置

Configure GitHub, GitLab, or both. GitHub keeps its existing App variables. GitLab uses one JSON connection array and can address GitLab.com or self-managed instances.

### GitLab connection

```dotenv
PATCHPAW_GITLAB_CONNECTIONS=[{"id":"gitlab-prod","instance_url":"https://gitlab.example.com","project_ids":["42"],"token_env":"PATCHPAW_GITLAB_TOKEN","webhook_secret_env":"PATCHPAW_GITLAB_WEBHOOK_SECRET","webhook_mode":"secret","bot_login":"patchpaw"}]
PATCHPAW_GITLAB_TOKEN=replace-me
PATCHPAW_GITLAB_WEBHOOK_SECRET=replace-me
```

`id` must be unique. `project_ids` is the allowlist. `webhook_mode` is `secret` or `signing`; signing mode uses Standard Webhooks headers. Use the Settings page to persist connections and protected credential slots instead of putting token values in the JSON string. Full setup and permission details are in [GitLab setup](GITLAB.md).

### GitHub variables

| 变量 | 用途 |
| --- | --- |
| `PATCHPAW_GITHUB_APP_ID` | GitHub App 的数字 ID；使用 GitLab 时可省略整组 GitHub 变量。 |
| `PATCHPAW_GITHUB_APP_SLUG` | GitHub App slug，用于识别 App bot。 |
| `PATCHPAW_GITHUB_WEBHOOK_SECRET` | GitHub App Webhook 签名密钥。 |
| `PATCHPAW_GITHUB_PRIVATE_KEY_PATH` | App 私钥 PEM 路径；相对路径从项目根目录解析。 |
| `PATCHPAW_PUBLIC_ORIGIN` | 浏览器、写入保护和 Webhook 共用的 scheme + host，不带路径。 |
| `PATCHPAW_PORT` | 本机监听端口。 |
| `PATCHPAW_GITHUB_TEST_REPO` | 事件处理路径使用的 `owner/repository`。 |

生产环境推荐 `PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com`，由反向代理终止 TLS。localhost 开发可以使用明确的 `http://localhost:3000`，但不要把 HTTP 当作生产配置。公开来源、浏览器和 Webhook 的 scheme、host、port 应一致；GitHub Webhook 使用 `/github/webhook`，GitLab Webhook 使用 `/gitlab/webhook/<connection-id>`。

## 管理员 token

运行 `npm run generate:admin-token`，把唯一输出行放入服务端 `.env` 的 `PATCHPAW_ADMIN_TOKEN` 后重启。生成器不会写文件，服务端不会通过 API 回显 token；丢失后只能生成替代 token。替换并重启会使内存中的旧会话失效。

控制台部署必须填写 token；保留空的 `PATCHPAW_ADMIN_TOKEN=` 会导致启动校验失败。

## Provider

首次 bootstrap 可使用 `ZAI_API_KEY`、`ZAI_BASE_URL`、`ZAI_MODEL` 和可选 `ZAI_REASONING_EFFORT`。其他支持的 Provider 在控制台 Models 页面添加。Provider 凭据写入服务端的受保护运行存储，API 只返回 `credential_configured` 和不含秘密的引用状态。

## 运行目录

`PATCHPAW_HOME` 是可选覆盖。未设置时 Linux/macOS 使用 `~/.patchpaw`。原生 Windows 暂不支持。运行目录包含持久数据库、仓库缓存、工作区、执行记录、快照、日志、备份、锁和凭据引用；它不是可以随意清理的缓存。迁移、备份和恢复前先确认路径，并限制服务账号访问权限。

## 修改配置后的检查

修改环境变量后重启服务，然后依次运行：

```sh
npm run check
npm test
npm run build
```

登录页和 Settings 的 setup 面板可确认来源地址、Webhook URL、HTTPS、管理员认证和浏览器来源是否匹配。
