# 威胁模型与限制

## 信任边界

PatchPaw 信任操作员提供的环境配置、GitHub App 安装范围、Provider 端点和目标仓库列表。GitHub webhook payload、PR 内容、评论和模型输出应视为外部输入。服务通过签名校验、同源写入保护、HttpOnly session、不可变执行快照和显式命令权限降低风险，但这些措施不等同于 OS 级沙箱。

模型生成的命令可能读取、修改或删除工作区文件。读写修复可能创建提交、推送分支和发表评论。请在专用账号、容器或虚拟机中运行不信任的仓库，并限制 GitHub App 权限到最小范围。

## 秘密处理

Admin token、Provider credentials、Webhook secret、GitHub App private key 和安装 token 只应存在于服务端配置或内存中的必要生命周期。`GET /api/setup`、登录/session 响应和前端 build 不提供 token；日志、截图和 issue 也不应包含这些值。

## 不在承诺内的内容

PatchPaw 不托管 DNS、TLS、密钥恢复、用户身份系统或隔离执行环境。运行时跨平台不意味着目标仓库的命令跨平台。GitHub API、Provider、代理、证书、磁盘和服务账号的安全与可用性仍由操作员负责。
