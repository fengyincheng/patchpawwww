# GitLab setup: from zero to your first working MR

[中文版](GITLAB.md)

PatchPaw supports **GitLab.com** and **GitLab Self-Managed**. A GitLab-only deployment does **not** need a GitHub App, and GitHub plus GitLab can coexist in one PatchPaw instance.

This guide is intentionally practical. It walks through:

- creating a dedicated bot/service identity;
- choosing and creating a GitLab token;
- finding the numeric Project ID;
- first-boot configuration for a GitLab-only PatchPaw;
- the exact webhook URL and event type;
- creating a first Merge Request;
- testing conversation first, then `/review`, then write-enabled custom commands;
- troubleshooting the failures that are easiest to misdiagnose.

---

## GitLab calls PRs “Merge Requests”

A few names differ:

| GitHub | GitLab |
| --- | --- |
| Pull Request / PR | Merge Request / MR |
| PR conversation comment | Ordinary MR Note / Comment |
| Repository | Project |
| GitHub App | GitLab bot/service account/token connection |

PatchPaw's GitLab webhook flow is centered on **new ordinary MR Notes that mention the configured bot**.

It does not treat ordinary Issues, inline discussions, system Notes, or edits to an old Note as the same trigger.

---

## What you need

| Item | Example |
| --- | --- |
| GitLab instance URL | `https://gitlab.com` |
| Bot username | `patchpaw-bot` |
| GitLab token | keep private |
| Numeric Project ID | `12345678` |
| PatchPaw Connection ID | `gitlab-prod` |
| Webhook secret | random secret |
| Public PatchPaw HTTPS origin | `https://patchpaw.example.com` |
| Working model credential | DeepSeek, Zhipu, etc. |

Start with one disposable or low-risk project. Add more Project IDs after the full flow works.

---

# 1. Create a dedicated GitLab bot identity

Prefer one of these:

1. a GitLab Service Account when your plan/instance provides it;
2. a dedicated normal GitLab user used only by PatchPaw;
3. a Project/Group Access Token when your plan and administrator policy make it available.

A dedicated identity is easier to audit, revoke, and recognize in MR discussions.

Example username:

```text
patchpaw-bot
```

If Project Access Tokens are not available in your namespace, do not get stuck there. A dedicated bot/service account with a PAT works.

---

# 2. Add the bot to the target Project

Add the bot as a project member.

Recommended minimum role:

```text
Developer
```

Two identities matter:

- the **bot** needs enough access to read MRs, publish Notes, and push same-project source branches for write flows;
- the **human who sends commands** must also be an active project member with Developer or higher access.

Protected branch rules still apply. Do not disable branch protection just to make PatchPaw pass a smoke test.

---

# 3. Create the bot token

For the full feature set, use scopes that cover:

```text
api
write_repository
```

Typical responsibilities:

- `api`: MR, Note, membership, pipeline/job reads and Note publication;
- `write_repository`: Git-over-HTTPS writeback to an MR source branch.

### Copy the token immediately

Treat the full token value as a one-time display.

If you leave the creation page without copying it, the normal solution is to revoke/rotate it and create a replacement. Do not paste the token into issues, screenshots, or chat.

PatchPaw also does not reveal stored token values again.

---

# 4. Find the numeric Project ID

PatchPaw wants the GitLab project's **numeric Project ID**, for example:

```text
12345678
```

Do not confuse it with:

- MR IID such as `!1`;
- Group ID;
- user ID;
- a project path such as `group/project`.

Depending on GitLab UI version, the Project ID is usually visible in project information or under **Settings → General**.

Use numeric IDs in PatchPaw whenever possible because they remain stable when a project is renamed or moved.

---

# 5. Give PatchPaw a public HTTPS origin

GitLab.com cannot call:

```text
http://127.0.0.1:3000
```

Use a public HTTPS origin such as:

```text
https://patchpaw.example.com
```

A GitLab webhook URL has this shape:

