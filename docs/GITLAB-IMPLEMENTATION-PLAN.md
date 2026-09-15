# GitLab 支持：调研结论与可执行交接计划

日期：2026-09-15。状态：**设计与执行计划，尚未实现 GitLab 支持**。

## 1. 结论与执行范围

可行。GitLab 提供现有产品所需的 MR、普通评论、项目成员、流水线、job 日志和 Git 访问能力。主要成本是把 GitHub 依赖从持久化状态、调度器和 worker 中抽出，而不只是新增一个 API client。官方依据见配套 [GitLab API 调研](gitlab-api-research.md)。

本计划**仅针对当前开源版，为其他使用者提供 GitLab 适配**。项目维护者本人没有 GitLab 使用需求；私用版不属于实施、测试、迁移或后续同步范围，下一窗口无需访问私用版。先交付一个同时支持现有 GitHub App 和 GitLab 连接的进程；GitLab-only 部署无需 GitHub App 配置。这里的 GitHub 兼容与数据迁移要求服务于开源版现有使用者。实现期间不部署、不操作真实 MR。用户本次请求是调研与计划，后续窗口获得实施指令后按本文件执行。

### 首版范围（设计决定）

| 能力 | 首版行为 |
| --- | --- |
| 部署 | GitLab.com 和自托管 GitLab；允许多个 GitLab 连接，共存于现有单个 GitHub App 部署 |
| 认证 | 服务端保存 PAT 或项目访问 token；使用独立机器人账号更便于识别。先支持 HTTPS Git；不做 OAuth 安装流程或 SSH 凭据管理 |
| 触发 | 已有 MR 的新建普通 Note 中 `@机器人 /命令`；不处理普通 Issue、行内 discussion、编辑评论、系统 note、自身评论 |
| 任务 | conversation、custom、review；同项目分支的 CI/repair/conflict 与批准后推送 |
| 审查 | 发布包含 head SHA 和发现列表的 MR 普通 Note；现有 GitHub review 也只是 COMMENT 摘要，不需要先实现 GitLab 行内审查 |
| 生命周期 | `/stop`、`/close`、恢复、持久收发件、重投去重、冲突方案批准沿用现有语义；`/close` 只清本地会话 |
| fork MR | 支持可访问代码的只读对话/审查；修复发布明确拒绝，延续当前 GitHub 限制 |
| 暂缓 | 自动创建/合并 MR、GitLab 审批 API、merge train 完整支持、跨项目推送、自动配置 webhook、普通 Issue agent |

不要把 PatchPaw `/approval` 映射成 GitLab “批准 MR”：前者是授权执行已发布的冲突修复方案，后者是平台合并审批，两者不同。

自托管不能宣称兼容所有历史版本。首版先实现 REST v4 所需能力，在实测实例上记录版本、edition 和测试结果，再发布兼容范围；不依赖最新的可选 webhook 字段才能工作。

## 2. 已完成的源码调查

开源版基线：`449aa8bbe98b5f5ad42aaca6bb228c9bde7e72ad`。这是调研时的 HEAD，不意味着要求后续窗口回退代码。

初次调研曾只读比较两个变体，确认 `src/github/` 一致；该比较仅为历史调查背景，不构成私用版适配或同步任务。全部设计、实现与验收以当前开源版为准，保留其 `src/platform/` 和公开 setup 等现有能力。

调研时基线验证：`npm run check` 通过。`npm test` 已运行，但 `ci.test.ts`、`model-adapters.test.ts`、`outbound-scheduler.test.ts`、`repair-verification.test.ts` 报 `ERR_TEST_FAILURE`/exit 1，输出未提供具体断言；其后测试未正常结束，已主动中断（exit 130）。**未认定根因，未声称全量通过**。下一窗口 T0 先单独重跑上述文件并检查测试环境；本次仅写文档，没有为测试失败修改实现。build/frontend 验证本次未运行。

