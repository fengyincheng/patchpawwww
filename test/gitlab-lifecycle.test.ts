import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { ensureRepo, fetchPRState, createWorktree, runWorkspacePath, repoCachePath } from '../src/workspace/repo-store.ts';
import { Trace } from '../src/harness/trace.ts';
import { statePath, readState, writeState } from '../src/runner/state.ts';
import { saveHumanReply, hasHumanReplies } from '../src/runner/human-feedback.ts';
import { prMemoryPath } from '../src/harness/pr-memory.ts';
import { snapshotPRDir } from '../src/github/snapshot.ts';
import { runClose } from '../src/runner/close.ts';
import { runGitLabMergeRequest } from '../src/scm/gitlab/runner.ts';
import { deliverImmediately, enqueueCommentDelivery, enqueueReviewDelivery, finalizeDelivery, listOutbound } from '../src/runner/outbound.ts';
import { ReviewStale } from '../src/scm/errors.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import type { ScmAdapter, ScmConnection } from '../src/scm/types.ts';

const connection: ScmConnection = { id: 'self-hosted', kind: 'gitlab', instanceUrl: 'https://git.example/gitlab', credentialRef: null,
  webhookMode: 'secret', webhookSecretRef: null, botUserId: '900', botLogin: 'patchpaw', projectIds: ['88'], enabled: true, createdAt: '', updatedAt: '' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-gitlab-lifecycle-'));
  const remote = join(root, 'remote'); await mkdir(remote);
  await git(remote, ['init', '-b', 'main']);
  await git(remote, ['config', 'user.name', 'Fixture']); await git(remote, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(remote, 'sample.txt'), 'before\n'); await git(remote, ['add', '.']); await git(remote, ['commit', '-m', 'base']);
  const head = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(remote, ['branch', 'feature']);
  const repo = 'gitlab:self-hosted:project:88';
  const trace = new Trace(join(root, 'seed-trace'));
  await ensureRepo(root, repo, remote, trace);
  await fetchPRState(root, repo, { headSha: head, baseRef: 'main' }, trace);
  await createWorktree(root, repo, runWorkspacePath(root, 'seed-run'), head, trace);
  const path = statePath(patchpawPaths(root).state, repo, 3);
  const workspace = runWorkspacePath(root, 'seed-run');
  await mkdir(join(patchpawPaths(root).runs, 'seed-run'), { recursive: true });
  await writeFile(join(patchpawPaths(root).runs, 'seed-run', 'manifest.json'), JSON.stringify({ repo, pr_number: 3 }) + '\n');
  await writeFile(join(patchpawPaths(root).runs, 'seed-run', 'result.json'), JSON.stringify({ status: 'stopped' }) + '\n');
  const memory = prMemoryPath(patchpawPaths(root).memory, repo, 3); await mkdir(dirname(memory), { recursive: true }); await writeFile(memory, 'memory');
  const snapshots = snapshotPRDir(join(root, 'snapshots'), repo, 3); await mkdir(snapshots, { recursive: true }); await writeFile(join(snapshots, 'seed.json'), '{}\n');
  await saveHumanReply(path, { repo, pr_number: 3, comment_id: 90, author: 'developer', body: '@patchpaw /review', url: 'https://git.example/note/90' });
  await saveHumanReply(path, { repo, pr_number: 3, comment_id: 100, author: 'developer', body: '@patchpaw /close', url: 'https://git.example/note/100' });
  await writeState(path, { repo, pr_number: 3, run_id: 'seed-run', current_head_sha: head, phase: 'stopped', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid, handled_comment_ids: [90] });
  const published: string[] = [];
  const adapter = { kind: 'gitlab', connection, botLogin: 'patchpaw', botUserId: '900',
    readChangeRequest: async () => { throw new Error('not used by close'); },
    verifyInboundComment: async () => { throw new Error('not used by close'); },
    listComments: async () => [],
    publishComment: async (_project: string, _number: number, body: string) => {
      published.push(body); return { id: 200 + published.length, htmlUrl: `https://git.example/note/${200 + published.length}`, publishedAt: new Date().toISOString(), reused: false };
    },
    publishReview: async () => { throw new Error('not used by close'); }, readCI: async () => { throw new Error('not used by close'); },
    failureEvidence: async () => ({}), installationGitToken: async () => 'unused',
  } as unknown as ScmAdapter;
  return { root, remote, repo, path, workspace, memory, snapshots, published, adapter, head };
}