```text
https://patchpaw.example.com/gitlab/webhook/<connection-id>
```

For Connection ID `gitlab-prod`:

```text
https://patchpaw.example.com/gitlab/webhook/gitlab-prod
```

### Temporary smoke test with Cloudflare Quick Tunnel

For a disposable test:

```sh
cloudflared tunnel --url http://127.0.0.1:3101
```

Remember that a Quick Tunnel URL may change on restart. If it changes, update both:

- `PATCHPAW_PUBLIC_ORIGIN`;
- the GitLab webhook URL.

---

# 6. Fresh GitLab-only deployment

A completely fresh GitLab-only runtime is the easiest place to make a configuration mistake.

## Create and keep a real `.env`

From the project root:

```sh
cp .env.example .env
chmod 600 .env
npm run generate:admin-token
```

Keep the project-root `.env` file present.

Detached PatchPaw workers reload configuration. If the main service was started with temporary shell variables but the project `.env` later disappears, you can see a misleading pattern:

```text
Webhook accepted
→ inbound becomes dispatched
→ child worker exits immediately
→ no state, no outbound reply
```

## GitHub variables must be complete or empty

For GitLab-only operation, leave the GitHub configuration group empty.

Do not configure only one or two GitHub fields.

## Generate a webhook secret

For example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The webhook secret is not the GitLab PAT.

## Bootstrap the GitLab connection

Example:

```dotenv
PATCHPAW_PUBLIC_ORIGIN=https://patchpaw.example.com
PATCHPAW_PORT=3000
PATCHPAW_ADMIN_TOKEN=<generated-admin-token>
PATCHPAW_HOME=

PATCHPAW_GITLAB_CONNECTIONS=[{"id":"gitlab-prod","instance_url":"https://gitlab.com","project_ids":["12345678"],"token_env":"PATCHPAW_GITLAB_TOKEN","webhook_secret_env":"PATCHPAW_GITLAB_WEBHOOK_SECRET","webhook_mode":"secret","bot_login":"patchpaw-bot"}]
PATCHPAW_GITLAB_TOKEN=<bot-token>
PATCHPAW_GITLAB_WEBHOOK_SECRET=<random-webhook-secret>
```

Field meanings:

| Field | Meaning |
| --- | --- |
| `id` | PatchPaw connection name |
| `instance_url` | GitLab.com or Self-Managed origin |
| `project_ids` | allowed numeric Project IDs |
| `token_env` | environment variable containing the GitLab token |
| `webhook_secret_env` | environment variable containing the webhook secret |
| `webhook_mode` | use `secret` for first setup |
| `bot_login` | optional expected bot username; must match the token owner if supplied |

For Self-Managed use:

```text
https://gitlab.example.com
```

not:

```text
https://gitlab.example.com/api/v4
```

PatchPaw adds the API path itself.

### Why bootstrap is required on first GitLab-only start

With a new runtime home, PatchPaw needs at least one of:

- a complete GitHub App configuration;
- a GitLab bootstrap connection;
- an already-persisted control-plane SCM connection.

Without any of those, startup is rejected.

---

# 7. Add GitLab to an already-running PatchPaw

If PatchPaw already starts because GitHub or an existing control plane is configured, open:

```text
Settings / Operator settings
→ GitLab connections
```

Fill:

| UI field | Example |
| --- | --- |
| Connection ID | `gitlab-prod` |
| Instance URL | `https://gitlab.com` |
| Project IDs | `12345678` |
| Bot username | `patchpaw-bot` |
| PAT / project token | bot token |
| Webhook secret | random secret |

Then use **Verify**.

The token owner is the real bot identity. Do not enter your personal PAT while claiming a different service-account username.

For a first setup, use webhook `secret` mode. Standard Webhooks signing is supported, but it is not necessary for the simplest path.

---

# 8. Start PatchPaw and verify health

```sh
npm ci
npm run check
npm run build
npm start
```

