# GitHub App 设置

PatchPaw 是自托管服务，操作员为自己的部署创建并维护 GitHub App。不要在仓库中保存 App 私钥或 Webhook secret。

## Webhook

将 Webhook URL 设置为公开来源地址加 `/github/webhook`，例如：

```text
https://patchpaw.example.com/github/webhook
```

Webhook secret 必须和 `PATCHPAW_GITHUB_WEBHOOK_SECRET` 完全一致。PatchPaw 先校验 `x-hub-signature-256`，签名无效时不会解析 JSON。建议启用 `pull_request` 与 `issue_comment`；只有确实使用安装状态同步时才添加安装相关事件。

## 最小权限

从 Metadata Read 开始，再按已启用功能增加权限：

- Pull requests Read 用于读取 PR、diff 和评论上下文；
- Issues/issue comments Read 用于读取对话，Write 用于发布评论；
- Contents Read 用于只读审查，Contents Write 只给需要提交或推送的修复路径；
- Checks/Actions Read 用于读取 CI 状态；
- 其他权限只在代码实际使用且经过审查后启用。

审查、对话和冲突分析应保持只读。`repair` 或 `ci` 的读写权限是明显的副作用边界，可能修改工作区、提交、推送和写入 GitHub 评论。

## 密钥生命周期

私钥只下载一次并放入受限的 secrets 目录或操作系统密钥管理设施；`PATCHPAW_GITHUB_PRIVATE_KEY_PATH` 可以使用相对项目根目录的路径。Webhook secret 与私钥分别轮换。怀疑泄露时，立即在 GitHub 撤销旧私钥/secret，生成新的值，更新服务端环境并重启。

不要把 App ID 之外的凭据放入前端环境变量，不要在 issue、日志或 `/api/setup` 中暴露 secret、私钥路径或安装 token。
