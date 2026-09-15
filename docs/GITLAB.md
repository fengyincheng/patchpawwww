# GitLab 从零接入 PatchPaw

[English version](GITLAB.en.md)

PatchPaw 已支持 **GitLab.com** 和 **GitLab Self-Managed**。如果你只使用 GitLab，**不需要注册 GitHub App**；GitHub 与 GitLab 也可以同时接入同一个 PatchPaw 实例。

这篇文档按“第一次配置的人真的能跑通”为目标编写，覆盖：

- Bot / Service Account 怎么准备；
- PAT / Project Token 怎么选、需要哪些 scope；
- 什么是 GitLab **Project ID**；
- PatchPaw 第一次 GitLab-only 启动怎么配；
- Webhook 到底勾哪个事件；
- 怎么创建第一个 MR；
- 怎么先测普通对话，再测 `/review`，最后测读写命令；
- 常见的“Webhook 明明成功但机器人不回”“ProviderUnavailable”“dispatched 但没结果”等问题。

> 如果你已经有一个正常运行的 PatchPaw，只想新增 GitLab，可以直接跳到 [方式 B：在 Web 控制台添加 GitLab 连接](#方式-b在-web-控制台添加-gitlab-连接)。

---

## 先记住：GitLab 里没有 PR，叫 MR

GitHub 和 GitLab 的叫法不同：

| GitHub | GitLab |
| --- | --- |
| Pull Request / PR | Merge Request / MR |
| PR Conversation comment | MR ordinary Note / Comment |
| Repository | Project |
| GitHub App | GitLab Bot / Service Account / Access Token connection |

所以这篇教程里看到 **MR**，就把它理解成 GitLab 版的 PR。

PatchPaw 当前主要监听的是：

> **MR 页面里的“普通新评论 / Note”**

不是普通 Issue，不是行内 Discussion，不是系统 Note，也不是编辑一条旧评论。

---

## 你最终要准备什么

完整 GitLab 接入需要以下几样东西：

| 项目 | 示例 | 用途 |
| --- | --- | --- |
| GitLab 实例地址 | `https://gitlab.com` | GitLab.com 或 Self-Managed 根地址 |
| Bot 用户名 | `patchpaw-bot` | PatchPaw 在 MR 中被 @ 的账号 |
| GitLab token | 不要写进文档 | API、评论发布、Git HTTPS |
| Numeric Project ID | `12345678` | 项目白名单与稳定标识 |
| Connection ID | `gitlab-prod` | PatchPaw 内部连接名，也进入 Webhook URL |
| Webhook secret | 随机值 | 验证 GitLab Webhook |
| PatchPaw 公开 HTTPS 地址 | `https://patchpaw.example.com` | 浏览器与 Webhook 共用 |
| 可用模型凭据 | 例如 DeepSeek / Zhipu | conversation、review、custom 等 Agent 执行 |

推荐先只接 **一个测试项目**，完整跑通后再把更多 Project ID 加入白名单。

---

# 第一部分：在 GitLab 准备 Bot

## 1. 推荐使用独立 Bot / Service Account

不要优先拿你自己的日常 GitLab 账号 token 直接给 PatchPaw。

更推荐：

1. GitLab 计划/实例支持 Service Account 时，创建一个专用 Service Account；
2. 或创建一个专门用于 PatchPaw 的普通 GitLab 用户；
3. 如果你的计划允许 Project / Group Access Token，也可以使用对应 token。

为什么推荐独立身份：

- MR 里一眼能区分“人”和“PatchPaw”；
- PatchPaw 会忽略自己发出的评论，避免自触发；
- token 泄露时可以单独撤销，不影响你的个人账号；
- 权限可以只授予需要的项目。

一个典型用户名：

```text
patchpaw-bot
```

或者：

```text
patchpaw-smoke
```

> GitLab 不同版本、套餐和管理员策略下，Service Account / Project Access Token 的入口可能不同。如果你在项目里找不到 Project Access Token，不要卡在这里：**独立 Service Account/机器人账号 + PAT 完全可以使用。**

---

## 2. 把 Bot 加到目标 Project

进入你要接入的 GitLab Project，把 Bot 加为项目成员。

推荐最低角色：

```text
Developer
```

PatchPaw 对可执行评论和批准路径要求评论者当前是有效成员，并且至少达到 Developer 级别。

同时注意两个身份：

- **Bot 自己**需要足够权限读取 MR、发表评论，读写任务还需要能推送 source branch；
- **发命令的人类用户**也需要 Developer 或更高权限，否则评论可能被记录，但不会启动执行。

如果项目有 Protected Branch / Branch Rules，最终 push 仍然受 GitLab 规则限制。不要为了测试 PatchPaw 就关闭已有分支保护。

---

## 3. 给 Bot 创建 Access Token

### 推荐 scope

要使用完整功能，建议 token 至少包含：

```text
api
write_repository
```

用途：

- `api`：读取 MR / Note / 成员 / Pipeline / Job，并发布 MR Note；
- `write_repository`：通过 Git HTTPS 把受控修改 push 回 MR source branch。

如果只做只读实验，权限可以再收紧；但要测试 conversation、review 发布和读写命令，直接使用上面的组合最省事。

### 一个非常重要的坑：token 明文只给你一次

创建 token 后，GitLab 通常只在创建成功页面展示一次完整值。

**先复制保存，再离开页面。**

如果你忘记复制：

- 列表里看到 token 仍然 Active，不代表还能把原文展开；
- 不要截图或把 token 发到 issue / 聊天；
- 直接 revoke / rotate，再创建一个新的。

PatchPaw 的 Web 控制台也不会把已保存的 token 明文重新显示出来。

---

# 第二部分：找到正确的 Project ID

## 4. 什么是 Project ID

PatchPaw 要的是 GitLab 项目的 **numeric Project ID**，例如：

```text
86488295
```

不是：

- MR 编号 `!1`；
- Group ID；
- 用户 ID；
- 项目 URL；
- `group/project` 里的某个数字。

通常可以在项目首页的项目摘要区域或 **Settings → General** 一类页面找到 Project ID。GitLab UI 版本不同，位置可能变化，但字段名称通常就叫 **Project ID**。

建议配置时直接使用 numeric ID。它比项目路径稳定，项目改名或移动 namespace 时不容易出问题。

多个项目可以写成：

```text
42, 77, 12345678
```

在 `.env` JSON 中则写成数组：

```json
["42", "77", "12345678"]
```

---

# 第三部分：准备 PatchPaw 公网地址

## 5. Webhook 需要公网 HTTPS

GitLab.com 无法访问你的：

```text
http://127.0.0.1:3000
```

你需要一个 GitLab 能访问的 HTTPS 地址，例如：

```text
https://patchpaw.example.com
```

GitLab Webhook 地址格式是：

```text
https://patchpaw.example.com/gitlab/webhook/<connection-id>
```

如果 Connection ID 是：

```text
gitlab-prod
```

那 Webhook URL 就是：

```text
https://patchpaw.example.com/gitlab/webhook/gitlab-prod
```

### 只是临时 smoke，可以用 Quick Tunnel

例如把 PatchPaw 临时跑在本机/服务器的 3101：

```sh
cloudflared tunnel --url http://127.0.0.1:3101
```

它会给一个临时 HTTPS 地址。

注意：

- Quick Tunnel URL 重启后可能变化；
- URL 一变，`PATCHPAW_PUBLIC_ORIGIN` 和 GitLab Webhook URL 都要一起更新；
- 正式部署还是建议固定域名 + HTTPS 反向代理。

---

# 第四部分：配置 PatchPaw

有两种方式。

---

## 方式 A：全新的 GitLab-only PatchPaw

这是最容易踩坑的情况。

### 6. 先创建真实的 `.env`

在项目根目录：

```sh
cp .env.example .env
chmod 600 .env
npm run generate:admin-token
```

**不要把 `.env` 删掉。**

PatchPaw 的 detached worker 会重新加载项目根目录的 `.env`。如果主服务靠临时 shell 环境变量启动，但之后 `.env` 不存在，可能出现这种假象：

```text
Webhook 收到了
→ inbound = dispatched
→ 但 worker 一启动就退出
→ 没有 state / outbound / 模型回复
```

所以 GitLab-only 也应该保留一份真实 `.env`。

### 7. GitHub 配置要么全填，要么全空

如果你只使用 GitLab，请把 GitHub 那组配置保持为空。

不要出现：

```text
只填了 App ID
但 secret / private key / repo 没填
```

这种“填一半”的状态会被认为是 GitHub 配置不完整。

### 8. 生成 Webhook secret

例如：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Webhook secret 和 GitLab PAT 是两种完全不同的秘密，不要共用。

### 9. 写入 GitLab bootstrap 配置

一个 GitLab.com 示例：

```dotenv
PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com
PATCHPAW_PORT=3000
PATCHPAW_ADMIN_TOKEN=<你生成的管理员 token>
PATCHPAW_HOME=

PATCHPAW_GITLAB_CONNECTIONS=[{"id":"gitlab-prod","instance_url":"https://gitlab.com","project_ids":["12345678"],"token_env":"PATCHPAW_GITLAB_TOKEN","webhook_secret_env":"PATCHPAW_GITLAB_WEBHOOK_SECRET","webhook_mode":"secret","bot_login":"patchpaw-bot"}]
PATCHPAW_GITLAB_TOKEN=<Bot 的 GitLab token>
PATCHPAW_GITLAB_WEBHOOK_SECRET=<刚生成的 webhook secret>
```

### 字段解释

| 字段 | 怎么填 |
| --- | --- |
| `id` | 你给这条连接起的名字，例如 `gitlab-prod` |
| `instance_url` | `https://gitlab.com` 或 Self-Managed 根地址 |
| `project_ids` | 允许 PatchPaw 处理的 numeric Project ID |
| `token_env` | 保存 PAT 的环境变量名 |
| `webhook_secret_env` | 保存 Webhook secret 的环境变量名 |
| `webhook_mode` | 第一次配置建议 `secret` |
| `bot_login` | Bot 的 GitLab username；可选，但填写时必须与 token 实际身份一致 |

Self-Managed 例子：

```text
https://gitlab.example.com
```

不要写：

```text
https://gitlab.example.com/api/v4
```

PatchPaw 会自己处理 API 路径。

### 10. 为什么 fresh GitLab-only 要 bootstrap

全新运行目录里，如果：

- 没有完整 GitHub App 配置；
- 没有 `PATCHPAW_GITLAB_CONNECTIONS`；
- 也没有已有 control-plane GitLab connection；

PatchPaw 会拒绝启动。

所以第一次 GitLab-only 启动时，最稳妥的方法就是先通过 `.env` bootstrap 一条 GitLab connection。

---

## 方式 B：在 Web 控制台添加 GitLab 连接

如果 PatchPaw 已经能启动，例如：

- 已经接了 GitHub；
- 或已有 control-plane / SCM connection；

可以在 Web 控制台进入：

```text
Settings / Operator settings
→ GitLab connections
```

填写：

| UI 字段 | 内容 |
| --- | --- |
| Connection ID | `gitlab-prod` |
| Instance URL | `https://gitlab.com` |
| Project IDs | `12345678`，多个用逗号分隔 |
| Bot username | `patchpaw-bot` |
| PAT / project token | Bot token |
| Webhook secret | 你生成的随机 secret |

保存后可以点 **Verify / 验证**。

验证成功时，PatchPaw 会通过 token 实际读取当前 GitLab 身份。这里最重要的是：

> token 属于谁，PatchPaw 的 Bot 就是谁。

不要把自己的 PAT 填进去，却把 Bot username 写成另一个 Service Account。

### Secret 模式和 Signing 模式

Web 控制台的常规配置走 legacy secret 模式，最适合第一次接入。

也就是：

```text
webhook_mode = secret
```

GitLab Webhook 通过 `X-Gitlab-Token` 验证。

PatchPaw 也支持 Standard Webhooks signing 模式，但第一次部署没有必要先把复杂度拉高。

---

# 第五部分：启动 PatchPaw

## 11. 安装、检查、构建

```sh
npm ci
npm run check
npm run build
npm start
```

本机健康检查：

```sh
curl http://127.0.0.1:3000/health
```

或者你使用的其他端口。

然后再检查公网：

```text
https://patchpaw.example.com/health
```

两边都正常后再配 GitLab Webhook。

---

# 第六部分：配置 GitLab Webhook

## 12. 在 Project 里添加 Webhook

进入目标 GitLab Project：

```text
Settings
→ Webhooks
```

### URL

```text
https://patchpaw.example.com/gitlab/webhook/gitlab-prod
```

最后一段必须与你的 PatchPaw Connection ID 一致。

### Secret token

填与 PatchPaw 中完全相同的 Webhook secret。

**不是 PAT。**

### Events

第一次 smoke，建议只开：

```text
Comments / Note events
```

GitLab 不同版本的文案可能显示为 Comments、Note events 或相近名称。

不要为了“保险”一口气把所有事件全开。

PatchPaw 当前主要消费：

- 新创建；
- 普通 MR Note；
- 包含 Bot mention；
- 属于允许的 Project ID。

以下不会按这条入口执行：

- 普通 Issue comment；
- System Note；
- inline Discussion；
- 编辑已有 Note；
- unrelated Project；
- Bot 自己发出的 Note。

---

# 第七部分：做第一条 MR

## 13. 先造一个最小 MR

项目只有 `main` 时，没有东西可以提 MR。

可以新建：

```text
smoke/hello
```

改 README 一行，例如：

```text
PatchPaw GitLab smoke test.
```

提交到 `smoke/hello`，然后创建：

```text
Source branch: smoke/hello
Target branch: main
```

GitLab 左侧的 **Merge requests** 就是 GitHub 的 Pull requests。

---

# 第八部分：第一次不要急着 /review

## 14. 先测普通对话

在 MR 的普通评论框里发：

```text
@patchpaw-bot 你好，简单介绍一下这个 MR
```

推荐先测这个，因为它能快速验证：

```text
GitLab Note
→ Webhook
→ secret 校验
→ Project allowlist
→ Bot mention
→ 人类成员权限
→ MR 读取
→ 模型
→ durable outbox
→ GitLab Note 回复
```

如果这一步能回，说明 GitLab 接入主链已经很健康。

---

## 15. 再测 /review

普通对话成功后，再发：

```text
@patchpaw-bot /review
```

正常会：

- 读取当前 MR head；
- 读取 target/base；
- 创建只读 worktree；
- 让 Review Agent 审查；
- 再检查 head 新鲜度；
- 发布 MR Note。

注意：

> **普通对话能用，不代表 /review 一定用了同一个模型。**

PatchPaw 的 conversation、`/review`、`/CI`、`/conflict`、custom 命令都可以绑定不同 Provider/Model。

所以如果对话成功但 `/review` 报：

```text
ProviderUnavailable
Provider credential is unavailable
```

优先去 Web 控制台检查 **/review 自己绑定的模型凭据**，不要先怀疑 GitLab Webhook。

---

# 第九部分：命令与读写权限

## 16. 默认命令

仓库初始化后常见默认命令：

```text
/review
/CI
/conflict
```

系统控制命令还包括：

```text
/stop
/close
/approval
```

`/repair` **不是默认创建的命令**。如果需要，可以在控制台自行创建一个执行类型为 `repair` 的命令。

自定义 `/edit` 也不是固定内置命令；它只是一个典型 custom command 名称。

---

## 17. Custom read_only 和 read_write

你可以在 Web 控制台为 custom 命令选择：

```text
read_only
```

或：

```text
read_write
```

### read_only

Agent 只能读取和分析，不会获得可写 workspace。

### read_write

GitLab same-project MR 中，Agent 可以修改 workspace。

写回流程由 Harness 收口：

```text
Agent 修改
→ Harness 检查候选
→ 如果 Agent 已完整 commit：不重复 commit
→ 如果 Agent 只留下未提交修改：Harness 自动 commit
→ 普通非 force push
→ GitLab API 确认 remote MR head
→ 最后才发布成功 Note
```

如果 Agent 自己 commit 后还残留未提交修改，Harness 会把残余改动再收成 commit，不能静默丢掉。

PatchPaw 会阻止 Agent 自己直接 push；远端写入由 Harness 负责。

### Fork MR

跨项目 fork MR 当前保持只读边界。

即使 custom 命令配置为 `read_write`，也不会跨项目擅自 push。

---

# 第十部分：谁可以发命令

## 18. 人类评论者也有权限要求

PatchPaw 收到 MR Note 后，会重新向 GitLab 查询用户与项目成员关系。

默认执行门槛：

- 用户状态必须明确是 active；
- 必须明确是人类账号，而不是 Bot；
- 项目权限至少 Developer；
- Bot 自己的评论不会触发自己。

所以：

```text
Webhook delivery 成功
```

并不意味着：

```text
这条评论一定会启动模型
```

如果评论者只有 Guest / Reporter，执行会被拒绝。

---

# 第十一部分：Self-Managed 注意事项

## 19. Instance URL 只填根地址

正确：

```text
https://gitlab.company.example
```

不要写：

```text
https://gitlab.company.example/api/v4
```

不要在 URL 中塞：

- username/password；
- token；
- query；
- fragment。

生产环境推荐 HTTPS。

如果 Self-Managed 在反向代理后面，确保：

- PatchPaw 主机能访问 GitLab API；
- PatchPaw 主机能通过 HTTPS Git fetch/push；
- GitLab 能从公网或你的网络路径访问 PatchPaw Webhook；
- 证书链对双方都可验证。

---

# 第十二部分：怎么看一次任务到底走到哪了

## 20. `dispatched` 不等于“任务成功”

这是很容易误判的一点。

PatchPaw 的 inbound 状态变成：

```text
dispatched
```

通常只表示：

> 入站验证完成，worker 已经被调度。

它不等于：

- 模型已经开始；
- 模型已经完成；
- Note 已经发布；
- Git push 已经成功。

完整成功还应看到对应 run/result 与 outbound publication。

典型终态包括：

```text
conversation_completed
review_completed
custom_completed
ci_completed
repair_completed
needs_human
provider_unavailable
review_stale
```

---

# 第十三部分：我们真实踩过的常见问题

## 21. GitLab Webhook 显示成功，但机器人完全不回

按这个顺序检查：

1. Webhook URL 最后一段是否等于 Connection ID；
2. GitLab Secret token 是否等于 PatchPaw Webhook secret；
3. 是否勾选 Comments / Note events；
4. 评论是不是 **MR 普通新评论**；
5. 是否真的 `@你的 Bot username`；
6. Project ID 是否在 allowlist；
7. 评论者是否 Developer+；
8. Bot token 是否还能读取项目；
9. PatchPaw worker 是否真正产生 run；
10. 项目根目录 `.env` 是否仍存在。

尤其是最后一条：主进程能跑，不代表后续 detached worker 不会因为缺失 `.env` 在启动时直接退出。

---

## 22. conversation 成功，但 /review 没回复

非常可能是模型配置，不是 GitLab。

检查：

- `/review` 当前绑定哪个 Provider；
- 对应 Provider credential 是否已经保存；
- Model identifier 是否正确；
- Provider 是否启用。

不同命令可以使用不同模型。

---

## 23. PAT 忘记复制

不要继续找“显示 token”的按钮。

直接：

1. revoke / rotate 旧 token；
2. 创建新的；
3. 立刻复制；
4. 更新 PatchPaw；
5. 重启或重新验证连接。

---

## 24. Verify 报 Bot identity stale

如果配置里写了：

```text
bot_login=patchpaw-bot
```

但 token 实际属于另一个用户，PatchPaw 会拒绝连接。

解决：

- 换成真正属于 Bot 的 token；
- 或修正 Bot username。

不要让“配置里写谁”和“token 真正是谁”分离。

---

## 25. Webhook 401 / secret mismatch

确认你没有把这两个值搞混：

```text
GitLab PAT
Webhook secret
```

PAT 用于 API/Git。

Webhook secret 只用于验证 GitLab → PatchPaw 的 Webhook。

---

## 26. Quick Tunnel 昨天能用，今天突然失效

临时 tunnel URL 可能变化。

重新启动 tunnel 后，要同时更新：

- `PATCHPAW_PUBLIC_ORIGIN`；
- GitLab Webhook URL。

然后重启 PatchPaw。

---

## 27. Custom read_write 没有 push

检查：

- 命令 permission 是否真的保存为 `read_write`；
- source 与 target 是否同一个 GitLab project；
- Bot 是否能 push source branch；
- Protected Branch / Branch Rules 是否允许；
- 任务有没有发生 remote head/base drift；
- Agent 是否实际产生修改。

No-op 是合法的：

```text
writeback = no_changes
```

这种情况不会制造空 commit。

---

# 第十四部分：最小验收顺序

## 28. 推荐你严格按这个顺序测

### L0：连接

- PatchPaw `/health` 正常；
- GitLab token 身份正确；
- Project ID 白名单正确；
- Webhook recent events 能送达。

### L1：普通 conversation

```text
@patchpaw-bot 你好，简单介绍一下这个 MR
```

### L2：review

```text
@patchpaw-bot /review
```

### L3：读写 custom

先在 Web 控制台创建例如：

```text
/edit
execution_type = custom
permission = read_write
```

然后：

```text
@patchpaw-bot /edit 采纳上面的建议
```

确认：

- source branch 出现新 commit；
- target/main 没变化；
- MR Changes 里能看到真实修改；
- PatchPaw 最终 Note 中带 Harness 确认的 commit SHA。

### L4：CI / conflict

最后再测试：

```text
@patchpaw-bot /CI
```

以及：

```text
@patchpaw-bot /conflict
```

冲突修复需要后续明确 `/approval`，不要把普通的“继续”“同意”当作批准。

---

# 第十五部分：安全与备份

GitLab token、Webhook secret、Provider credentials 都是服务端秘密。

不要：

- 提交进 Git；
- 发到 Issue；
- 截图公开；
- 放在 clone URL；
- 贴进普通日志。

持久化 SCM secret 保存在 PatchPaw runtime 的受保护 secret slots 中。备份 runtime 时也应把备份本身当作敏感文件保护。

详细安全边界见：

- [Security Model](SECURITY-MODEL.md)
- [Operations](OPERATIONS.md)

---

# 最后给第一次配置的人一张清单

如果你只想确认自己有没有漏东西：

- [ ] 有独立 Bot / Service Account
- [ ] Bot 已加入目标 Project，至少 Developer
- [ ] token scope 满足 `api` + `write_repository`
- [ ] token 已安全保存，没有发到聊天/Issue
- [ ] 找到 numeric Project ID
- [ ] 有公网 HTTPS PatchPaw 地址
- [ ] fresh GitLab-only 有真实 `.env`
- [ ] `PATCHPAW_GITLAB_CONNECTIONS` JSON 有效
- [ ] Connection ID 已确定
- [ ] Webhook secret 已生成
- [ ] GitLab Webhook URL 为 `/gitlab/webhook/<connection-id>`
- [ ] Webhook 开了 Comments / Note events
- [ ] 人类测试账号也是 Developer+
- [ ] 普通 conversation 已回
- [ ] `/review` 绑定的 Provider/Model 有凭据
- [ ] read_write custom 只在 same-project MR 测
- [ ] 最终以 GitLab remote head / MR Changes 为准，不只看 Agent 自述

如果这张表全部打勾，GitLab 接入基本就完成了。
