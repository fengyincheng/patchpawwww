# Docker 部署

PatchPaw 官方镜像运行 Linux container，发布仓库为 `ghcr.io/fengyincheng/patchpaw`，目标架构为 `linux/amd64` 和 `linux/arm64`。它可运行在 Linux Docker、Windows Docker Desktop/WSL2、macOS Docker Desktop 上；Windows/macOS 上运行的仍是 Linux 版 PatchPaw。目标仓库需要 Windows/MSVC/Windows SDK 的检查，仍须真正的 Windows runner。

镜像按稳定 Git tag 发布。生产环境建议在 `.env` 中把 `PATCHPAW_IMAGE` 固定到完整版本，例如 `ghcr.io/fengyincheng/patchpaw:v0.3.0`；`latest` 只跟随稳定 release。首次发布前 GHCR 尚无可拉取的官方 tag。不要把官方 Docker 支持理解为原生支持所有操作系统。

发布时 `package.json` 与 `package-lock.json` 的应用版本必须同步为 release semver（不带 `v`），再推送 `vMAJOR.MINOR.PATCH` tag。工作流会拒绝不匹配的 tag；`/health` 版本与 OCI version label 因而都来自同一 release 版本。首次推送后，维护者还需在 GitHub Packages 将 `ghcr.io/fengyincheng/patchpaw` 设为 Public，并验证匿名用户可拉取 exact `vX.Y.Z` tag；发布 workflow 不会自行更改包可见性。

## 从零安装

准备 Docker Engine 和 Docker Compose v2。克隆仓库并建立本地配置：

```sh
git clone https://github.com/fengyincheng/patchpawwww.git
cd patchpawwww
cp .env.example .env
mkdir -p secrets
```

编辑 `.env`：设置 `PATCHPAW_PUBLIC_ORIGIN`、模型 Provider 配置和单独生成的 `PATCHPAW_ADMIN_TOKEN`。GitHub App 用户把 PEM 放在 `secrets/`，并将 `PATCHPAW_GITHUB_PRIVATE_KEY_PATH` 设为容器内路径，例如 `/run/secrets/patchpaw/github-app.private-key.pem`。Compose 只读挂载整个目录；GitLab-only 安装不需要 PEM，可以让目录为空。Linux bind mount 用户需确保容器 UID `10001` 可读取 PEM，且宿主文件权限仍限制在可信账号/组内。

选择一个已发布的精确版本并拉取镜像：

```sh
# 在 .env 中设置 PATCHPAW_IMAGE=ghcr.io/fengyincheng/patchpaw:vX.Y.Z
docker compose pull
docker compose run --rm patchpaw npm run generate:admin-token
```

把命令输出的 token 安全地写入 `.env` 的 `PATCHPAW_ADMIN_TOKEN`，不要把它提交到 Git。然后用控制面 bootstrap 初始化 Provider、Model 和可选仓库：

```sh
docker compose run --rm patchpaw npm run bootstrap:control-plane -- owner/repository
docker compose up -d
docker compose ps
```

GitLab-only 初装可省略 `owner/repository`，稍后在管理控制台配置 GitLab 连接和 Provider。空 runtime 首次启动不会伪装成已完成 bootstrap；bootstrap 后启动服务时，镜像会先应用安全的版本化 builtin asset migration。

默认端口只绑定宿主 `127.0.0.1:3000`。用 Nginx、Caddy 或 Traefik 终止 TLS 并反向代理到该端口；`PATCHPAW_PUBLIC_ORIGIN` 应填写浏览器和 SCM webhook 使用的公网 HTTPS origin。若直接发布到其他网络接口，请自行评估访问控制。

## 数据、秘密与安全边界

Compose 将整个 `/var/lib/patchpaw` 挂载到 Docker named volume `patchpaw-data`。它包含 SQLite 数据库、Memory、repo cache、worktree、run、snapshot、outbox、logs、locks、runtime secrets 和 backups。空 volume 会从镜像中带有 UID/GID `10001:10001` 所有权的目录初始化，服务以 `patchpaw` 非 root 用户（UID/GID `10001:10001`）运行。常规的 `docker compose down` 不会删除数据；`docker compose down -v` 会删除 volume 和其中所有 runtime 数据。

Windows/macOS Docker Desktop 默认使用 named volume。不要把 runtime home 放在 Windows/macOS bind mount、OneDrive、SMB、NFS 或其他网络共享文件系统上：SQLite/WAL、文件锁、Unix socket 和 atomic rename 需要可靠的本地 Linux 文件系统语义。Linux bind mount 仅作为高级用法，宿主目录必须允许 UID `10001` 写入。

