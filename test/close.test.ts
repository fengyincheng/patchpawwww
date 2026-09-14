import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { git } from '../src/workspace/git.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { statePath, readState, writeState } from '../src/runner/state.ts';
import { readPaused, savePaused } from '../src/runner/resume.ts';
import { prMemoryPath } from '../src/harness/pr-memory.ts';
import { snapshotPRDir } from '../src/github/snapshot.ts';
import { ensureRepo, fetchPRState, createWorktree, removeWorktree, disposeWorkspacePath, repoCachePath, runWorkspacePath } from '../src/workspace/repo-store.ts';
import { Trace } from '../src/harness/trace.ts';
import { fixture, type Fixture } from './helpers/pr-fixture.ts';
import { listOutbound } from '../src/runner/outbound.ts';
import { startOutboundScheduler } from '../src/runner/outbound-scheduler.ts';
import { persistInboundComment, verifyInboundNow } from '../src/runner/inbound-verification.ts';
import { closeCommunicationStore, communicationDbPath, openCommunicationStore } from '../src/runner/communication-store.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await condition()) return; await sleep(25); }
  throw new Error('waitFor timed out');
}

// Seed one PR's complete PatchPaw-local generation with real on-disk artifacts: shared-repo
// worktree (optionally a stopped pause pointer), memory database, owned run directory,
// snapshots, comment inbox and prior state — everything /close must retire, and nothing more.
async function seedPR(f: Fixture, pr: number, opts: { paused?: boolean; memory?: boolean } = {}) {
  const trace = new Trace(join(f.root, 'seed-trace'));
  const head = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  await ensureRepo(f.root, 'owner/lab', f.remote, trace);
  await fetchPRState(f.root, 'owner/lab', { headSha: head, baseRef: 'main' }, trace);
  const runId = `seed-run-${pr}`;
  const wsPath = runWorkspacePath(f.root, runId);
  await createWorktree(f.root, 'owner/lab', wsPath, head, trace);
  await writeFile(join(wsPath, 'notes.txt'), 'local evidence\n');
  const dir = join(f.root, 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ run_id: runId, repo: 'owner/lab', pr_number: pr }) + '\n');
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'stopped', run_id: runId }) + '\n');
  const memory = prMemoryPath(join(f.root, 'data/memory'), 'owner/lab', pr);
  if (opts.memory !== false) {
    // A stand-in file is fine whenever the test only deletes it; a test that runs a real Agent
    // session must let the session create the genuine SQLite database itself.
    await mkdir(dirname(memory), { recursive: true });
    await writeFile(memory, 'fixture memory bytes\n');
  }
  const snapshots = snapshotPRDir(f.config.snapshotRoot, 'owner/lab', pr);
  await mkdir(snapshots, { recursive: true });
  await writeFile(join(snapshots, 'api-seed.json'), '{}\n');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', pr);
  await saveHumanReply(path, { repo: 'owner/lab', pr_number: pr, installation_id: 42, comment_id: 90 + pr,
    author: 'owner', body: '@patchpawwww 旧对话', url: `https://github.com/owner/lab/pull/${pr}#issuecomment-${90 + pr}` });
  await writeState(path, { repo: 'owner/lab', pr_number: pr, run_id: runId, current_head_sha: head, phase: 'stopped',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid,
    handled_comment_ids: [90 + pr], execution_id: 1 });
  if (opts.paused) await savePaused(path, { status: 'stopped', pause_reason: 'human_stop', task: 'conflict', run_id: runId,
    execution_id: 1, base_sha: f.base, base_ref: 'main', local_head: head, remote_head: head,
    workspace: { path: wsPath, initialHead: head, mainSha: f.base, unmerged: [], mergePending: false } });
  return { path, runId, wsPath, memory, snapshots, head };
}