| 现有文件 | 绑定点与实施影响 |
| --- | --- |
| `src/config/env.ts`, `src/index.ts` | GitHub 字段全部必填，启动直接创建 GitHub client；必须按已启用平台校验 |
| `src/github/client.ts`, `pull-request.ts` | installation token、Octokit、`owner/repo` 拆分和 PR 原生返回对象进入核心 |
| `src/server/app.ts`, `src/github/comments.ts` | HMAC webhook、GitHub author_association、`[bot]`、仅两段仓库名 |
| `src/runner/inbound-verification.ts` | 通过 installation 验证仓库；GitLab 需连接、项目、MR、Note 与作者权限验证 |
| `src/runner/pull-request.ts` | worker 内多处直接访问 `client.rest`，包括 close、恢复、评论补读、目标分支、批准和发布前后检查 |
| `src/runner/communication-scheduler.ts`, `outbound.ts`, `recovery.ts` | 调度器重新查 installation，使用 GitHub 评论/review API 去重和恢复 |
| `src/control-plane/common.ts`, `schema.ts`, `repositories.ts` | 仓库只能两段；`full_name_normalized` 全局唯一，不能容纳跨平台同名项目 |
| `src/runner/communication-store.ts` | inbox 唯一键 `(repo, pr_number, comment_id)`；outbox 唯一键 `(repo, pr_number, semantic_key)`，repo 必须变成不歧义的身份键 |
| `src/runner/state.ts`, `src/github/snapshot.ts` | `repo.replace('/', '__')` 构造路径，直接用于 GitLab subgroup 会留下斜杠 |
| `src/harness/pr-memory.ts` | 线程 ID 固定 `github:${repo}:pr:${number}`；与清理和旧记忆兼容有关 |
| `src/workspace/git.ts`, `repo-store.ts`, `manager.ts` | Git auth 固定 github.com，缓存只按 repo，Git 作者固定 GitHub bot；push 默认 origin |
| `src/runner/conflict-approval.ts`, `conflict-proposals.ts` | 审批记录固定 GitHub author_association；不可变记录与摘要不能直接改写 |
| `src/workspace/verification-inputs.ts` | 验证输入覆盖 `.github/workflows`，需加入 `.gitlab-ci.yml` 及可识别的本地 include |
| `src/server/admin-api.ts`, `web/src/api.ts`, `App.tsx`, `i18n.tsx` | 路由和选择状态以 full_name 为键；不能只放宽表单正则 |
| `src/migration/*`, `scripts/*`, `operation/*`, `docs/*` | 发现仓库、运行入口、备份恢复、提示词与运维说明都需跟进 |

可复用：模型适配、工具执行、任务结果格式、Git worktree、验证证据、队列重试和绝大多数生命周期逻辑。保持 `src/platform/` 的现有含义（操作系统兼容）；代码托管适配放入 **`src/scm/`**，避免与模型 `providers` 混淆。

## 3. 目标结构与接口边界

建议目录：`src/scm/types.ts`、`identity.ts`、`registry.ts`、`github/adapter.ts`、`gitlab/{client,adapter,webhook,ci}.ts`。已有 `src/github/` 可先保留为 GitHub adapter 的实现，避免无价值的大规模移动。

```text
GitHub webhook ─┐
                ├→ 规范化事件 → durable inbox → 远端验证/授权 → scheduler/worker
GitLab webhook ─┘                                      │
                                   ScmAdapter ←────────┤
                                      │                └→ Git workspace/任务
                                 GitHub / GitLab
                                      ↑
                              durable outbox + 重启恢复
```

### 身份模型（先完成，再接入事件）

- `ScmConnection`：不可变 ID、kind、规范化实例 URL（包含自托管相对路径）、credentialRef、bot user ID/login、启用状态。URL 或平台改变视为新连接；token 轮换不改变连接 ID。
- `RepositoryRef`：已有 control-plane UUID、connectionId、remoteProjectId、pathWithNamespace、webUrl、cloneUrl、storageKey。GitLab ID 使用 API 确认的项目 ID；嵌套 namespace 是展示/定位信息，不是永久身份。
- `ChangeRequestRef`：repositoryId + 项目内 number；GitLab 使用 **iid**，不是全站 MR id。
- `ChangeRequestSnapshot`：源/目标项目身份、源/目标分支、headSha、目标分支最新 tip、diff base（独立字段）、状态、标题/正文、作者、webUrl；不把 GitLab diff base 当成目标分支 tip。
- `InboundComment`：connection/repository/changeRequest、remote note ID、作者 numeric ID/login、创建时间、body、来源事件身份、平台授权证据。GitHub installation 信息仅留在平台专属字段，不给 GitLab 填虚假的 installation_id。
- `ActorAuthorization`：平台、actorId、检查时间、读取到的角色/来源、可执行/可批准布尔值。新记录不伪造 `MEMBER`；旧 GitHub 审批仍走 legacy reader。