test('GitLab /close uses the shared durable cleanup lifecycle and leaves the remote MR alone', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await runClose({ root: f.root, snapshotRoot: join(f.root, 'snapshots') }, f.repo, 3, f.path, {
    comment_id: 100, connection: { adapter: f.adapter, botLogin: 'patchpaw' }, mentions: ['developer'], bot_login: 'patchpaw',
  });
  assert.equal(result.status, 'closed');
  await assert.rejects(stat(f.workspace), { code: 'ENOENT' });
  await assert.rejects(stat(f.memory), { code: 'ENOENT' });
  await assert.rejects(stat(join(patchpawPaths(f.root).runs, 'seed-run')), { code: 'ENOENT' });
  await assert.rejects(stat(f.snapshots), { code: 'ENOENT' });
  await assert.rejects(readdir(`${f.path}.comments`), { code: 'ENOENT' });
  const state = await readState(f.path);
  assert.equal(state?.phase, 'closed'); assert.equal(state?.closed_through_comment_id, 100); assert.ok(state?.closed_at);
  assert.equal(state?.close_comment_id, 100); assert.equal(state?.completion_notice_status, 'published');
  assert.equal(f.published.length, 2);
  assert.match(f.published[0], /开始清理/); assert.match(f.published[1], /本地会话已清除/);
  assert.ok((await stat(repoCachePath(f.root, f.repo))).isDirectory());
});

test('a GitLab close journal resumes mechanically and old redelivered notes stay retired', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.workspace, { recursive: true, force: true }); await rm(f.memory, { force: true });
  await writeFile(`${f.path}.close.json`, JSON.stringify({ status: 'closing', repo: f.repo, pr_number: 3, close_comment_id: 100,
    start_notice_id: 201, started_at: new Date().toISOString(), run_ids: ['seed-run'], workspace_paths: [], rejected_workspace_paths: [],
    mentions: ['developer'], last_step: 'memory', last_error: 'simulated interruption' }) + '\n');
  await writeState(f.path, { repo: f.repo, pr_number: 3, run_id: 'old', current_head_sha: '', phase: 'stopped', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid, handled_comment_ids: [], closed_through_comment_id: 100 });
  const result = await runClose({ root: f.root, snapshotRoot: join(f.root, 'snapshots') }, f.repo, 3, f.path, {
    comment_id: 100, connection: { adapter: f.adapter, botLogin: 'patchpaw' }, mentions: ['developer'], bot_login: 'patchpaw',
  });
  assert.equal(result.status, 'closed');
  assert.equal((await readState(f.path))?.phase, 'closed');
  assert.equal((await readFile(`${f.path}.close.json`, 'utf8')).includes('"status":"completed"'), true);
  assert.equal(await hasHumanReplies(f.path), false);
});