test('/close retires one PR generation and preserves the shared repo, other PRs and the GitHub PR', async t => {
  const f = await fixture(t, false);
  const target = await seedPR(f, 7, { paused: true });
  const other = await seedPR(f, 8, { paused: true });
  const targetWorktreePath = await realpath(target.wsPath);
  const otherWorktreePath = await realpath(other.wsPath);
  await mkdir(`${target.path}.conflict-proposals`, { recursive: true });
  await writeFile(join(`${target.path}.conflict-proposals`, 'conflict-proposal-v1.json'), '{"evidence":"retained"}\n');
  await mkdir(join(f.root, 'runs', 'no-manifest-run'), { recursive: true });
  await writeFile(join(f.root, 'runs', 'no-manifest-run', 'trace.jsonl'), '{}\n');
  await f.mention('@patchpawwww /close', 100);
  const models = f.modelInputs.length;
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  // The target PR's local generation is gone: paused worktree unregistered, pointer/memory/
  // owned runs/snapshots/inbox deleted, replaced by the tiny closed tombstone.
  await assert.rejects(stat(target.wsPath), { code: 'ENOENT' });
  assert.equal(await readPaused(target.path), null);
  await assert.rejects(stat(target.memory), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.root, 'runs', target.runId)), { code: 'ENOENT' });
  await assert.rejects(stat(target.snapshots), { code: 'ENOENT' });
  await assert.rejects(stat(`${target.path}.conflict-proposals`), { code: 'ENOENT' });
  await assert.rejects(readdir(`${target.path}.comments`), { code: 'ENOENT' });
  const tombstone = await readState(target.path);
  assert.equal(tombstone?.phase, 'closed');
  assert.equal(tombstone?.active, false);
  assert.equal(tombstone?.closed_through_comment_id, 100);
  assert.equal(tombstone?.completion_notice_status, 'published');
  assert.ok(tombstone?.close_start_notice_id);
  assert.equal(JSON.parse(await readFile(`${target.path}.close.json`, 'utf8')).status, 'completed');
  // Run directories without exact manifest ownership are never guessed away.
  assert.ok((await stat(join(f.root, 'runs', 'no-manifest-run'))).isDirectory());
  assert.ok((await stat(join(f.root, 'runs', other.runId))).isDirectory());
  // The other PR is completely untouched, including its paused worktree registration.
  assert.ok((await stat(other.memory)).isFile());
  assert.ok((await stat(other.wsPath)).isDirectory());
  assert.ok((await stat(other.snapshots)).isDirectory());
  assert.equal((await readPaused(other.path))?.status, 'stopped');
  assert.equal((await readState(other.path))?.handled_comment_ids?.[0], 98);
  // One shared repo remains, losing only the target's worktree, and stays usable.
  assert.deepEqual((await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git')),
    [`${encodeURIComponent('owner/lab')}.git`]);
  const registered = (await git(repoCachePath(f.root, 'owner/lab'), ['worktree', 'list', '--porcelain'])).stdout;
  console.error('WORKTREE_PATH_DEBUG', JSON.stringify({ registered, target: targetWorktreePath, other: otherWorktreePath }));
  const normalizedRegistered = registered.replaceAll('\\', '/').toLowerCase();
  assert.ok(!normalizedRegistered.includes(targetWorktreePath.replaceAll('\\', '/').toLowerCase()));
  assert.ok(normalizedRegistered.includes(otherWorktreePath.replaceAll('\\', '/').toLowerCase()));
  assert.deepEqual((await readdir(join(f.root, 'workspaces'))).sort(), [other.runId]);
  const trace = new Trace(join(f.root, 'seed-trace'));
  await createWorktree(f.root, 'owner/lab', runWorkspacePath(f.root, 'post-close'), target.head, trace);
  assert.equal((await git(runWorkspacePath(f.root, 'post-close'), ['rev-parse', 'HEAD'])).stdout.trim(), target.head);
  await removeWorktree(f.root, 'owner/lab', runWorkspacePath(f.root, 'post-close'), trace);
  // Deterministic two-comment mechanical sequence, requester mentioned, zero model requests,
  // and never any GitHub PR state change.
  const comments = f.calls.filter(c => c.body && c.path.endsWith('/issues/7/comments'));
  assert.equal(comments.length, 2);
  assert.match(comments[0].body.body, /## PatchPaw：开始清理本 PR 的本地会话/);
  assert.match(comments[1].body.body, /## PatchPaw：本地会话已清除/);
  assert.match(comments[0].body.body, /@owner/);
  assert.equal(f.modelInputs.length, models, '/close performs zero Agent requests');
  assert.ok(!f.calls.some(c => c.body && c.path.endsWith('/pulls/7')), 'the GitHub PR itself is never closed or updated');
  // A second /close on the already-closed generation is harmless.
  await f.mention('@patchpawwww /close', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  assert.equal((await readState(target.path))?.closed_through_comment_id, 101);
  assert.ok((await stat(other.memory)).isFile());
  assert.deepEqual((await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git')),
    [`${encodeURIComponent('owner/lab')}.git`]);
});

test('an active task refuses /close mechanically without deleting anything', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  await f.mention('@patchpawwww 请介绍当前状态', 110);
  let injected = false;
  f.control.holdModel = async () => {
    if (injected) return;
    injected = true;
    await f.mention('@patchpawwww /close', 111);
    await waitFor(() => f.calls.some(c => c.path.endsWith('/issues/7/comments') && c.body?.body?.includes('请先 /stop')));
  };
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'conversation_completed');
  const refusals = f.calls.filter(c => c.body?.body?.includes('当前任务仍在运行，请先 /stop，再执行 /close。'));
  assert.equal(refusals.length, 1, 'exactly one deterministic refusal, published immediately');
  assert.match(refusals[0].body.body, /@owner/);
  const state = await readState(seeded.path);
  assert.ok(state?.handled_comment_ids?.includes(111), 'the refused /close is retired, never executed later');
  assert.equal(state?.phase, 'conversation_completed');
  // Nothing was destroyed underneath the active task.
  assert.ok((await stat(seeded.memory)).isFile());
  assert.equal((await readPaused(seeded.path))?.status, 'stopped');
  assert.ok((await stat(seeded.wsPath)).isDirectory());
  await assert.rejects(stat(`${seeded.path}.close.json`), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(f.modelInputs).includes('@patchpawwww /close'), 'no model ever decides the refusal');
});

test('retired commands never replay and the next mention starts a fresh generation', async t => {
  const f = await fixture(t, false);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  const memory = prMemoryPath(join(f.root, 'data/memory'), 'owner/lab', 7);
  await f.mention('@patchpawwww 第一代对话', 100);
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(first.status, 'conversation_completed');
  assert.ok((await stat(memory)).isFile());
  await f.mention('@patchpawwww /close', 101);
  const closeResult = await runPullRequest(f.config, 'owner/lab', 7);
  if (closeResult.status !== 'closed') console.error('CLOSE_FAILURE_DEBUG', JSON.stringify({ closeResult, state: await readFile(path, 'utf8').catch(() => null), journal: await readFile(`${path}.close.json`, 'utf8').catch(() => null) }));
  assert.equal(closeResult.status, 'closed');
  await assert.rejects(stat(memory), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.root, 'runs', first.run_id!)), { code: 'ENOENT' });
  // Webhook redelivery of retired comments cannot resurrect them after the inbox was cleaned.
  await f.mention('@patchpawwww 第一代对话', 100);
  await f.mention('@patchpawwww /close', 101);
  const models = f.modelInputs.length;
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'mention_required');
  assert.equal(f.modelInputs.length, models, 'redelivered retired comments never execute');
  // A newer comment starts the next fresh local generation.
  await f.mention('@patchpawwww 第二代对话', 102);
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'conversation_completed');
  const fresh = JSON.stringify(f.modelInputs.slice(models));
  assert.ok(fresh.includes('第二代对话'));
  assert.ok(!fresh.includes('第一代对话'), 'retired comments are not loaded into the new generation');
  assert.ok(!fresh.includes('可以正常沟通'), "the old generation's agent memory is gone");
  assert.equal((await readState(path))?.closed_through_comment_id, 101, 'the high-water mark survives into the new generation');
  assert.ok((await stat(memory)).isFile(), 'the memory database is recreated empty');
  // Closing the second generation repeats the visible sequence and stays harmless.
  const posted = f.calls.filter(c => c.body && c.path.endsWith('/issues/7/comments')).length;
  await f.mention('@patchpawwww /close', 103);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  const closed = await readState(path);
  assert.equal(closed?.phase, 'closed');
  assert.equal(closed?.closed_through_comment_id, 103);
  await assert.rejects(stat(memory), { code: 'ENOENT' });
  const comments = f.calls.filter(c => c.body && c.path.endsWith('/issues/7/comments')).slice(posted);
  assert.equal(comments.length, 2);
  assert.match(comments[0].body.body, /开始清理/);
  assert.match(comments[1].body.body, /已清除/);
  assert.deepEqual((await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git')),
    [`${encodeURIComponent('owner/lab')}.git`], 'the shared repo survives every generation');
});

