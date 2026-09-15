# 运维与副作用

## 只读检查

以下命令只验证当前 checkout 和前端构建，不应向 GitHub 或 GitLab 创建分支、MR、提交或评论：

```sh
npm run check
npm test
npm run build
npm run verify:frontend -- <https-origin>
```

模型 Provider 的请求可能产生费用；测试应使用夹具或明确的开发配置，不要把生产凭据放入 CI。`/review`、普通对话和 `/conflict` 分析路径的目标是只读；仍应在隔离运行账号下执行，因为读取仓库内容和运行检查本身具有风险。

## 可能写入状态的操作

- `run-pr` 可能调用模型、修改工作区、发布评论，并在读写命令中提交或推送。
- 控制台中的 bootstrap、Prompt/Skill/Provider/Model/Command 修改会写控制面数据库。
- `backup-runtime`、`restore-runtime` 和 `migrate-runtime` 会读写 `PATCHPAW_HOME`；恢复前确认备份、目标和权限。
- `backup-runtime` 会包含 `secrets/scm` 和 `secrets/scm-webhook` 中的 SCM 连接凭据，以便恢复后重连；Provider 密钥仍被排除。备份目录及其中的 SCM slot 必须按敏感凭据保护，恢复也会重新应用目录 `0700`、文件 `0600` 权限。
- GitHub Webhook 会持久化快照；已签名的 issue comment 可能进入执行队列。被动 Pull Request 事件不会自动启动 Agent。
- GitLab Note Webhook 只接受配置 Bot mention 的普通 MR Note；系统 Note、行内讨论、Issue 和不在项目白名单的事件会被忽略。相同 delivery 会去重。

`/stop` 仅停止可停止的活动执行并保留证据；已经进入 Git publication 的外部操作可能先完成。`/close` 清理本地会话，不关闭远程 GitHub PR 或 GitLab MR。操作员应以最终运行结果和对应平台远端状态为准。

GitLab 连接的 token、Webhook secret 和实例 URL 由 Settings/API 管理时，重启服务才能加载新连接。检查 `GET /api/admin/scm-connections` 的 configured 状态，再用 `POST /api/admin/scm-connections/<id>/verify` 验证 Bot 和项目访问；响应不会返回秘密。

## 发布前检查

部署前在将要运行的 checkout 中执行 `npm ci`、`npm run check`、`npm test`、`npm run build`，确认 frontend verifier 指向相同构建。不要用真实健康检查替代签名 Webhook 测试，也不要为了验证登录把 token 写入命令参数或日志。
