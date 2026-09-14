# PatchPaw

PatchPaw is a self-hosted GitHub App service. It receives signed Pull Request and issue-comment events, runs repository-configured review, CI repair, conflict analysis, and conversation tasks, and publishes results back to GitHub. It also provides a React control plane for repositories, Prompts, Skills, models, and commands.

[简体中文主文档](README.md)

## Read the security boundary first

PatchPaw executes Git, validation, and model-generated commands in a target repository workspace. The application is not a container or sandbox. Run untrusted repositories under an isolated service account, container, or virtual machine. Production operators must provide HTTPS, restrict the runtime account, and protect the runtime home, `.env`, GitHub App private key, webhook secret, and provider credentials.

Command permission is explicit: `review`, ordinary conversation, and conflict analysis are read-only by default; `repair` and `ci` paths can be read-write and may commit, push, or post GitHub comments. Opening a Pull Request, receiving a passive PR event, or running a health check does not automatically start a model task.

## Architecture

- The GitHub App handles installation authorization and webhook signing; the server verifies events and reads GitHub state.
- The control-plane database stores repository-scoped Prompts, Skills, Providers, Models, Commands, and the read-only conversation profile.
- Each execution receives an immutable effective-configuration snapshot; evidence, logs, and workspace state live under the runtime home.
- Unauthenticated `/api/setup` exposes only the origin, derived webhook URL, HTTPS status, and whether admin authentication is configured. It never exposes credentials or paths.
- The frontend uses relative API URLs and an HttpOnly session cookie. The admin token is sent only in the login request and has no readback endpoint.

## Requirements

- Node.js 22.22.0 or a compatible newer release
- Git
- A GitHub App installed on the repositories it should manage
- A public HTTPS domain for a reverse proxy/TLS endpoint (an explicit localhost HTTP origin is suitable for local development)
- At least one supported model-provider credential; model requests may incur provider charges and are subject to provider data terms

PatchPaw's native Node runtime supports Linux, macOS, and Windows. A target repository's own validation commands may still require a particular shell or toolchain.

## Install and first start

```sh
git clone https://github.com/fengyincheng/patchpawwww.git
cd patchpawwww
npm ci
cp .env.example .env
npm run generate:admin-token
npm run check
npm test
npm run build
npm run start
```

In Windows PowerShell, use `Copy-Item .env.example .env`; the npm commands are the same. Put the single line printed by the token generator in the server-only `.env`; do not write command output to the repository or logs. `npm run start` listens on the local host by default and should be published through a reverse proxy in production.

## Create the GitHub App, domain, and webhook

1. Create a GitHub App for this deployment, choose a unique App slug and App ID, and install it only on the repositories that need access.
2. Set `PATCHPAW_PUBLIC_ORIGIN` to the public scheme and host with no path, such as `https://patchpaw.example.com`. The browser origin, this value, and the GitHub App webhook URL must use the same origin.
3. Set the GitHub App webhook URL to `https://patchpaw.example.com/github/webhook` and create a new random webhook secret. Enable the events required by the deployment: `pull_request` and `issue_comment`; enable installation events only if installation-state synchronization is needed.
4. Grant minimum repository permissions: Metadata is at least Read; enable Pull requests, Issues/issue comments, Contents, Checks/Actions, and other permissions only for flows that use them. A repair command that commits or pushes needs Contents write; read-only review should not have write access.
5. Download the App private key once, store it outside the repository or in a restricted secrets directory, and set `PATCHPAW_GITHUB_PRIVATE_KEY_PATH`. Never commit the PEM file. Rotate the webhook secret and private key independently; revoke and regenerate immediately after suspected exposure.
6. Point DNS at a reverse proxy. The proxy terminates TLS and forwards `/`, `/api/*`, and `/github/webhook` to the local PatchPaw listener while preserving the expected host/origin behavior. Do not cache `/api/setup` or admin API responses.

The login page and Settings display the configured origin, derived webhook URL, HTTPS status, token status, and a comparison with `window.location.origin`. If they show a mismatch, fix DNS, proxy routing, and `PATCHPAW_PUBLIC_ORIGIN` before attempting to log in. Restart after changing environment variables.

## Admin login credential

```sh
npm run generate:admin-token
```

The command uses the system cryptographic random source to generate a 32-byte, 64-hex-character token. It prints exactly one line, writes no file, persists no value, and has no API recovery or readback endpoint. Put it in the server-only `.env` as `PATCHPAW_ADMIN_TOKEN`, restart, and enter it on the HTTPS login page. The browser receives only a short-lived HttpOnly session cookie; the built frontend assets contain no token.

To rotate, generate a replacement, update `.env`, and restart. Restarting clears in-memory sessions, invalidating prior logins. A lost token cannot be recovered; generate and configure a replacement. Keep it out of Vite public variables, browser local storage, shell history, CI logs, and issues.

## Environment summary

`.env.example` is the complete generic template. Required values include the GitHub App ID/slug, webhook secret, private-key path, public origin, listener port, and target repository. `PATCHPAW_ADMIN_TOKEN` is required for control-plane login but is intentionally blank in the template. `ZAI_*` values can initialize the first control-plane provider; Providers can subsequently be managed in Models, where the UI shows only credential status and never echoes a secret.

When `PATCHPAW_HOME` is empty, durable state is stored in `~/.patchpaw` on Linux/macOS and `%USERPROFILE%\\.patchpaw` on Windows (normally `C:\\Users\\<user>\\.patchpaw`). It is not disposable cache: it contains databases, repository caches, workspaces, runs, snapshots, logs, backups, locks, and server-side credential references. Set `PATCHPAW_HOME` for another disk or service identity and protect it with OS permissions; on Windows configure an NTFS ACL limited to the service account.

## Safe checks and side effects

Run local verification in this order:

```sh
npm run check
npm test
npm run build
```

These commands should not create GitHub branches, Pull Requests, commits, or model requests (apart from test fixtures). `npm run verify:frontend -- <url>` only compares built frontend assets; never pass a real token as a command argument.

The following operations can change external or durable state and require explicit approval and backups:

- `run-pr` and commands with repair permission may call a model, modify a workspace, commit/push changes, and post comments.
- `bootstrap:control-plane` and Prompt/Skill/Provider/Command management modify the control-plane database.
- `backup-runtime`, `restore-runtime`, and `migrate-runtime` read or write the runtime home; confirm targets and backup sources first.
- Webhook handling persists snapshots, and issue comments may enter an execution queue; invalid signatures are rejected before payload parsing.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for command behavior, output contracts, and permission boundaries.

## Limitations and reporting

PatchPaw is not a hosted service and does not provide DNS, certificates, GitHub App provisioning, user accounts, or token recovery. The operator owns availability of GitHub, the model provider, the target repository toolchain, and the reverse proxy. Cross-platform support means PatchPaw's native Node runtime supports Linux/macOS/Windows; it does not mean every target repository's POSIX command works unchanged on Windows.

Read [SECURITY.md](SECURITY.md) before reporting a problem. Do not paste tokens, private keys, webhook payloads, runtime logs, or private repository content into public issues. See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions and [LICENSE](LICENSE) for Apache-2.0 terms.