test('a failed start notice aborts /close before any destructive step', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true });
  f.control.commentStatus = 403;
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'close_start_unpublished');
  // Zero destructive deletions: the human has no external audit marker yet.
  assert.ok((await stat(seeded.wsPath)).isDirectory());
  assert.ok((await stat(seeded.memory)).isFile());
  assert.ok((await stat(join(f.root, 'runs', seeded.runId))).isDirectory());
  assert.ok((await stat(seeded.snapshots)).isDirectory());
  assert.ok((await readdir(`${seeded.path}.comments`)).length > 0);
  assert.equal((await readPaused(seeded.path))?.status, 'stopped');
  assert.equal((await readState(seeded.path))?.phase, 'stopped', 'no tombstone before cleanup');
  const journal = JSON.parse(await readFile(`${seeded.path}.close.json`, 'utf8'));
  assert.equal(journal.status, 'closing');
  assert.equal(journal.last_step, 'start_notice');
  assert.ok(journal.last_error);
  assert.equal(f.publishedComments.length, 0);
  // Once publication works again, the next /close continues from the journal to completion.
  f.control.commentStatus = 201;
  await f.mention('@patchpawwww /close', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  assert.equal((await readState(seeded.path))?.phase, 'closed');
  assert.equal((await readState(seeded.path))?.closed_through_comment_id, 101);
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' });
  assert.equal(f.publishedComments.length, 2, 'start and completion each published exactly once');
  assert.match(f.publishedComments[0].body, /开始清理/);
  assert.match(f.publishedComments[1].body, /已清除/);
});