Local health:

```sh
curl http://127.0.0.1:3000/health
```

Then verify the public endpoint:

```text
https://patchpaw.example.com/health
```

Configure GitLab only after both sides are reachable.

---

# 9. Configure the GitLab Project webhook

Open the target Project:

```text
Settings
→ Webhooks
```

### URL

```text
https://patchpaw.example.com/gitlab/webhook/gitlab-prod
```

The final path segment must match the PatchPaw Connection ID.

### Secret token

Use the same webhook secret configured in PatchPaw.

This is **not** the PAT.

### Event type

For the first smoke test, enable only the event corresponding to:

```text
Comments / Note events
```

GitLab wording varies slightly by version.

PatchPaw's main trigger path expects a newly-created ordinary MR Note that:

- belongs to an allowed Project ID;
- mentions the configured bot;
- comes from an eligible human.

System Notes, inline discussions, edited Notes, unrelated Projects, and the bot's own Notes are ignored by this flow.

---

# 10. Create a minimal MR

If the project only has `main`, create a second branch such as:

```text
smoke/hello
```

Edit README, commit to that branch, and open:

```text
Source branch: smoke/hello
Target branch: main
```

GitLab's **Merge requests** section is the equivalent of GitHub Pull requests.

---

# 11. Test conversation first

Post an ordinary MR comment:

```text
@patchpaw-bot Hello, briefly explain this MR.
```

This tests the shortest useful chain:

```text
MR Note
→ webhook
→ secret validation
→ Project allowlist
→ bot mention
→ actor authorization
→ MR read
→ model
→ durable outbox
→ MR Note reply
```

Do this before trying write commands.

---

# 12. Test /review next

After conversation works:

```text
@patchpaw-bot /review
```

A successful review should read the exact MR head and target branch, create a read-only worktree, run the Review Agent, re-check freshness, and publish an ordinary MR Note.

### Conversation working does not prove /review has a valid model credential

Each command can bind a different Provider/Model.

If conversation works but `/review` fails with:

```text
ProviderUnavailable
Provider credential is unavailable
```

check the model binding and credential for **/review itself** before debugging GitLab.

---

# 13. Commands and write permissions

Common seeded repository commands:

```text
/review
/CI
/conflict
```

System controls include:

```text
/stop
/close
/approval
```

`/repair` is not seeded by default. Create it explicitly with the repair execution type if you want that command.

A command such as `/edit` is also a user-defined custom command, not a hard-coded built-in.

## Custom read_only

A `custom` command with `read_only` cannot modify the candidate workspace.

## Custom read_write

For a same-project GitLab MR, `custom + read_write` allows the Agent to modify the workspace.

The Harness owns remote writeback:

```text
Agent edits
→ Harness inspects candidate
→ if Agent already committed cleanly, do not create a duplicate commit
→ if changes are still uncommitted, Harness commits them
→ non-force push
→ GitLab API confirms the remote MR head
→ only then publish success
```

If the Agent created a commit but left residual dirty changes, the Harness commits the remaining changes rather than dropping them.

Agent-authored direct push is blocked; the Harness remains authoritative for remote writeback.

Fork MRs stay read-only for these write paths.

---

# 14. Human actor requirements

PatchPaw re-checks the current GitLab user and project membership.

Executable commands require an explicitly active human with Developer or higher access.

Bot accounts do not authorize themselves, and PatchPaw ignores its own Notes.

A successful webhook delivery therefore does not automatically mean the model will run.

---

# 15. Self-Managed notes

Use the GitLab instance origin only:

```text
https://gitlab.company.example
```

Do not include:

- `/api/v4`;
- credentials;
- query strings;
- fragments.

Ensure:

- the PatchPaw host can reach the GitLab API;
- the PatchPaw host can fetch/push Git over HTTPS;
- GitLab can reach the PatchPaw webhook;
- certificate chains are trusted on both sides.

---

