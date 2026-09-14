# Contributing

感谢你为 PatchPaw 贡献代码、文档和测试。提交前请先阅读中文 [README](README.md) 和 [安全模型](docs/SECURITY-MODEL.md)；英文读者可参考 [README.en.md](README.en.md)。

## 本地开发

使用 Node.js 22.22.0 或更新版本：

```sh
npm ci
npm run check
npm test
npm run build
```

不要在测试、文档或提交中加入真实 token、私钥、Webhook payload、Provider secret、私有仓库内容、运行日志或本机绝对路径。需要配置时使用 `.env.example` 的通用占位符。

## 提交变更

- 保持 API DTO、前端类型、中文/英文 i18n 字典和文档同步。
- 修改认证或 setup 边界时，补充不泄密的回归测试。
- 读写副作用必须在命令权限和文档中保持显式；不要把外部写操作藏在健康检查、启动检查或无认证 setup 请求中。
- 跨平台代码应在 Linux、macOS、Windows CI 上保持可检查；目标仓库特有的 shell 要求应在文档中说明。
- 提交信息清楚描述行为变化和验证命令。

Pull Request 应说明变更范围、风险、测试结果和任何平台限制。贡献内容按根目录 Apache-2.0 许可证提供。