### Adapter 需要覆盖的操作

按现有调用点落地接口，不建立通用 Octokit 仿制品：

1. 获取仓库/MR、最新目标分支 tip、机器人身份。
2. 读取单条评论、分页列表、验证事件身份及作者权限。
3. 发布普通评论/审查摘要，查询当前机器人已发布的 marker，返回统一 receipt。
4. 获取 CI 状态与失败证据（携带 project/pipeline/job/SHA/source）。
5. 提供受控 Git transport 和 MR head fetch 计划；凭据只在服务端短暂使用。
6. capabilities：审查发布方式、同项目修复、fork 只读、日志可用性等。

freshness 检查可放在公共层，通过 adapter 获取远端事实。保留现有“发布前重新检查 head/base/ref/open；推送后确认”的规则和自己刚推送 head 的有限等待，不能只信 webhook 或 `merge_status`。

runner/tasks/harness 不接收 Octokit/GitLab 原始模型；GitHub-specific 字段的迁移读写集中在 compatibility 层。不要将整个 `pull-request.ts` 复制成 `merge-request.ts`。

## 4. 状态兼容方案

采用**旧 GitHub 存储身份保持不变，新 GitLab 身份使用隔离键**，首版避免迁移全部运行目录：

1. 现有 GitHub repository UUID、`owner/repo` storageKey、state/cache 路径和 memory thread ID 原样保留。旧 JSON 缺平台字段时只解释为默认 GitHub 连接，绝不按当前“默认平台”猜测。
2. GitLab storageKey 固定为 `gitlab:<connection-id>:project:<project-id>`。路径使用专门的 `v2-<sha256(storageKey)>` 安全编码，不把展示路径交给旧 `replace`；memory thread 使用独立 `gitlab:...:mr:<iid>` 命名。
3. 所有 repo 参数分清“显示名称”和“存储键”：communication SQL 的 repo 列可保留，但新调用统一传 storageKey；日志/UI/API 另提供展示字段。semantic/delivery/worker/lock key 同样纳入 storageKey，不能只修 SQL 唯一约束。
4. control-plane repositories 保留 UUID 和外键，加入 connection、remote ID、storageKey；移除 full_name 全局唯一，改为连接内路径唯一，并对有值的 remote ID 建连接内唯一索引。旧 GitHub remote ID 可延迟验证填充，迁移不需要网络。
5. 本基线 control-plane migration version 为 2；实施时使用当前版本的下一个版本。SQLite 改 UNIQUE 需要事务重建相关表/索引并验证外键；不得丢 command/profile/asset/snapshot 关联。迁移中断回滚，重复执行无副作用。
6. 对新 snapshot/run manifest/inbound/outbound/approval 结构显式版本化，reader 同时识别旧 GitHub 格式。旧不可变快照、方案、批准记录不重写、不重算签名或 hash；必要时在解析后形成内存视图。
7. `close`、扫描恢复、managed repository discovery、备份恢复必须识别两种布局。备份纳入连接配置和 SCM secrets，保持现有安全权限；恢复后继续确认远端发布，不重发已发布评论。
8. GitLab 项目重命名时更新展示路径/clone URL，storageKey 不变。GitHub 历史重命名问题不扩大为本次全量身份迁移。

升级/回滚文档必须说明：停服务、备份、迁移、检查再启动。新 schema 写入后不能只回退二进制；回滚使用完整备份，且处理升级期间可能已发生的外部发布，避免重放。实施测试只使用临时 runtime。

## 5. GitLab 关键行为约定

### 连接、认证与入站

