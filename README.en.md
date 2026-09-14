# PatchPaw

A self-hosted GitHub App for PR conversations, code reviews, CI repair and conflict analysis, with a web console for repositories, models, prompts, skills and commands.

[中文](README.md) · [Operations](docs/OPERATIONS.md) · [Security model](docs/SECURITY-MODEL.md) · [Contributing](CONTRIBUTING.md)

This is an early release for operators comfortable maintaining their own deployment. Linux and macOS are supported; Linux is recommended for production. **Native Windows is not currently supported. No official Docker image is available. A Linux container image usable through Docker on Windows may be considered in the future; there is no release date.**

## Prerequisites

- A persistent Linux host or macOS, Node.js **22.x, version 22.22.0 or newer**, npm and Git.
- A domain or subdomain you control, with DNS and an HTTPS reverse proxy.
- Permission to register a GitHub App and install it on your target repositories.
- A model API credential. Supported provider types: Zhipu/Z.ai, DeepSeek, OpenRouter, Kimi and Qwen. Check model availability, endpoints, costs and data policies yourself.
- The target repository's toolchain, such as Python, compilers or package managers. PatchPaw does not provision every project's dependencies.

PatchPaw does not provide hosting, domains or model credits. It executes repository code and model-generated commands and **is not a security sandbox**. Use a dedicated non-root account and an isolated host or VM for untrusted PRs. Do not share the execution environment with unrelated sensitive credentials.

## 1. Choose one public origin

For `https://patchpaw.example.com`:

| Purpose | URL |
| --- | --- |
| Web console | `https://patchpaw.example.com/` |
| GitHub App webhook | `https://patchpaw.example.com/github/webhook` |
| Public setup information | `https://patchpaw.example.com/api/setup` |
| Health endpoint | `https://patchpaw.example.com/health` |

**The frontend, API and webhook share one domain and server process.** There is no separate frontend server to deploy. Set `PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com`, without a subpath or webhook suffix. This declares the public origin; it does not configure DNS, certificates or network bindings.

## 2. Register and install your GitHub App