GitHub App PEM 从 checkout 下的 `secrets/` 以只读方式挂载到 `/run/secrets/patchpaw/`，不会复制进镜像。Admin token、Webhook secrets 和其他环境变量通过 `.env` 注入；Provider/GitLab control-plane slot secrets 仍存于持久 runtime volume。备份脚本不包含 Provider secret slots；备份文件不能替代完整的 volume 与外部 `.env`/PEM 备份。更多备份边界见[运维说明](OPERATIONS.md)。

容器不是 Agent 的 OS 安全沙箱。目标仓库命令与 PatchPaw service 在同一 container 环境中运行，不能因此把不可信代码视为安全。Compose 不挂 Docker socket、不启用 `privileged`，并启用 `no-new-privileges`。当前一个 `PATCHPAW_HOME` 只支持一个活动服务实例；不要用 `docker compose up --scale patchpaw=...`。多实例必须使用不同 runtime volume、端口和配置。

## 日常运维与升级

```sh
docker compose logs -f patchpaw
docker compose exec patchpaw npm run agent:runs -- --limit 20
docker compose exec patchpaw npm run agent:open -- owner/repo 123
docker compose down
```

升级前确认没有仍需运行的重要写任务，并从当前版本执行 runtime backup：

```sh
docker compose run --rm patchpaw npm run backup-runtime
```

然后在 `.env` 中更新到新的精确版本，拉取并重建容器：

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 patchpaw
```

已有 `data/control-plane.db` 时，entrypoint 在启动 PatchPaw 前执行 `migrate:builtin-assets --apply`；失败会阻止服务启动并保留清晰的 migration 错误。全新 runtime 没有该数据库时会跳过 migration。启动过程永远不会执行 `sync:operation --apply`；Prompt 同步仍是显式运维操作。等待 healthcheck 为 `healthy` 后，再检查 Web UI、SCM webhook 和 observer/outbox。若 migration 失败，先保留日志和 volume，按备份恢复流程排查，不要删除 volume 重试。

## 扩展 Agent 工具链

官方基础镜像包含 PatchPaw、Node.js/npm、Git、CA certificates 和 Web UI，不预装 Python、Java、Rust、Go、Android SDK、.NET、CUDA 或 Docker CLI。Agent 可调用的工具取决于镜像 `PATH`。为目标项目增加工具链时，维护自己的 derived image；不要通过 `docker exec` 临时安装，重建容器后临时改动会消失。

仓库提供 [扩展示例 Dockerfile](../docker/examples/Dockerfile.extend)，默认示例安装 Python。将其中的版本占位符换成已发布版本，并可按需更换 apt 包：

```dockerfile
ARG PATCHPAW_BASE_IMAGE=ghcr.io/fengyincheng/patchpaw:v0.3.0
FROM ${PATCHPAW_BASE_IMAGE}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
USER patchpaw
```

在 `compose.toolchain.yaml` 中覆盖镜像：

```yaml
services:
  patchpaw:
    image: my-patchpaw:python
    build:
      context: .
      dockerfile: docker/examples/Dockerfile.extend
      args:
        PATCHPAW_BASE_IMAGE: ghcr.io/fengyincheng/patchpaw:v0.3.0
```

```sh
docker compose -f compose.yaml -f compose.toolchain.yaml build
docker compose -f compose.yaml -f compose.toolchain.yaml up -d
```

Python/Java/Rust/Go 项目分别在 derived image 中安装所需 runtime、compiler 和 package manager。扩展 image 仍应使用非 root runtime 用户；不要增加 Docker socket 或 `privileged`。

## 从 native 部署迁移

本指南只提供迁移准备，不会自动切换线上服务。绝不能让原生 PM2/systemd 服务和 Docker 同时使用同一个 `PATCHPAW_HOME`：

1. 记录 native 服务配置和实际 `PATCHPAW_HOME`，确认没有重要写任务。
2. 通过现有流程备份 runtime，并单独备份外部 `.env`、GitHub PEM 和 volume 外的凭据。
3. 停止旧服务，确认没有进程继续访问 runtime home。
4. Linux 可将旧目录 bind mount 到 `/var/lib/patchpaw`，或复制到 named volume；先解决容器 UID `10001` 的访问权限。
5. 启动 Docker 后验证 `/health`、Web 控制台、GitHub/GitLab webhook、Memory、observer 和 outbox。
6. 确认稳定后再由操作员决定是否移除旧 PM2/systemd 配置。

不要在此次源码/镜像准备过程中停止生产服务、改域名/反向代理、改 webhook，或搬动真实 runtime 数据。