- 首版连接由受管理员认证保护的 API/UI 创建；服务端 credentialRef 存 token，UI 只显示 configured 状态。允许每个项目单独连接/token；不用全实例超级 token 作为默认。
- 连接设置提供“验证连接”只读动作：获取机器人身份和项目可见性。不要在健康检查、公开 setup 或普通页面加载时创建 webhook/发表评论。
- 新入口 `/gitlab/webhook/:connectionId`；连接显式选择 signing 或 legacy secret 模式。新版优先 Standard Webhooks 签名（raw body + message ID + timestamp，校验时间窗口），旧版检查 `X-Gitlab-Token`；均常量时间比较，限制 body 大小，不记录 secret。signing 模式缺/坏签名不能降级为 secret。GitHub `/github/webhook` 与原 HMAC 逻辑保留。版本依据见 [官方 Webhooks 文档](https://docs.gitlab.com/user/project/integrations/webhooks/)。
- Note Hook 只接受新建、非 system、普通 MR Note。过滤行内 note 类型；只有确认 MR/Note/作者一致并满足授权才调度模型。MR Hook 只做快照/状态处理，不因打开或更新自动启动模型。
- 先完成本地 webhook 校验并持久化入站，网络验证失败走已有 retry；无效 secret 不入队。路由 connection + payload project ID 必须匹配已登记项目；不可自动接纳 token 能看到的所有项目。
- GitLab 默认仅有效项目角色 Developer（30）及以上可触发任务/批准，查询包含继承/邀请关系的有效成员 API；这是本项目策略。403/404/未知角色不放行；429/5xx 延后验证。批准执行前再次查当前权限，不能只用最初 webhook 角色。
- 对自己发的 note 使用 API `/user` 得到的 numeric ID 过滤，不依赖用户名后缀。拒绝其他 bot 触发；如果 webhook 未给 bot 信息则补查，无法确定则不执行。
- 事件去重优先使用平台/连接限定的 `webhook-id` / `Idempotency-Key`；旧版缺头时以项目+MR iid+note ID+创建动作产生稳定身份。不要把 webhook 配置 UUID 当成 delivery ID。评论语义去重是第二道防线；重新投递换 UUID 仍不能再执行。
- 原有 `/approval` 被拒的可审计路径、创建时间检查、close 高水位和同一评论只执行一条命令都保留。若按 note ID 高水位实现，加入延迟/乱序/重投测试，并用已关闭会话记录避免漏放旧事件。

### Git 与发布

- 仓库 API 确认 clone URL，限制在连接配置的可信实例/路径内；不使用 webhook 提供的任意 URL 发送凭据。不允许跨主机重定向携带认证。
- 使用目标项目 MR head ref 获取 source head（必要时由 adapter 提供 fallback），fetch 后验证实际 SHA 等于本次 snapshot head；目标分支单独 fetch 最新 tip。不使用测试合并 ref 作为源分支提交。
- Git auth 参数化为受限目标 URL 与 token 类型；保持 token 不进入 remote URL、argv、Git config 文件、trace、产物和模型工具环境。覆盖原生 token 和 Basic 编码的脱敏；检查 `command()` 的 process.env fallback，不能因新增 env token 泄露到验证子进程。
- 同项目才向确认过的 source branch 推送；使用现有普通 push，不增加 force push。source/target/head/base 改变时使任务/批准失效；权限不足保留证据并明确 needs_human。
- GitLab review 使用 MR Note + head SHA +现有语义 marker。outbox timeout/崩溃后分页查找同一机器人 numeric ID 的 marker，再认领 receipt。用户复制 marker 不能冒充成功投递。
- Notes API 可能执行 slash quick action：统一在 GitLab 发布边界转义模型/用户引用中的独立行斜杠命令，保留可读内容；测试 `/close`、`/merge` 等不会改变远端 MR。持久化最终转义正文后再发布，确保重试 marker/内容一致。[Notes API](https://docs.gitlab.com/api/notes/)
- GitLab 普通 Note 无 GitHub `commit_id` 的原子绑定；发布前后核对 SHA，若写入期间变化，记录“已发布但过期”并停止成功收尾，不盲目删除或重发。不要承诺跨 HTTP 请求严格 exactly-once。

### CI 与验证

- 实现 `GET .../merge_requests/:iid/pipelines` /项目 pipelines、pipeline jobs、job trace；分页跟随服务端信息，不依赖第一页。
- 选择与本次 MR、source head 和 pipeline source 对应的有效运行，处理重试 job；同 SHA 下存在 branch/MR/合并结果多种流水线时不能简单取最大 ID。
- 将 merged-result/merge-train 的合成 SHA 与 source head 明确区分。首版不能可靠证明绑定时返回 unsupported/unknown/needs_human，不能把其他 SHA 的绿色当成本次修复成功。
- 状态至少表达 pending、green、red、unknown/blocked；无 pipeline、必需 manual、scheduled、waiting、取消、日志不可读都有独立证据。允许失败 job 与可选 manual 不应机械变成 red；不能把“缺证据”变成 green。
- 继承现有等待预算、AbortSignal、终态稳定观察，尊重 Retry-After。日志限制大小、脱敏；403/404 trace 给出 unavailable，不能据此声称无需修复。
- 加入 `.gitlab-ci.yml` 和仓库内 local include 的验证输入识别；动态/远端 include 无法完整捕获时记录限制，不能声称已覆盖所有验证配置。

## 6. 实施任务与依赖

每个任务完成后留下变更摘要、验证结果和下一任务入口；这是实施顺序，不要求一次窗口完成全部。禁止用 GitLab 冒烟成功替代 GitHub 回归。

### T0 — 基线与接口清单

依赖：无。读 CONTRIBUTING、SECURITY-MODEL、本计划及 API 调研；查看 git status 和当前 HEAD。运行 check/test/build，记录已有失败。用 `rg` 再确认 `Octokit|client.rest|installation_id|github.com|split('/')|author_association|github_snapshot` 调用点，建立迁移 checklist。验收：没有修改实际 runtime、没有复制私用配置。

### T1 — SCM 领域类型及 GitHub adapter

依赖：T0。新增 `src/scm/`，将 GitHub API 能力包进 adapter，定义身份/快照/receipt/CI/error 类型。公共格式化函数从 GitHub 命名空间分离。以契约测试固定 head/base、评论分页、review marker、CI 和失败语义。验收：仅启用 GitHub 时现有行为不变；尚不启用 GitLab 路由。

### T2 — 身份与存储兼容

依赖：T1。实施第 4 节，修改 control-plane schema/types/repositories/common、communication types/store、paths/state/memory/snapshots、运行锁/发现/迁移备份。新增旧版本夹具。验收：GitHub 与两个 GitLab 实例同名项目同编号互不共享状态；旧暂停任务、outbox、审批 hash 可读取；迁移两次/中断不丢数据。

### T3 — 核心运行链改用 adapter

依赖：T2。依次改 inbound verifier → outbound/review recovery → communication scheduler → worker/recovery/close → approval；移除核心直接 `client.rest` 访问，调整 worker 启动参数与 scripts。暂时仍用 GitHub adapter 验证全链。验收：`runner/tasks/harness` 不再依赖 Octokit；旧入口仍工作；现有 GitHub close/stop/recovery/approval/review 测试通过。

### T4 — GitLab 连接与 client

依赖：T2、T3。实现服务端连接/secret 存取、分平台配置、REST v4 fetch wrapper（Node 内置 fetch 即可，不必引入第二个大型 SDK）、响应校验、超时/分页/安全错误/重试、项目查询、bot 身份。GitLab-only 不读取 PEM。验收：假 HTTP server 覆盖 PAT/项目 token 请求头、子路径实例、嵌套 namespace 编码、token 轮换、401/403/404/429/5xx；公开 API 与日志无密钥。

### T5 — MR 事件与授权

依赖：T4。实现 GitLab webhook 两种认证模式、Note 规范化、成员权限查验、持久去重，连到统一调度器。验收：普通 MR 新评论触发一次；issue/inline/edit/system/bot/错项目/无权用户不执行；签名篡改/时间过期/降级被拒；网络故障重启后继续；被降权的批准不执行。

### T6 — 只读垂直闭环与可靠发布

依赖：T5。实现 GitLab inspect、MR head fetch、snapshot、freshness、notes/review 发布与认领。conversation/custom read_only/review 走真实现有 harness。验收：假 API + 本地 bare repo + 假模型完成“mention→worktree→摘要→Note”；发布响应丢失、worker 崩溃、超过一页评论、伪造 marker、head 更新都有测试。`/stop`、`/close`、重启恢复同样适用于 GitLab。

### T7 — CI 与同项目修复

依赖：T6。实现 CI/job/trace 映射、verification inputs、受控 Git auth/push；接通 `/CI` 和 repair。验收：失败→修改→本地验证→push→确认远端 head→新 CI 的完整流程；旧 SHA 绿灯/无流水线/合成 SHA/manual/重试 job/日志不可读不误报成功；fork/受保护分支/远端竞态不越权发布。

### T8 — 冲突方案批准与恢复

依赖：T7。让 conflict proposal/approval 引用统一仓库和 actor 身份，补批准时 live 权限验证与各种崩溃恢复。验收：只分析不推送；明确 `/approval` 才执行对应方案；旧方案、base 移动、head/ref/源项目改变、降权、工作区证据变化均拒绝；push 后崩溃恢复认领已推送 commit、不重复修复；不会调用 GitLab MR approval/merge API。

### T9 — 管理控制台、CLI 与文档

依赖：T4–T8。管理 UI 增加连接类型/实例/凭据 configured 状态、连接验证和项目选择；MR/PR 文案按平台显示。API 新增按 repository UUID 寻址的清晰路由（如 `/api/admin/repositories/by-id/:id/...`），覆盖所有子资源；旧按名称路由仅解析默认 GitHub，不能遇同名 GitLab 时猜测。前端 repository 选择/缓存也改用 UUID。CLI 保留 `run-pr owner/repo number` 旧形式，增加显式 repository ID 入口。同步双语 README、CONFIGURATION、OPERATIONS、SECURITY-MODEL、setup 和 prompt；首版 UI 不自动创建 webhook。验收：GitHub/GitLab-only/混合三种启动和配置可用，中文/英文与 DTO 同步。

### T10 — 发布验收与交接

依赖：全部。运行下节全套验证；记录能力矩阵和未支持项。提供测试实例手工验收步骤，只有获得实例访问与外部写操作授权后执行真实 MR 冒烟。无凭据时完整完成 mock/local 验证，但把“真实平台验收待完成”写明，不能标为生产验证通过。

## 7. 验收与完成标准

重点复用测试：`webhook`, `pr-comments`, `communication-store`, `outbound`, `outbound-scheduler`, `review-recovery`, `pr-freshness`, `workspace`, `repo-store`, `ci`, `repair-verification`, `conflict-proposals`, `stop`, `close`, `resume`, `runtime-migration`, `runtime-backup`, `restore-runtime`, `admin-api`, `frontend-api`, `secrets`。

新增建议：`scm-contract`, `scm-identity`, `scm-migration`, `gitlab-webhook`, `gitlab-authorization`, `gitlab-client`, `gitlab-ci`, `gitlab-lifecycle`。使用临时目录、假 HTTP、合成 JSON、本地 Git 和假模型；不要录制私有 webhook 或真实 token。

```sh
npm run check
npm test
npm run build
npm run verify:frontend
```

最终必须证明：

- 老 GitHub 部署配置和历史数据继续工作，GitLab-only 可以启动。
- 不同平台/实例的同名项目、相同 MR/PR 编号及 note ID 不会交叉投递、清理或复用记忆。
- 项目重命名、subgroup、重投/乱序、secret 错误、角色变化有覆盖。
- `/review` 不改代码；read_only 自定义命令不获得写入权限；同项目修复保留证据与 freshness 约束。
- 评论已发布但本地未落 receipt、push 已完成但本地未确认、stop/close 清理中途崩溃都能收敛。
- CI 绿色证据绑定实际待确认 head；权限失败/缺日志/无 pipeline 不冒充成功。
- 备份/恢复保留平台连接、密钥引用、状态和去重事实；GitLab token 不出现在客户端、子进程默认环境或 trace。

真实冒烟矩阵：GitHub 现有 PR；GitLab.com 同项目 MR；自托管实例同项目 MR（记录版本，至少一个带 subgroup）；fork MR 只读与修复拒绝；一次受控发布响应丢失/服务重启。使用明确授权的测试仓库。

## 8. 交给下一窗口的启动指令

> 在当前开源版实施 GitLab 支持。先读 `docs/GITLAB-IMPLEMENTATION-PLAN.md` 和 `docs/gitlab-api-research.md`，检查当前代码差异和适用工作约定，从 T0 开始按依赖顺序完成。保持既有 GitHub 行为和持久化数据兼容；适配面向开源版使用者，私用版不访问、不修改、不测试、不迁移，也无后续同步任务。每完成一阶段记录变更、测试及下阶段入口到 `docs/GITLAB-IMPLEMENTATION-PROGRESS.md`。不要止步于加 client：交付 webhook→授权→任务→可靠发布→恢复、控制台与配置的完整链路。真实平台测试没有凭据时标为待验收，不伪称通过。

整体评估：这是一次中等偏大的多平台改造，适合多个可验证提交。T6 是第一条可演示闭环，T10 才是本计划的完整交付；不要用具体天数或单窗口承诺替代验证。
