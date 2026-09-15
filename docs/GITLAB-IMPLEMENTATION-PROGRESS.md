# GitLab 实施进度

日期：2026-09-15

## 已完成

- T0：确认当前开源版基线、工作区差异和调用点；`npm run check`、`npm run build` 通过。完整 `npm test` 最终结果为 229 个测试、228 通过、1 跳过、0 失败；迁移兼容测试中的 marker 场景已修复。
- T1：新增 `src/scm/` 领域类型、身份函数、GitLab REST client、GitLab note webhook 校验/规范化和 GitHub 兼容适配入口。GitLab client 覆盖 PAT 请求头、实例子路径、项目路径编码、分页、超时、重定向拒绝和 Retry-After。
- T2：控制面 migration 3 增加 SCM connection 与 repository 远端身份字段；GitLab 使用 `gitlab:<connection-id>:project:<project-id>` storage key，并在 state、snapshot、memory 中使用安全隔离目录。旧 GitHub repository 和旧布局继续按原规则读取。
- 入站/出站接入：新增 `/gitlab/webhook/:connectionId`，普通 MR Note 会先持久化；统一通信 scheduler 可按连接选择 GitLab inbound verifier 和 outbound adapter。GitLab Note 发布会转义独立 slash quick action，并用机器人 numeric ID 做认领。
- 管理控制台 API：新增 SCM connection 的增删改查、凭据写入、连接验证和按 repository UUID 查询入口；API 只返回 configured 状态，不返回密钥。
- T3/T6：GitLab worker 已接入 conversation、read-only custom、review、精确 head SHA 的 CI 读取，以及同项目 repair/CI repair 的受控 HTTPS push；fork repair 明确拒绝。发布失败会保留 `publication_pending`/`needs_human`，不会把未确认的 Note 报告为完成；`/stop` 会停止可停止的本地任务并保留可恢复 workspace，运行中的 `/close` 会回复拒绝说明。Conflict 已能生成绑定当前 head/base、workspace evidence 和 Command Snapshot 的只读 Proposal，并通过 durable outbox 发布。
- T5/T10：CLI 已支持 `run-pr --repository-id <UUID> <mr-iid>`，并通过控制面解析 GitLab repository storage key；运行时备份包含 SCM slots、排除 Provider 密钥，恢复会重新应用受限权限。
- T9：Settings 页面新增 GitLab connection 创建、项目白名单、秘密写入状态和验证入口；GitLab-only 配置可启动，重启时会加载控制面中已持久化且凭据完整的连接。
- T9：控制台 repository 选择、更新和子资源 API 改用 control-plane repository UUID；旧的 GitHub `owner/repo` 路由继续兼容，GitLab storage key 不再作为管理 API 的名称路由。CLI 保留旧入口并增加显式 UUID 入口。

## 本轮审计返工

- P0：GitLab `/close` 已改走与 GitHub 相同的 durable close journal 和 cleanup 顺序。开始通知、workspace/run/memory/snapshot/inbox 清理、closed-through tombstone、完成通知与失败重试都由共享 lifecycle 执行；GitLab 只通过 adapter 发布 Note，不调用远端 MR close API。启动时发现 `closing` journal 会机械恢复，旧 webhook 会被 tombstone 过滤。
- P0：Standard Webhooks 校验现在严格解码 `whsec_<base64>` 的 32 字节 key，并按 `${webhook-id}.${webhook-timestamp}.` 加原始 body 做 HMAC-SHA256，要求 `v1,<base64>` 且使用常量时间比较；signing 模式缺少 `webhook-id` 时拒绝，legacy token 不可降级。
- P1：GitLab review 的过期 head 已统一抛出 SCM-neutral `ReviewStale`，outbox 会标记 `cancelled_stale`；scheduler 和 GitLab worker 都能通过 adapter 完成 stale finalization，不会阻塞同一 MR 后续消息。
- P1：入站执行/批准权限会重新读取 `/users/:id`，只接受明确的人类、active actor，并拒绝 bot、inactive、unknown 和当前 PatchPaw 自身；项目权限仍要求 Developer+。
- P2：GitLab clone/fetch/push 使用 instance path scoped Git credential，禁止跨 host/path、query、fragment 和凭据 URL；CI 证据按目标 SHA 过滤，旧 SHA、pending、required failure、allow_failure、skipped/no jobs 分别覆盖 green/unknown/pending/red/unknown 语义。
- 新增定向测试覆盖 GitLab close 生命周期、journal 恢复、idle `/close` 无模型调用、Standard Webhooks、actor 复核、CI 语义、credential scope，以及 stale outbox 不阻塞后续 delivery。

## 当前验证

- `npm run check` 通过。
- GitLab 定向测试、GitHub `/close` 回归测试通过；完整 `npm test`：236 个测试、235 通过、1 跳过、0 失败。
- `npm run build` 已通过；`git diff --check` 将在提交前对 staged diff 再次执行。
- `npm run verify:frontend` 仍需一个已部署且明确授权的 HTTPS origin，本地开发环境不执行。

## 下一入口

- T3：现有 GitHub 主运行链仍保留 legacy Octokit 调用；GitLab 通过新 adapter/worker 接入，完整清理 GitHub 核心依赖仍需后续迁移窗口。
- T7：GitLab CI repair 已在 push 后按目标 SHA 观察 pending/unknown 状态，再决定是否进入下一轮；真实 runner 的完整多轮矩阵和实例差异仍待验证。
- T8：GitLab `/approval` 已加入 live Developer+ 权限复核、原提案/快照/工作区证据绑定、批准后同项目受控 push、durable outbox 和 push/publication 恢复；仍需在实际 GitLab 实例上验证完整崩溃注入矩阵。
- T10：真实 GitLab 平台 smoke matrix 仍待完成；没有明确测试实例授权时保持待验收。

## 提交前验证结果

- `npm run check`、`npm run build`、`npm test` 均通过；`git diff --check` 无错误。
- 真实 GitLab 实例 smoke、网络重试/重定向差异和 close/approval 崩溃注入仍待在已授权环境执行。