test('GitLab worker routes idle /close through the shared lifecycle without a model turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-gitlab-worker-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = 'gitlab:self-hosted:project:88';
  const path = statePath(patchpawPaths(root).state, repo, 3);
  const memory = prMemoryPath(patchpawPaths(root).memory, repo, 3); await mkdir(dirname(memory), { recursive: true }); await writeFile(memory, 'memory');
  const snapshotDir = snapshotPRDir(join(root, 'snapshots'), repo, 3); await mkdir(snapshotDir, { recursive: true }); await writeFile(join(snapshotDir, 'old.json'), '{}\n');
  await saveHumanReply(path, { repo, pr_number: 3, comment_id: 90, author: 'developer', body: '@patchpaw /review', url: 'https://git.example/gitlab/group/repo/-/merge_requests/3#note_90' });
  await saveHumanReply(path, { repo, pr_number: 3, comment_id: 100, author: 'developer', body: '@patchpaw /close', url: 'https://git.example/gitlab/group/repo/-/merge_requests/3#note_100', author_id: '17', source_event_id: 'hook-100', platform: 'gitlab', connection_id: 'self-hosted', project_id: '88', repository_path: 'group/repo' });
  await writeState(path, { repo, pr_number: 3, run_id: 'old-run', current_head_sha: 'head-3', phase: 'stopped', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid, handled_comment_ids: [90] });
  const calls: Array<{ method: string; path: string }> = [];
  let modelCalls = 0;
  let noteId = 200;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET'; calls.push({ method, path: url.pathname });
    if (url.hostname === 'model.fixture') { modelCalls++; throw new Error('model must not be called for /close'); }
    if (url.pathname === '/gitlab/api/v4/user') return new Response(JSON.stringify({ id: 900, username: 'patchpaw', bot: true, state: 'active' }));
    if (url.pathname === '/gitlab/api/v4/projects/88') return new Response(JSON.stringify({ id: 88, path_with_namespace: 'group/repo', web_url: 'https://git.example/gitlab/group/repo', http_url_to_repo: 'https://git.example/gitlab/group/repo.git' }));
    if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3') return new Response(JSON.stringify({ iid: 3, state: 'opened', source_project_id: 88, target_project_id: 88,
      source: { path_with_namespace: 'group/repo' }, target: { path_with_namespace: 'group/repo' }, source_branch: 'feature', target_branch: 'main', sha: 'head-3',
      diff_refs: { base_sha: 'base-3' }, title: 'Fixture MR', description: 'Body', author: { id: 17, username: 'developer' }, web_url: 'https://git.example/gitlab/group/repo/-/merge_requests/3' }));
    if (url.pathname === '/gitlab/api/v4/projects/88/repository/branches/main') return new Response(JSON.stringify({ commit: { id: 'target-3' } }));
    if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3/notes' && method === 'GET') return new Response(JSON.stringify([]));
    if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3/notes' && method === 'POST') {
      noteId++;
      return new Response(JSON.stringify({ id: noteId, web_url: `https://git.example/gitlab/note/${noteId}`, created_at: new Date().toISOString() }), { status: 201 });
    }
    throw new Error(`Unexpected GitLab fixture endpoint: ${method} ${url.pathname}`);
  });
  const result = await runGitLabMergeRequest({ root, snapshotRoot: join(root, 'snapshots'), operatorLogin: 'operator', gitlabConnections: [{ id: 'self-hosted',
    instanceUrl: 'https://git.example/gitlab', projectIds: ['88'], token: 'token', botUserId: '900', botLogin: 'patchpaw' }] }, repo, 3);
  assert.ok(result);
  assert.equal(result.status, 'closed'); assert.equal(modelCalls, 0);
  assert.equal((await readState(path))?.phase, 'closed'); assert.equal((await readState(path))?.closed_through_comment_id, 100);
  await assert.rejects(stat(memory), { code: 'ENOENT' }); await assert.rejects(stat(snapshotDir), { code: 'ENOENT' });
  await assert.rejects(readdir(`${path}.comments`), { code: 'ENOENT' });
  assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/merge_requests/3/notes')).length, 2);
  assert.equal(calls.some(call => call.path.endsWith('/state_event')), false);
});

test('a stale GitLab review is cancelled and cannot block the next MR delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-gitlab-stale-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = 'gitlab:self-hosted:project:88'; let nextId = 300;
  const adapter = { kind: 'gitlab', connection, botLogin: 'patchpaw', botUserId: '900',
    readChangeRequest: async () => { throw new Error('not used'); }, verifyInboundComment: async () => { throw new Error('not used'); }, listComments: async () => [],
    publishComment: async (_project: string, _number: number, _body: string) => ({ id: ++nextId, htmlUrl: `https://git.example/gitlab/note/${nextId}`, publishedAt: new Date().toISOString(), reused: false }),
    publishReview: async () => { throw new ReviewStale('head-a', 'head-b', 'opened'); }, readCI: async () => { throw new Error('not used'); }, failureEvidence: async () => ({}),
  } as unknown as ScmAdapter;
  const review = { summary: 'summary', recommendation: 'approve', findings: [], limitations: [] } as any;
  const stale = await enqueueReviewDelivery({ root, repo, prNumber: 3, semanticKey: 'review:stale', headSha: 'head-a', review, mentions: [], runId: 'review-run', source: { project_id: '88', run_id: 'review-run', head_sha: 'head-a' } });
  await assert.rejects(deliverImmediately(root, stale, { adapter, botLogin: 'patchpaw' }), ReviewStale);
  assert.equal((await listOutbound(root, { repo, prNumber: 3 })).find(item => item.item.delivery_id === stale.item.delivery_id)?.item.status, 'cancelled_stale');
  await finalizeDelivery(root, stale);
  const comment = await enqueueCommentDelivery({ root, repo, prNumber: 3, purpose: 'conversation_reply', semanticKey: 'comment:next', body: '继续处理', mentions: [], botLogin: 'patchpaw' });
  const delivered = await deliverImmediately(root, comment, { adapter, botLogin: 'patchpaw' });
  assert.equal(delivered.item.status, 'delivered');
});
