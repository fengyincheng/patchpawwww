# 运维与副作用

## 只读检查

以下命令只验证当前 checkout 和前端构建，不应向 GitHub 创建分支、PR、提交或评论：

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
- GitHub Webhook 会持久化快照；已签名的 issue comment 可能进入执行队列。被动 Pull Request 事件不会自动启动 Agent。

`/stop` 仅停止可停止的活动执行并保留证据；已经进入 Git publication 的外部操作可能先完成。操作员应以最终运行结果和 GitHub 远端状态为准。

## 发布前检查

部署前在将要运行的 checkout 中执行 `npm ci`、`npm run check`、`npm test`、`npm run build`，确认 frontend verifier 指向相同构建。不要用真实健康检查替代签名 Webhook 测试，也不要为了验证登录把 token 写入命令参数或日志。
