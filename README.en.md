# PatchPaw

A self-hosted GitHub App for PR conversations, code reviews, CI repair and conflict analysis, with a web console for repositories, models, prompts, skills and commands.

[中文](README.md) · [Operations](docs/OPERATIONS.md) · [Security model](docs/SECURITY-MODEL.md) · [Contributing](CONTRIBUTING.md)

This is an early release for operators comfortable maintaining their own deployment. Linux and macOS are supported; Linux is recommended for production. **Native Windows is not currently supported. No official Docker image is available. A Linux container image usable through Docker on Windows may be considered in the future; there is no release date.**

Quick navigation: [Setup](#prerequisites) · [Commands](#everyday-commands) · [Custom commands](#create-a-custom-command-explain) · [Architecture](#architecture) · [Runtime data](#runtime-data-layout)

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

## Everyday commands

Replace `@my-team-patchpaw` with your App slug. Post a new ordinary comment on the PR's Conversation tab. Use one command per comment, immediately after the bot mention at the start of a line, outside quotes and code fences.

| Comment | Behavior |
| --- | --- |
| `@my-team-patchpaw Explain these changes` | Conversation using the repository's conversation profile |
| `@my-team-patchpaw /review` | Review the current PR and publish findings, without automatically repairing code |
| `@my-team-patchpaw /CI` | Read current-commit CI results/logs and enter the repair flow; may commit and push |
| `@my-team-patchpaw /conflict` | Analyze conflicts with the target branch and publish a proposal for discussion; repair requires explicit approval |
| `@my-team-patchpaw /approval` | Approve the current valid conflict proposal after reading it; `/approve` is an alias |
| `@my-team-patchpaw /stop` | Request cancellation, retaining execution evidence and applicable paused state |
| `@my-team-patchpaw /close` | Clear this PR's local session and associated work data, without closing the GitHub PR |

Bootstrap creates repository commands for review, CI and conflict. Stop, close and approval are reserved system controls. Matching is case-insensitive. Unknown, disabled or ambiguous multiple commands fall back to conversation and do not authorize repair. `/repair` is not seeded by default; create a command with the repair execution type if needed.

### Stop execution versus clear a session

Send `@my-team-patchpaw /stop` to stop interruptible work through cancellation signals and task checkpoints. It is not an undo operation or a guarantee of instant termination. Published comments and completed pushes remain; an external publication already in progress may finish. Check the final bot report and remote GitHub state. Supported task types may retain a paused workspace; reuse depends on version and other checks, and not every task can resume identically.

When finished with the PR, send `@my-team-patchpaw /close`. This removes local conversation memory, associated run records, workspaces, proposals, snapshots and comment inbox files. It preserves the shared Git repository, other PRs, repository configuration and GitHub comments/commits. It does not close the remote PR. Necessary closure and delivery records remain to prevent old comments from replaying. A later mention starts a new local session.

Close refuses while a task is active: send stop, wait for confirmation, then send close separately. Cleanup failures are recorded; another close retries cleanup without recreating deleted resources. An acknowledgement alone does not mean cleanup completed.

## Create a custom command: /explain

Commands are repository-scoped and may use different models, prompts and skills without server code changes.

1. Select the repository in the console. In **Prompts**, create and enable a repository prompt such as `explain-changes`, using the example below.
2. Open **Commands → New command**. Enter `explain` without the slash and a display name.
3. Select execution type **custom**, permission **read_only**, an available model, and enable the command.
4. Bind the prompt as an enabled **main** binding. Optionally add common requirements, auxiliary instructions and skills, then arrange their order.
5. Save and select **Preview effective** to inspect the model, permissions and composed prompt/skill content. Preview reads saved configuration and does not invoke the model; save edits first.
6. Post `@my-team-patchpaw /explain` on a PR.

Example prompt:

```text
Read the current PR changes and explain them to a new teammate:
1. What problem does this solve?
2. How do the key files work together?
3. Which callers may be affected, and what validation is missing?
Cite actual file paths. State uncertainty where evidence is missing.
Do not modify files or commit code.
```

Names must start with a lowercase letter and contain only lowercase letters, digits and hyphens, up to 32 characters. Reserved names include stop, close, approval, approve and confict. Enabled commands require at least one enabled main prompt. Public assets must first be available as repository-bindable assets; creating a prompt or skill alone does not attach it to a command.

**Custom commands use only the selected prompt/skill stack, without inheriting Review, CI or Conflict instructions or publication workflows.** Choosing read_write does not add the built-in CI verification/commit flow; choose the appropriate execution type when that flow is needed. Set permissions in configuration, not just in prompt wording. Conversations have a separate profile.

Each execution fixes its effective configuration snapshot. Editing the console does not replace instructions mid-run, and resuming an earlier execution may retain its original snapshot.

## Architecture

```text
GitHub PR comments / webhooks
          │ signature validation and durable inbox
          ▼
Communication scheduler ──► PR worker ──► Harness / models / tools
          ▲                     │                    │
          │                     │                    └─ Worktree, checks, evidence
          │                     └─ Configuration snapshot, PR state and memory
          └──── Durable outbox ──► GitHub comments / reviews

Web console ──► Admin API ──► Repository, model, prompt, skill and command configuration
```

Source code is separate from mutable runtime data:

```text
patchpawwww/
├── src/
│   ├── index.ts            # Service entry point
│   ├── server/             # Webhooks, admin API, sessions, frontend assets
│   ├── github/             # App client, PR/CI reads and review publishing
│   ├── control-plane/      # Configuration entities and snapshots
│   ├── runner/             # PR lifecycle, scheduling, pause, close, delivery
│   ├── harness/            # Models, tools, budgets, memory and traces
│   ├── tasks/              # Conversation, custom, review, repair, CI, conflict
│   ├── workspace/          # Shared Git object store and worktrees
│   ├── platform/           # Locks, processes and shell
│   └── migration/          # Migration, backup and restore
├── web/                    # React console
├── operation/              # Built-in prompt sources
├── skills/                 # Bundled skill assets
├── scripts/                # Bootstrap and operations
└── test/                   # Tests and local fixtures
```

### One repository, multiple PRs

Each GitHub repository has one persistent bare Git object store. Executions use separate linked worktrees sharing its objects instead of making a complete clone per PR. State, memory and execution artifacts are separated by PR/run. The repository lock covers metadata operations such as fetch and worktree creation/removal, not model execution, so different PRs can work concurrently within host resources and API quotas.

### Refreshing the code baseline

Before choosing a new or retained workspace, execution reads the GitHub PR state and fetches the **exact PR head and current target-branch tip**. If the target is main, main is refreshed; other target branches are handled by their actual names.

Runs record the SHAs they use. New worktrees start from the PR head; refreshing the shared store does not automatically merge main into the PR or mutate a paused worktree. Remote code can change during execution; publication and recovery paths perform relevant freshness checks and may require reprocessing when the baseline changes. This is not continuous live synchronization. It refreshes the target repository's Git data, not the PatchPaw application itself.

## Runtime data layout

The default is `~/.patchpaw/`, overridable with `PATCHPAW_HOME`. Directories are created as needed; SQLite WAL files and recovery/lock sidecars may also exist.

```text
~/.patchpaw/
├── data/
│   ├── control-plane.db    # Repositories, prompts, skills, providers, models, commands
│   ├── communication.db    # Durable inbox/outbox, delivery and recovery state
│   ├── memory/<hash>.db    # PR-specific conversation memory
│   ├── state/owner__repo/  # PR state, pause/close records and proposals
│   └── outbox/             # File-based outbound support data
├── secrets/providers/      # Server-side model credentials
├── repos/<encoded-repo>.git/ # One shared bare object store per repository
├── workspaces/<run-id>/     # Linked Git worktrees
├── runs/<run-id>/           # Traces, artifacts, validation and configuration snapshots
├── snapshots/              # GitHub event snapshots
├── logs/                   # Service logs
├── locks/                  # Runtime/repository coordination
├── backups/                # Backups
├── cache/                  # Cache directory
└── tmp/                    # Temporary data
```

Shared objects avoid repeated full clones. Lifecycle handling disposes of terminal workspaces where applicable, paused work may retain them, and close reclaims the main PR-local session artifacts. **There is no global disk quota or comprehensive automatic retention policy.** Git objects, communication records, logs, backups and unclosed sessions still require monitoring and maintenance. Automatic Git GC is disabled during shared-store fetches. Do not manually delete active databases/worktrees; stop the service and back up before maintenance.

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