test('/close persists its start notice before transient connection acquisition and scheduler resumes it', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true });
  f.control.installationFailures = 1;
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'close_start_unpublished');
  assert.equal(f.publishedComments.length, 0);
  assert.ok((await stat(seeded.wsPath)).isDirectory(), 'connection failure must happen before deletion');
  const start = (await listOutbound(f.root)).find(value => value.item.purpose === 'close_start')!;
  assert.equal(start.item.status, 'pending_retry');
  const communication = await openCommunicationStore(f.root);
  try { await communication.execute(`UPDATE outbound_delivery SET next_attempt_at = :now, updated_at = :now WHERE delivery_id = :delivery_id`,
    { now: new Date().toISOString(), delivery_id: start.item.delivery_id }); }
  finally { await closeCommunicationStore(communication); }
  const scheduler = startOutboundScheduler({ ...f.config }, 5);
  await scheduler.ready;
  await waitFor(async () => (await readState(seeded.path))?.completion_notice_status === 'published');
  scheduler.stop();
  assert.equal(f.modelInputs.length, 0);
  assert.equal(f.publishedComments.filter(comment => comment.body.includes('开始清理')).length, 1);
  assert.equal(f.publishedComments.filter(comment => comment.body.includes('已清除')).length, 1,
    JSON.stringify(f.publishedComments.map(comment => comment.body)));
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' });
});

