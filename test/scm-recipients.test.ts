import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAdapter } from '../src/scm/github/adapter.ts';
import type { ChangeRequestSnapshot } from '../src/scm/types.ts';
import { changeRequestRecipients, recipientLogins } from '../src/scm/recipients.ts';
import { reconcileLegacyOutbox } from '../src/runner/communication-legacy-reconciliation.ts';
import { listOutbound } from '../src/runner/outbound.ts';
import { statePath, writeState } from '../src/runner/state.ts';
import { Trace } from '../src/harness/trace.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { prepareEntryLifecycle } from '../src/runner/entry-lifecycle.ts';
import type { ScmConnection, ScmAdapter } from '../src/scm/types.ts';

function snapshot(kind: 'github' | 'gitlab', storageKey: string, pathWithNamespace: string): ChangeRequestSnapshot {
  const repository = { connectionId: 'fixture', kind, remoteProjectId: '88', pathWithNamespace, webUrl: '', cloneUrl: '', storageKey };
  return { schemaVersion: 1, kind, repository, changeRequest: { repository, number: 7, webUrl: '' },
    source: { projectId: '99', pathWithNamespace: 'source/repo', ref: 'feature', sha: 'head', cloneUrl: 'https://scm.example/source/repo.git' },
    target: { projectId: '88', pathWithNamespace, ref: 'main', sha: 'base' }, diffBaseSha: 'base', state: 'opened', title: '', body: '',
    author: { id: '17', login: 'developer' }, receivedAt: new Date(0).toISOString() };
}

test('recipient facts preserve GitHub compatibility and never infer a GitLab namespace from its storage key', () => {
  const github = snapshot('github', 'github:fixture:project:88', 'owner/repo');
  const gitlab = snapshot('gitlab', 'gitlab:worker:project:88', 'group/subgroup/repo');
  const adapter = new GitHubAdapter({} as any, 'patchpaw');
  assert.deepEqual(adapter.workspaceFetchPlan(github), { head: { kind: 'origin' } });
  assert.deepEqual(changeRequestRecipients(github), ['developer', 'owner']);
  assert.deepEqual(changeRequestRecipients(gitlab, undefined, ['gitlab:worker:project:88', 'operator', 'developer']), ['developer', 'operator']);
  assert.deepEqual(recipientLogins(['developer', 'gitlab:worker:project:88', 'operator', 'developer']), ['developer', 'operator']);
  assert.deepEqual(recipientLogins(['developer']), ['developer'], '/close without an operator can mention only the triggering human author');
});

test('/close mentions the triggering GitLab commenter without deriving an operator from the storage key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scm-close-recipients-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageKey = 'gitlab:worker:project:88';
  const path = statePath(patchpawPaths(root).state, storageKey, 7);
  await saveHumanReply(path, { repo: storageKey, pr_number: 7, comment_id: 701, author: 'developer', author_id: '17',
    body: '@patchpaw /close', url: 'https://git.example/group/repo/-/merge_requests/7#note_701' });
  const connection: ScmConnection = { id: 'worker', kind: 'gitlab', instanceUrl: 'https://git.example', credentialRef: null,
    webhookMode: 'secret', webhookSecretRef: null, botUserId: '900', botLogin: 'patchpaw', projectIds: ['88'], enabled: true,
    createdAt: '', updatedAt: '' };
  const published: string[] = [];
  const adapter = { kind: 'gitlab', connection, botLogin: 'patchpaw',
    workspaceFetchPlan: () => ({ head: { kind: 'origin' } }), readChangeRequest: async () => { throw new Error('not used'); },
    verifyInboundComment: async () => { throw new Error('not used'); }, listComments: async () => [],
    publishComment: async (_project: string, _number: number, body: string) => {
      published.push(body); return { id: published.length, htmlUrl: `https://git.example/note/${published.length}`, publishedAt: new Date().toISOString(), reused: false };
    }, publishReview: async () => { throw new Error('not used'); }, readCI: async () => { throw new Error('not used'); },
    failureEvidence: async () => ({}), installationGitToken: async () => 'unused',
  } as unknown as ScmAdapter;
  const result = await prepareEntryLifecycle({ config: { root, snapshotRoot: join(root, 'snapshots') },
    resolveConnection: async () => ({ adapter, botLogin: 'patchpaw' }), repo: storageKey, prNumber: 7, path,
    appSlug: 'patchpaw', botLogin: 'patchpaw', projectId: '88' });
  assert.equal(result.closeResult?.status, 'closed');
  assert.equal(published.length, 2);
  assert.ok(published.every(body => body.includes('@developer')));
  assert.ok(published.every(body => !body.includes('@gitlab:')));
});

test('legacy run notice, close completion, refusal, and close journal omit GitLab storage keys as mentions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scm-recipients-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageKey = 'gitlab:worker:project:88';
  const runId = 'legacy-gitlab-run';
  const runDir = join(patchpawPaths(root).runs, runId);
  const runTrace = new Trace(runDir);
  runTrace.save('manifest.json', { run_id: runId, repo: storageKey, pr_number: 7 });
  runTrace.save('run-notice.json', { run_id: runId, head: 'head', status: 'needs_human', phase: 'needs_human', reason: 'legacy notice',
    mentions: [storageKey], platform: 'gitlab' });
  runTrace.save('notification.json', { status: 'pending' });

  const closePath = statePath(patchpawPaths(root).state, storageKey, 8);
  await writeState(closePath, { repo: storageKey, pr_number: 8, run_id: '', current_head_sha: '', phase: 'closed', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid, handled_comment_ids: [], closed_through_comment_id: 801,
    completion_notice_status: 'pending', pending_close_refusal: { comment_id: 802 } });
  await mkdir(join(closePath, '..'), { recursive: true });
  await writeFile(`${closePath}.close.json`, JSON.stringify({ status: 'closing', repo: storageKey, pr_number: 8, close_comment_id: 803,
    start_notice_id: null, started_at: new Date().toISOString(), run_ids: [], workspace_paths: [], rejected_workspace_paths: [],
    mentions: [storageKey], last_step: 'preflight', last_error: null }) + '\n');

  await reconcileLegacyOutbox({ root });
  const deliveries = await listOutbound(root);
  assert.equal(deliveries.length, 4);
  assert.ok(deliveries.every(delivery => !delivery.item.payload.mentions.includes(storageKey)));
  assert.deepEqual(deliveries.map(delivery => delivery.item.purpose).sort(), ['close_completion', 'close_refusal', 'close_start', 'run_notice']);
});
