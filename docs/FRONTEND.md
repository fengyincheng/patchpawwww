# 前端与管理员 API

前端由 Vite 构建并由 PatchPaw 服务端从同一来源提供。它使用相对路径调用 API，因此不需要在构建时写入域名、账号或 token。

## 首次登录

登录页先调用无需认证的 `GET /api/setup`。返回值严格只有：

```json
{
  "data": {
    "public_origin": "https://patchpaw.example.com",
    "webhook_url": "https://patchpaw.example.com/github/webhook",
    "https_enabled": true,
    "admin_auth_configured": true
  }
}
```

面板还会把 `public_origin` 与浏览器的 `window.location.origin` 比较。mismatch 通常表示反向代理、DNS 或 `PATCHPAW_PUBLIC_ORIGIN` 不一致。`/api/setup` 不返回 GitHub App 标识、仓库列表、私钥路径、运行目录、Provider secret、Webhook secret 或 admin token。

登录 POST 只发送操作员在密码输入框中提供的 token。成功后服务端返回短期 HttpOnly、SameSite cookie；登录和 session 响应不包含原始 token。前端不把 token 写入 localStorage，也不把它编译到构建资产中。

## API 写入保护

管理 API 的写请求需要有效会话和匹配 `Origin`。HTTPS 部署会为会话 cookie 设置 `Secure`。setup 面板只是状态和操作指引；修改来源地址必须在服务端环境中完成并重启，不能在浏览器中编辑。

## 资源与凭据

控制台可以管理 Prompt、Skill、Provider、Model、Command 和只读 Conversation Profile。Provider 凭据输入只在写请求中发送，之后只显示是否已配置。生效配置预览不会改变正在运行的 Execution；运行任务使用自己的不可变快照。