test('a mid-cleanup failure keeps journal progress and never restores deleted resources', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  // Make the memory step fail deterministically: its database path is occupied by a directory.
  await mkdir(seeded.memory, { recursive: true });
  await writeFile(join(seeded.memory, 'stray.db'), 'x\n');
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'close_incomplete');
  assert.equal((result as { step?: string }).step, 'memory');
  // Steps before the failure are done and stay done — nothing is restored.
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' });
  assert.equal(await readPaused(seeded.path), null);
  // Steps after the failure did not run; state is not a tombstone.
  assert.ok((await stat(join(f.root, 'runs', seeded.runId))).isDirectory());
  assert.ok((await stat(seeded.snapshots)).isDirectory());
  assert.equal((await readState(seeded.path))?.phase, 'stopped');
  const journal = JSON.parse(await readFile(`${seeded.path}.close.json`, 'utf8'));
  assert.equal(journal.status, 'closing');
  assert.equal(journal.last_step, 'memory');
  assert.ok(journal.last_error);
  assert.equal(f.publishedComments.length, 2, 'start notice plus deterministic failure notice');
  assert.match(f.publishedComments[1].body, /本地清理尚未完成/);
  assert.match(f.publishedComments[1].body, /`memory`/);
  // After the obstacle is cleared, the next /close continues WITHOUT repeating the start notice.
  await rm(seeded.memory, { recursive: true, force: true });
  await f.mention('@patchpawwww /close', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  await assert.rejects(stat(join(f.root, 'runs', seeded.runId)), { code: 'ENOENT' });
  await assert.rejects(stat(seeded.snapshots), { code: 'ENOENT' });
  assert.equal((await readState(seeded.path))?.phase, 'closed');
  assert.equal(f.publishedComments.filter(c => c.body.includes('开始清理')).length, 1,
    'the start notice is never published twice across a resumed close');
  assert.match(f.publishedComments.at(-1)!.body, /已清除/);
});

test('a failed completion notice stays closed and the next entry retries only the completion', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  // start 201 → completion 403 → first retry 403 → conversation reply 201 → second retry 201
  f.control.commentStatusSequence = [201, 403, 403, 201, 201];
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'closed', 'local cleanup success is never rolled back');
  const tombstone = await readState(seeded.path);
  assert.equal(tombstone?.phase, 'closed');
  assert.equal(tombstone?.completion_notice_status, 'pending');
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' });
  // The next ordinary mention retries the missing completion notice first; while publication
  // still fails, the pending marker must survive the new generation's state overwrite.
  await f.mention('@patchpawwww 第二代对话', 102);
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'conversation_completed');
  const carried = await readState(seeded.path);
  assert.equal(carried?.completion_notice_status, 'pending', 'pending is never lost to a state overwrite');
  assert.equal(carried?.closed_through_comment_id, 100);
  assert.equal(carried?.phase, 'conversation_completed', 'the new generation proceeds normally');
  // Once publication works, the following entry retries again and flips the durable marker,
  // without ever re-publishing the start notice or restoring deleted data.
  await f.mention('@patchpawwww 第三代对话', 103);
  const third = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(third.status, 'conversation_completed');
  const done = await readState(seeded.path);
  assert.equal(done?.completion_notice_status, 'published');
  assert.ok(done?.completion_notice_id);
  assert.equal(f.publishedComments.filter(c => c.body.includes('开始清理')).length, 1,
    'the start notice is never repeated by a completion retry');
  assert.equal(f.publishedComments.filter(c => c.body.includes('已清除')).length, 1,
    'exactly one completion notice actually reaches GitHub');
});

test('a corrupt paused worktree must really disappear before close claims completion', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  // Corrupt the linked worktree's gitdir pointer: disposal must still converge, and close must
  // never claim completion while the controlled directory survives.
  if (process.platform === 'win32') {
    await chmod(join(seeded.wsPath, '.git'), 0o600);
    await execFileAsync('attrib', ['-R', join(seeded.wsPath, '.git')], { windowsHide: true });
    await rm(join(seeded.wsPath, '.git'), { force: true });
  }
  await writeFile(join(seeded.wsPath, '.git'), 'corrupt gitdir pointer');
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'closed');
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' }, 'a corrupt worktree is converged, never claimed away while present');
  const registered = (await git(repoCachePath(f.root, 'owner/lab'), ['worktree', 'list', '--porcelain'])).stdout;
  assert.ok(!registered.replaceAll('\\', '/').toLowerCase().includes(seeded.wsPath.replaceAll('\\', '/').toLowerCase()), 'its worktree metadata is pruned');
  assert.equal((await readState(seeded.path))?.phase, 'closed');
  assert.equal((await readState(seeded.path))?.completion_notice_status, 'published');
});

