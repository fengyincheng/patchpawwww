# GitLab setup / GitLab 配置

PatchPaw supports GitLab.com and self-managed GitLab through the GitLab REST API, HTTPS Git transport, and a per-connection webhook endpoint. A connection is independent from GitHub and multiple connections may use the same GitLab instance.

PatchPaw 支持 GitLab.com 和自托管 GitLab。每个连接有独立的实例地址、凭据、Bot 身份和项目白名单；同一实例可以配置多个连接。

## Permissions / 权限

Use a Personal Access Token or Project Access Token with the smallest scope that matches the enabled commands:

- `read_api` for MR, Note, member, pipeline, job and trace reads.
- `api` when PatchPaw must publish ordinary MR Notes or push repair branches.
- Git over HTTPS uses the same token through an in-memory `Authorization` header. The token is never placed in a clone URL, process argument, browser response, trace event, or API DTO.

The GitLab actor must be a project member with Developer level (30) or higher for executable mentions and approval paths. Guest and Reporter comments are retained as inbound records but cannot start an execution. Fork MRs are read-only until an explicitly supported write path is added.

## Environment bootstrap / 环境启动配置

`PATCHPAW_GITLAB_CONNECTIONS` is a JSON array. Use `token_env` and `webhook_secret_env` so secret values do not appear in the main configuration string:

```dotenv
PATCHPAW_GITLAB_CONNECTIONS=[{"id":"gitlab-prod","instance_url":"https://gitlab.example.com","project_ids":["42","group/subgroup/project"],"token_env":"PATCHPAW_GITLAB_TOKEN","webhook_secret_env":"PATCHPAW_GITLAB_WEBHOOK_SECRET","webhook_mode":"secret","bot_login":"patchpaw"}]
PATCHPAW_GITLAB_TOKEN=replace-me
PATCHPAW_GITLAB_WEBHOOK_SECRET=replace-me
```

Project IDs may be numeric IDs or URL encoded project paths at the API boundary. The runtime stores and compares the canonical numeric project ID. The instance URL must be HTTPS in production and must not contain credentials, query parameters, fragments, or an API path.

The Settings page can create a persisted GitLab connection and store its token and webhook secret in protected runtime slots. Persisted connections are loaded on the next service start. The API returns only configured/not-configured status for these slots.

Settings 页面可以创建持久化 GitLab 连接并写入受保护的运行目录；服务重启后加载。接口只返回是否已配置，不返回秘密内容。

## Backup and restore / 备份恢复

Runtime backups include the explicit SCM credential slots at `secrets/scm` and `secrets/scm-webhook`, so a restored control plane can reconnect without re-entering GitLab credentials. Provider credential files remain excluded. Treat the backup artifact as sensitive: the backup directory is restricted to `0700`, included SCM directories to `0700`, and slot files to `0600`; restore applies the same modes. Keep the backup outside the repository and protect it like the original tokens.

运行时备份会包含 `secrets/scm` 和 `secrets/scm-webhook` 中的 SCM 凭据 slot，使恢复后的控制面可以重新连接 GitLab；Provider 凭据文件仍然排除。备份文件必须按原始 token 的敏感级别保存：备份目录为 `0700`，SCM 目录为 `0700`，slot 文件为 `0600`；恢复时会重新应用这些权限。请将备份放在仓库之外并妥善保护。

## Webhook / Webhook 地址

Configure one endpoint per connection:

```text
https://patchpaw.example.com/gitlab/webhook/<connection-id>
```

`secret` mode verifies `X-Gitlab-Token` with constant-time comparison. `signing` mode verifies the Standard Webhooks `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers over the raw request body and rejects stale timestamps. The route accepts only newly created ordinary MR Notes; system notes, inline discussions, edits, Issues, commits, and unrelated projects are ignored.

Only notes mentioning the configured Bot login are persisted. Delivery identity is taken from the webhook ID/UUID; when GitLab omits those headers, PatchPaw derives a stable identity from connection, project, MR IID, note ID and action. Replaying the same delivery is therefore idempotent.

Webhook secret and API token are separate slots. Keep the reverse proxy from rewriting the request body and pass the endpoint without browser authentication challenges.

## Supported behavior / 当前行为

| Flow | GitLab behavior |
| --- | --- |
| Conversation and `/review` | Read MR state and ordinary Notes; publish an ordinary MR Note containing the head SHA and idempotency marker. |
| `/CI` | Read pipelines for the exact MR head SHA, jobs, status, and bounded failure traces. |
| `/stop` and `/close` | Operate on local PatchPaw state; they do not stop or close the remote MR. |
| Repair, merge, approval API, Issues, inline review comments | Kept behind human review or unsupported in this release. No merge, approval, Issue or webhook configuration API is called. |

The GitLab adapter validates the MR head again before publishing a review. A changed head or target branch stops the publication and leaves the run for inspection. Review and CI messages are ordinary Notes, so GitLab Quick Actions are escaped before sending.

## Verification / 验证

Run local checks before connecting a live instance:

```sh
npm run check
npm test
npm run build
npm run verify:frontend -- https://patchpaw.example.com
```

Live GitLab tests require an explicitly authorized disposable project and credentials. The repository test suite uses fetch fixtures and does not require GitLab credentials.
