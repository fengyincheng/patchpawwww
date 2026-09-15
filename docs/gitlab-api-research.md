# GitLab API 调研补充

调研日期：2026-09-15。以下区分官方事实与本项目实现建议；未连接实际 GitLab 账号验证。官网滚动文档已包含 GitLab 19.x，不能据此承诺所有旧版 Self-Managed 都支持新字段。

## 结论与范围

**可行。** 现有产品围绕已有 PR 的普通评论、review 总结、CI 修复、冲突修复和人工批准后推送工作；GitLab 的 MR、Notes、Pipelines、Jobs、Git remote 足以承接。第一版应保持这条产品边界，不顺带新增 issue 自动修复、MR 新建、自动合并、inline review、OAuth 安装市场。

本地阅读依据：`src/github/client.ts`、`src/github/ci.ts`、`src/github/pull-request.ts`。现有 GitHub App installation token、`owner/repo` 二段解析、Checks/Actions 聚合和 PR head/base 字段不能直接套用 GitLab。

## 身份、认证和授权

- REST 使用实例下的 `/api/v4`；项目参数接受 numeric ID 或完整 URL 编码 path。GitLab 有子组，应把 `group/subgroup/repo` 整体编码成 `group%2Fsubgroup%2Frepo`，不可用 `split('/')` 后只取两段。Issue/MR API 参数用项目内 `iid`，不是全局 `id`。[REST API](https://docs.gitlab.com/api/rest/)
- 建议配置保存 `instanceBaseUrl + projectId + pathWithNamespace + credentialRef`，主键带 provider 和 instance。解析用户项目路径后尽快换成稳定的 numeric project ID；保留完整路径显示。此为项目设计建议。
- PAT 和 project access token 可以通过 `PRIVATE-TOKEN` 调 API，也能作为 Git HTTPS 密码，用户名非空即可。OAuth 使用 Bearer，可用于 Git HTTPS；SSH key 仅解决 Git 传输，仍需 API 凭证。[认证](https://docs.gitlab.com/api/rest/authentication/)、[PAT](https://docs.gitlab.com/user/profile/personal_access_tokens/)、[OAuth](https://docs.gitlab.com/api/oauth2/)、[SSH](https://docs.gitlab.com/user/ssh/)
- 推荐第一版支持 bot PAT / project access token。GitLab.com project access token 要 Premium/Ultimate；Self-Managed/Dedicated 各许可证可用，因而 GitLab.com Free 必须允许 PAT 路径。[Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- 配置说明可明确要求 `api`（读写 Notes 等）和 `write_repository`（Git push）。单独 `write_repository` 不支持 API 认证。token reach 由 personal/group/project 类型决定；不应假设 project token 能推送 fork。[Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- 评论者授权应调用 `GET /projects/:id/members/all/:user_id`，包括继承/邀请组成员；直接 `members/:user_id` 会漏继承成员。角色 Developer=30、Maintainer=40、Owner=50。[Project members](https://docs.gitlab.com/api/project_members/)
- **建议策略**：目标项目中实时查询到 active 且 `access_level >= 30` 的用户才能发命令/批准；404、超时、未知状态均拒绝执行。接收评论和实际 push 前重新校验，不能信任 webhook 自报身份，也不能用“能发评论”代替执行权限。此门槛是产品默认值，不等同于 GitLab 所有分支的实际 push 权限；受保护分支权限仍以服务器执行结果为准。
- transport 实现建议：不把 token 写进 remote URL、日志、snapshot 或 agent prompt；继续用临时凭证机制。Self-Managed base URL 必须显式配置，并保留可能的子路径；跳转/分页下一页不允许把认证头带到另一 host。测试自定义 CA，不默认关闭 TLS 校验。

## 普通评论与 review 总结

| 操作 | GitLab REST endpoint |
| --- | --- |
| 读 MR | `GET /projects/:id/merge_requests/:iid` |
| 列普通评论 | `GET /projects/:id/merge_requests/:iid/notes` |
| 按 ID 重读评论 | `GET /projects/:id/merge_requests/:iid/notes/:note_id` |
| 发总结/状态评论 | `POST /projects/:id/merge_requests/:iid/notes`，body 字段 |
| 更新状态评论 | `PUT /projects/:id/merge_requests/:iid/notes/:note_id` |

Notes 能承接当前 summary-only review，不必引入 Discussions/行号定位。响应区分 `system` 与普通评论，支持排序和分页；建议只接受普通 MR note、排除 bot 自身输出，并用 provider/instance/project/iid/note-id 去重。Notes 可能执行 quick actions，生成内容应过滤独立行 slash quick action，避免总结意外触发 `/close` 等平台操作。[Notes API](https://docs.gitlab.com/api/notes/)

若以后需要 inline review，Discussions API 有 diff position 和 base/start/head SHA 定位；应独立规划。[Discussions API](https://docs.gitlab.com/api/discussions/)

## Git 工作区和 SHA 语义

- MR 提供 `source_project_id`、`target_project_id`、source/target branch、`sha`、`diff_refs`。`diff_refs.base_sha` 是 merge-base；`start_sha` 是该 diff 版本目标分支点；不能把它当实时 target tip。新 MR `diff_refs` 异步填充，需要有界重试。[Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- 可从目标仓库 fetch `refs/merge-requests/:iid/head`，包括 fork MR。关闭/合并 14 天后该 ref 会被删除。此 ref 是读入口，批准后的 push 应去 source project 的真实 source branch，不能推 MR ref。[MR 本地 checkout](https://docs.gitlab.com/user/project/merge_requests/merge_request_troubleshooting/#check-out-merge-requests-locally-through-the-head-ref)
- **建议**：snapshot 分别保存 source head、实时 target branch tip、merge-base。保留现有执行前/后 head、target branch、open state、source project 检查与普通非强制 push。首版同项目 MR 写入；fork 可只读 review，若实现 fork 修复必须单独验证 source repo 凭证和写权限。

## CI：应显式处理的差异

- Pipelines 可按 SHA/ref/source 查询；状态除 success/failed/running/pending 还有 created、manual、scheduled、waiting、canceled、skipped 等。不要把所有非 running 状态都当完成成功。[Pipelines API](https://docs.gitlab.com/api/pipelines/)
- `GET /projects/:id/pipelines/:pipeline_id/jobs` 默认排除重试前旧 job，仍需翻页；失败日志为 `GET /projects/:id/jobs/:job_id/trace`。Jobs 有 `allow_failure`，不能看到一个 failed job 就覆盖整条 pipeline 的允许失败语义。child pipeline/bridge 若未支持，应报告证据不完整。[Jobs API](https://docs.gitlab.com/api/jobs/)
- 合并结果 pipeline 运行临时合并 commit，SHA 不属于 source/target 分支，且该功能为 Premium/Ultimate。因而只查 source SHA 会漏 MR CI；也不能把 pipeline SHA 当成要推送的 source head。[Merged results pipelines](https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/)
- **第一版建议策略**：先读 MR 关联 pipelines/head pipeline，保存 pipeline ID、project ID、pipeline SHA、source head、target tip；直接 head pipeline 与 SHA 一致时可自动归因。若 merged-result SHA 无法证明绑定当前 source/target，返回 `unknown/unsupported` 并停止自动 CI 修复，仍展示链接。以后再实现临时合并 commit 的 parents/关联验证。过期 pipeline 不能让当前 head 变绿。
- 建议归一化：success→green；failed→red；活动/等待/manual→pending；canceled/skipped/无 pipeline/未知新状态→unknown，除非明确策略允许。失败证据保留日志获取失败状态，不把 403/404 当作无失败。pipeline/job 日志限制长度并复用现有脱敏。
- 外部 commit status API 可读写，但写 status 可能创建 external pipeline。当前不需要写 status，不应为“模拟 GitHub checks”引入额外 pipeline。[Commits API](https://docs.gitlab.com/api/commits/)

## Webhook、轮询和可靠性

- GitLab 支持 Note、MR、Push、Pipeline 等事件；Comment event 包含创建或编辑。建议第一版只接明确支持的普通 MR note 动作，与当前 GitHub 评论编辑语义对齐；MR close/merge 更新远端状态事实并阻止过期发布，本地清理仍由 PatchPaw `/close` 控制，不新增自动删除现场行为。[Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)
- 当前官方文档：19.0 引入 Standard Webhooks HMAC signing token，19.1 GA。签名基于 raw body 和 message ID/timestamp；老版本仍是 `X-Gitlab-Token` 共享 secret。`Idempotency-Key` 自 17.4 提供，19.x 推荐 `webhook-id`。不得沿用 GitHub `X-Hub-Signature-256` 算法或误称老 GitLab secret header 为 body HMAC。[Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)
- **建议**：secret-header 与 signing 两种模式显式配置；选择 signing 后缺/坏签名必须拒绝，不能按请求头任意降级。恒定时间比较、签名 timestamp 窗口、持久化 delivery 去重；在 webhook 持久化后快速 2xx，由 worker 拉取最新 MR/note 并重新授权。自托管内网部署也需考虑 GitLab outbound webhook 访问设置。[Outbound filtering](https://docs.gitlab.com/security/webhooks/)
- API 默认每页 20，上限常为 100；跟随 Link/next-page，不能依赖 total headers 一定存在。排序期间新增评论仍可能造成重复，持久化 note ID 幂等可抵御；全量补偿扫描须有界。[REST 分页](https://docs.gitlab.com/api/rest/)
- GitLab.com 当前 authenticated API 为每用户每分钟 2,000，Note 创建 60/min，单项目读取还有独立限制；Self-Managed 可不同。实现按 instance/credential 的限流、429 退避与 jitter；有 Retry-After 时遵从，无头时有界指数退避。不要硬编码全平台固定额度。[GitLab.com limits](https://docs.gitlab.com/user/gitlab_com/#rate-limits-on-gitlabcom)

## 延后能力（不是首版必做）

Issue labels polling 可用 project issues 的 state/labels/updated-after；改 labels 有 add/remove 形式。若后续另开 issue 工作流，须保留 iid 区别。[Issues API](https://docs.gitlab.com/api/issues/)

新建 MR、merge 都有 REST API；merge 支持 source SHA 保护，`auto_merge` 取代已弃用的 `merge_when_pipeline_succeeds`。现有产品 close/stop 是本地生命周期，不能把 GitLab 适配错误实现成远端 close/merge。[Merge requests API](https://docs.gitlab.com/api/merge_requests/)

## 实现验收重点

1. GitLab.com Free PAT 与 project token 配置都能表示；不同实例同 project ID 不串数据。
2. 多级 subgroup、MR iid 与 global id 不同、自定义 base URL 子路径。
3. 继承成员 Developer 放行、Reporter/移除成员拒绝、API 失败拒绝；push 前再次授权。
4. MR 普通 note 创建可触发，system/bot/重复事件不触发；状态 note 更新幂等；summary 不执行 quick actions。
5. MR head 与 target tip 在运行/审批中变化时停止；fork 无写权限不推送。
6. 无 pipeline、manual、allow_failure、重试 job、过期 head pipeline、merged-result SHA 差异、日志 403/404。
7. Webhook secret 与 signing 各自正反例、重放/重复 delivery、多页 Notes、429、跨 host 分页拒绝。
8. 保持 GitHub 行为和现有测试通过；实际账号验收单独记录版本、license、pipeline 类型与结果，不能把 mocks 通过写成真实 GitLab 验证完成。