test('a crashed close is finished by the next entry before any normal task', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true });
  // Simulate the crash window: destructive steps and the inbox deletion already happened,
  // the tombstone was never written, and the journal durably says `closing`.
  await disposeWorkspacePath(f.root, 'owner/lab', seeded.wsPath);
  await rm(`${seeded.path}.paused.json`, { force: true });
  await rm(seeded.memory, { force: true });
  await rm(join(f.root, 'runs', seeded.runId), { recursive: true, force: true });
  await rm(seeded.snapshots, { recursive: true, force: true });
  await rm(`${seeded.path}.comments`, { recursive: true, force: true });
  await writeFile(`${seeded.path}.close.json`, JSON.stringify({ status: 'closing', repo: 'owner/lab', pr_number: 7,
    close_comment_id: 100, start_notice_id: 577, started_at: new Date().toISOString(), run_ids: [seeded.runId],
    workspace_paths: [seeded.wsPath], mentions: ['owner', 'operator'], last_step: 'inbox', last_error: null }) + '\n');
  // The original /close comment is gone with the inbox; the only new activity is a plain mention.
  // The durable journal must win: the close finishes mechanically before any normal run.
  await f.mention('@patchpawwww 请继续处理', 105);
  const models = f.modelInputs.length;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'closed', 'the pending close completes before any normal task');
  assert.equal(f.modelInputs.length, models, 'zero model requests');
  assert.deepEqual(await readdir(join(f.root, 'workspaces')), [], 'no new workspace is created');
  const state = await readState(seeded.path);
  assert.equal(state?.phase, 'closed');
  assert.ok((state?.closed_through_comment_id ?? 0) >= 105, 'the post-crash mention is retired by the finishing close');
  // The start notice is never repeated (its id survived in the journal); completion publishes now.
  assert.equal(f.publishedComments.filter(c => c.body.includes('开始清理')).length, 0);
  assert.equal(f.publishedComments.filter(c => c.body.includes('已清除')).length, 1);
  assert.equal(JSON.parse(await readFile(`${seeded.path}.close.json`, 'utf8')).status, 'completed');
  // The retired mention never runs later either.
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'mention_required');
});

test('/close high-water retires an inbound row already durable in SQLite', async t => {
  const f = await fixture(t, false);
  const inbound = await persistInboundComment(f.root, 'durable-before-close', {
    repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 120, author: 'owner',
    body: '@patchpawwww /CI', url: 'https://github.test/owner/lab/pull/7#issuecomment-120' });
  await f.mention('@patchpawwww /close', 100);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  const tombstone = await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7));
  assert.equal(tombstone?.closed_through_comment_id, 120);
  assert.ok((await stat(communicationDbPath(f.root))).isFile(), '/close leaves communication.db intact');

  const result = await verifyInboundNow(f.root, inbound, {
    async readPullRequest(_installation, repo, number) {
      return { repository: { id: 10, full_name: repo, private: true },
        pullRequest: { number, base: { sha: 'base', repo: { id: 10 } }, head: { sha: 'head' } } };
    },
  }, async () => { throw new Error('retired inbound must never dispatch'); });
  assert.equal(result, 'retired');
  const communication = await openCommunicationStore(f.root);
  try { assert.equal((await communication.getInbound('owner/lab', 7, 120))?.record.status, 'retired'); }
  finally { await closeCommunicationStore(communication); }
});