Open your personal or organization **Settings → Developer settings → GitHub Apps → New GitHub App**. For personal accounts, start at [GitHub App settings](https://github.com/settings/apps).

### Registration fields

| Field | Value |
| --- | --- |
| GitHub App name | A globally unique name, e.g. `my-team-patchpaw` |
| Homepage URL | Your public origin |
| Callback URL / Setup URL | Leave blank; the console does not use GitHub OAuth |
| Request user authorization (OAuth) during installation | Unchecked |
| Enable Device Flow | Unchecked |
| Webhook → Active | Checked |
| Webhook URL | `https://patchpaw.example.com/github/webhook` |
| Webhook secret | A random secret; use the exact same value in your server configuration |
| SSL verification | Enabled |

Generate a webhook secret and store it privately. Use a separate value for the admin token:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Repository permissions

| Permission | Access | Purpose |
| --- | --- | --- |
| Metadata | Read-only, provided automatically | Repository metadata |
| Contents | Read-only; Read and write for repair pushes | Fetch code and push repairs |
| Pull requests | Read and write | Read PRs, publish reviews and PR comments |
| Commit statuses | Read-only | Read commit status |
| Checks | Read-only | Read check results |
| Actions | Read-only | Read workflow runs, jobs and failure logs |
| Workflows | No access by default; Read and write only for workflow edits | Push changes under `.github/workflows/*` |

Leave other permissions at No access, including organization/account permissions and Administration. A separate Issues write grant is not needed for the current PR comment flow: GitHub accepts Pull requests write permission for that endpoint. GitHub grants and individual command permissions are separate controls.

### Events and installation

Subscribe to **Pull request** and **Issue comment**. The latter covers ordinary comments on a PR's Conversation tab, not inline review comments. Do not substitute Pull request review comment. Push, Check run and Workflow run subscriptions are not required; CI information is fetched during execution.

For installation scope, select **Only on this account** for personal use, or **Any account** if other accounts/organizations need to install the App. After creation:

1. Record the **App ID**, not Client ID or Installation ID.
2. Confirm the slug from `https://github.com/apps/<slug>`.
3. Use **Private keys → Generate a private key** and download the PEM.
4. Open **Install App → Install**, choose the account and **Only select repositories**, then select your target repositories. Registration alone does not grant repository access.
5. When you later add permissions, the installation owner must approve the changes.

An initial ping may fail before the server is running. Check deliveries after deployment. References: [registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [PR comment endpoint permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

## 3. Install and configure

Run as the account that will run the service:

```sh
git clone https://github.com/fengyincheng/patchpawwww.git
cd patchpawwww
npm ci
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
npm run generate:admin-token
```

Save the generated admin token in a password manager and your server-side `.env`. Upload the App PEM as `secrets/github-app.private-key.pem` and restrict access:

```sh
chmod 600 secrets/github-app.private-key.pem
```

Replace every placeholder in `.env`:

```dotenv
PATCHPAW_GITHUB_APP_ID=123456
PATCHPAW_GITHUB_APP_SLUG=my-team-patchpaw
PATCHPAW_GITHUB_WEBHOOK_SECRET=replace-with-your-webhook-secret
PATCHPAW_GITHUB_PRIVATE_KEY_PATH=./secrets/github-app.private-key.pem
PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com
PATCHPAW_PORT=3000
PATCHPAW_GITHUB_TEST_REPO=owner/repository
PATCHPAW_ADMIN_TOKEN=replace-with-your-generated-admin-token
PATCHPAW_HOME=
```

An empty `PATCHPAW_ADMIN_TOKEN=` fails configuration validation; fill it in for this setup. Never publish environment files, PEMs or command output containing credentials, even though local secret paths are Git-ignored.

`PATCHPAW_GITHUB_TEST_REPO` remains required for passive PR snapshots. **It does not register a console repository**; initialize that explicitly in the next step. An empty `PATCHPAW_HOME` uses the service account's `~/.patchpaw`, which holds databases, repository caches, workspaces, execution records and server credentials. This is persistent data, not disposable cache. Keep the same directory when changing service managers/accounts.

For Zhipu/Z.ai, configure `ZAI_API_KEY`, `ZAI_BASE_URL` and `ZAI_MODEL`. For other providers, leave these empty and configure the provider and model bindings in the console later. See [.env.example](.env.example) for all variables.

## 4. Initialize a repository and start

```sh
# Use repositories on which the App is installed; separate multiple names with spaces
npm run bootstrap:control-plane -- owner/repository
npm run check
npm run build
npm start
```

Bootstrap writes the local database and seeds prompts, skills, `/review`, `/CI`, `/conflict` and the conversation profile. Initial model bindings use Zhipu; successful bootstrap does not prove the credential is usable. **Default /CI and /conflict configurations have read/write permission.** Review or disable unwanted commands before use.

The server binds only to `127.0.0.1:3000` (or the configured port). Check `curl http://127.0.0.1:3000/health` from another terminal. For persistent operation, use systemd or your existing process manager with the same service account, configuration and data directory. A regular foreground process ends with its terminal. Restart after environment changes.

For development/release verification, also run `npm test`. Tests use local fixtures and do not require live GitHub or model credentials.

## 5. Publish HTTPS

Point your DNS record at the host and proxy **all paths** on that domain to `127.0.0.1:3000`. You are responsible for certificates, renewal and public connectivity.

For an existing Nginx installation with a valid certificate, the core configuration is:

```nginx
server {
    listen 443 ssl;
    server_name patchpaw.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Replace the certificate paths; this example does not issue a certificate. Do not cache `/api/*`, add browser login challenges to `/github/webhook`, or rewrite its request body. Only the HTTPS entry point needs public exposure, not port 3000.

## 6. Sign in and bind models

1. Open the public origin and check the displayed origin and webhook URL. Resolve any origin mismatch.
2. Sign in with the generated admin token, not your GitHub password or webhook secret.
3. In Models, configure the provider endpoint, credential and model identifier; enable them. Choose a model with the tool-calling capabilities required by your commands.
4. Select the usable model in the repository's Commands and conversation configuration, then save. **Adding a provider does not replace the initial Zhipu bindings.**
5. Check enabled status, prompt/skill bindings and read/write permissions. Try a conversation or `/review` before repair flows.

The browser receives an HttpOnly session cookie; the frontend build does not contain the admin token. To replace a lost token, generate a new one, update configuration and restart. Old sessions expire on restart; there is no recovery endpoint. Stored model credentials are not displayed again.

## 7. Verify your first PR comment

Check **Advanced → Recent Deliveries** in your GitHub App settings. Fix failed deliveries and use Redeliver as needed. A successful ping only verifies the entry point.

As a repository owner/member/collaborator, post a **new ordinary comment on a PR's Conversation tab**, using your App slug:

```text
@my-team-patchpaw /review
```

Or start a conversation:

```text
@my-team-patchpaw Explain the main changes in this PR.
```

Do not assume the bot is named `@patchpaw`. Ordinary Issues, inline review comments and edits to existing comments do not trigger this flow. Opening or updating a PR alone does not start a model task.

A webhook response of `202 verification_pending` means queued; verify an actual bot reply too. Repair operations may commit and push, subject to App permissions, command settings and branch protection. Do not disable branch protection to test setup.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Startup failure | Node version, required fields, numeric App ID, PEM path/access, port conflict |
| `frontend_not_built` | Run `npm run build` in the same checkout |
| Origin mismatch | Browser origin, PUBLIC_ORIGIN and proxy Host; restart after changes |
| Webhook 401 | Matching secrets, unchanged request body |
| GitHub 403/404 | Installation scope, approved permissions, repository name, branch rules |
| No reply | App slug, Issue comment subscription, new PR comment, author eligibility, repository initialization and enabled command |
| Provider unavailable / invalid configuration | Credential, endpoint, model and command/conversation bindings |
| Data seems lost after restart | Changed service account or PATCHPAW_HOME |

## Maintenance and limits

Stop the service and back up runtime data, `.env` and the App key before upgrades; backups contain secrets. After updating, run `npm ci`, `npm run check`, `npm test` and `npm run build`, then restart. See [operations](docs/OPERATIONS.md) and inspect script arguments before using backup, restore or migration tools.

This is a single-admin self-hosted tool without tenant isolation or an OS sandbox. Review model output. Passing platform CI does not guarantee every target project's toolchain works. See [SECURITY.md](SECURITY.md) for reporting; never publish credentials, private code or unredacted logs. Licensed under [Apache-2.0](LICENSE).