# 16. “dispatched” is not the same as “completed”

An inbound status of:

```text
dispatched
```

usually means the verified event was handed to a worker.

It does **not** mean:

- the model started;
- the model finished;
- a Note was published;
- a push succeeded.

Look for the run result and outbound publication.

Typical run states include:

```text
conversation_completed
review_completed
custom_completed
ci_completed
repair_completed
needs_human
provider_unavailable
review_stale
```

---

# 17. Troubleshooting

## Webhook succeeds but no bot reply

Check in this order:

1. webhook URL ends with the correct Connection ID;
2. webhook secret matches;
3. Comments/Note event is enabled;
4. this is a new ordinary MR Note;
5. the bot username is actually mentioned;
6. numeric Project ID is allowlisted;
7. the human author is Developer+;
8. bot token still has project access;
9. a worker run was actually created;
10. the project-root `.env` still exists.

## Conversation works, /review does not

Check the `/review` Provider/Model binding and credential.

## Lost PAT

Revoke/rotate it, create another, copy it immediately, and update PatchPaw.

## Bot identity stale

If `bot_login` says `patchpaw-bot` but the token belongs to another user, fix either the token or configured username.

## Webhook 401

Do not confuse:

- GitLab PAT;
- webhook secret.

They have different purposes.

## Quick Tunnel stopped working

A new tunnel URL requires both `PATCHPAW_PUBLIC_ORIGIN` and the GitLab webhook URL to be updated.

## read_write custom did not push

Check:

- command permission is really `read_write`;
- source and target belong to the same Project;
- bot can push the source branch;
- branch protection allows it;
- remote head/base did not drift;
- the Agent actually changed something.

A no-op result is valid and should not create an empty commit.

---

# 18. Recommended acceptance order

### L0 — connectivity

- local and public `/health` work;
- token identity is correct;
- numeric Project ID is allowlisted;
- webhook deliveries reach PatchPaw.

### L1 — conversation

```text
@patchpaw-bot Hello, briefly explain this MR.
```

### L2 — review

```text
@patchpaw-bot /review
```

### L3 — custom read/write

Create a custom command such as:

```text
/edit
execution_type = custom
permission = read_write
```

Then:

```text
@patchpaw-bot /edit Apply the review suggestion.
```

Verify:

- the source branch gets a new commit;
- target/main is unchanged;
- MR Changes shows the real edit;
- the final PatchPaw Note contains the Harness-confirmed commit SHA.

### L4 — CI / conflict

Then move to:

```text
@patchpaw-bot /CI
```

and:

```text
@patchpaw-bot /conflict
```

Conflict repair requires an explicit later `/approval`. Ordinary words such as “continue” or “approved” do not substitute for the control command.

---

# 19. Security

Keep these server-side:

- GitLab token;
- webhook secret;
- Provider credentials.

Do not commit them, place them in clone URLs, publish screenshots, or paste them into Issues.

See:

- [Security Model](SECURITY-MODEL.md)
- [Operations](OPERATIONS.md)

---

# First-time setup checklist

- [ ] dedicated bot/service account exists
- [ ] bot is a Developer or higher on the Project
- [ ] token covers `api` and `write_repository` for full functionality
- [ ] token was copied and stored securely
- [ ] numeric Project ID is known
- [ ] PatchPaw has a public HTTPS origin
- [ ] fresh GitLab-only deployment keeps a real `.env`
- [ ] `PATCHPAW_GITLAB_CONNECTIONS` is valid JSON
- [ ] Connection ID is fixed
- [ ] webhook secret is configured
- [ ] webhook URL is `/gitlab/webhook/<connection-id>`
- [ ] Comments/Note event is enabled
- [ ] human tester is Developer+
- [ ] conversation works
- [ ] `/review` has a working Provider/Model binding
- [ ] write-enabled custom is tested only on a same-project MR
- [ ] final success is verified from the remote MR head / Changes, not only model text