test('a refused /close stays retired forever even when the refusal notice cannot be published', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  await f.mention('@patchpawwww 请介绍当前状态', 110);
  let injected = false;
  f.control.holdModel = async () => {
    if (injected) return;
    injected = true;
    // Arm the failure BEFORE the comment exists, and release only on the COMPLETED 403 outcome:
    // waiting on request arrival would race the mock's internal await and could let the refusal
    // publish succeed, silently clearing the outbox under test.
    f.control.commentStatus = 403; // the refusal notice keeps failing while the task is active
    await f.mention('@patchpawwww /close', 111);
    await waitFor(() => f.commentOutcomes.includes(403));
    f.control.commentStatus = 201; // the conversation reply itself publishes normally
  };
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'conversation_completed');
  const retired = await readState(seeded.path);
  assert.ok(retired?.handled_comment_ids?.includes(111), 'the active-time /close is retired despite the failed notice');
  assert.deepEqual(retired?.pending_close_refusal, { comment_id: 111, author: 'owner' },
    'the missing refusal notice waits in a durable outbox');
  // Nothing was closed underneath the active task.
  assert.ok((await stat(seeded.wsPath)).isDirectory());
  assert.equal((await readPaused(seeded.path))?.status, 'stopped');
  await assert.rejects(stat(`${seeded.path}.close.json`), { code: 'ENOENT' });
  // A later dispatch must never execute the retired /close.
  const models = f.modelInputs.length;
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'mention_required');
  assert.equal(f.modelInputs.length, models);
  assert.ok((await stat(seeded.wsPath)).isDirectory(), 'the retired /close never becomes destructive');
  // The next ordinary entry delivers the pending refusal notice and clears the outbox.
  await f.mention('@patchpawwww 谢谢，先讨论一下', 112);
  const next = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(next.status, 'conversation_completed');
  assert.equal(f.publishedComments.filter(c => c.body.includes('请先 /stop')).length, 1,
    'the deterministic refusal notice is delivered exactly once, later');
  const after = await readState(seeded.path);
  assert.equal(after?.pending_close_refusal, undefined);
  assert.ok(after?.handled_comment_ids?.includes(111), 'retirement survives into the next generation');
  assert.ok((await stat(seeded.wsPath)).isDirectory());
  assert.ok((await stat(seeded.memory)).isFile(), 'memory was never closed');
});

test('a poisoned paused pointer can never turn /close against the shared repository', async t => {
  const f = await fixture(t, false);
  const seeded = await seedPR(f, 7, { paused: true, memory: false });
  const cache = repoCachePath(f.root, 'owner/lab');
  // Corrupt the paused pointer so its workspace aims at the shared bare repository itself.
  const paused = (await readPaused(seeded.path))!;
  await savePaused(seeded.path, { ...paused, workspace: { ...paused.workspace, path: cache } });
  await f.mention('@patchpawwww /close', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'closed');
  // The shared repository is completely intact and still usable.
  assert.ok((await stat(cache)).isDirectory());
  assert.equal((await git(cache, ['rev-parse', '--is-bare-repository'])).stdout.trim(), 'true');
  await fetchPRState(f.root, 'owner/lab', { headSha: seeded.head, baseRef: 'main' }, new Trace(join(f.root, 'seed-trace')));
  const probe = runWorkspacePath(f.root, 'probe-after-close');
  await createWorktree(f.root, 'owner/lab', probe, seeded.head, new Trace(join(f.root, 'seed-trace')));
  assert.equal((await git(probe, ['rev-parse', 'HEAD'])).stdout.trim(), seeded.head);
  await removeWorktree(f.root, 'owner/lab', probe, new Trace(join(f.root, 'seed-trace')));
  // The close never claims the poisoned target was cleaned: it is durably recorded as rejected,
  // while the genuinely owned run workspace was still disposed.
  const journal = JSON.parse(await readFile(`${seeded.path}.close.json`, 'utf8'));
  assert.deepEqual(journal.rejected_workspace_paths, [cache]);
  assert.ok(!journal.workspace_paths.includes(cache));
  await assert.rejects(stat(seeded.wsPath), { code: 'ENOENT' });
  assert.equal((await readState(seeded.path))?.phase, 'closed');
});
