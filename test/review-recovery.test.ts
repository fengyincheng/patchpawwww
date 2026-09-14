import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { publishReview } from '../src/github/review-publisher.ts';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverRun } from '../src/runner/recovery.ts';
import { statePath, writeState, readState, workerStatus, type RunState } from '../src/runner/state.ts';
import { Trace } from '../src/harness/trace.ts';
import { completeReview } from '../src/runner/review-lifecycle.ts';
import { publishSavedCloseout } from '../src/runner/closeout-publication.ts';

const sha = 'a'.repeat(40), runId = 'fixture-run';
const review = { summary: 'Summary', recommendation: 'comment' as const, findings: [], limitations: [] };
const identity = { runId, botLogin: 'example[bot]' };
function githubFixture() {
  const state = { head: sha, open: true, creates: 0, reads: 0, reviews: [] as any[] };
  const client = new Octokit({ request: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    let data: unknown;
    if (init?.method === 'POST') {
      state.creates++;
      const body = JSON.parse(String(init.body));
      data = { id: state.creates, html_url: 'https://github.com/example/repo/pull/7#review-1',
        commit_id: body.commit_id, body: body.body, user: { login: identity.botLogin, type: 'Bot' },
        submitted_at: '2026-09-06T14:00:00Z', state: 'COMMENTED' };
      state.reviews.push(data);
    } else {
      state.reads++;
      data = path.endsWith('/reviews') ? state.reviews : { state: state.open ? 'open' : 'closed', head: { sha: state.head }, user: { login: 'author' } };
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  } } });
  return { state, client };
}

test('publication retries adopt the same bot/run/head review after a lost local acknowledgement', async () => {
  const { state, client } = githubFixture();
  const first = await publishReview(client, 'example/repo', 7, sha, review, [], identity);
  const second = await publishReview(client, 'example/repo', 7, sha, review, [], identity);
  assert.equal(second.id, first.id);
  assert.equal(state.creates, 1);
  assert.match(state.reviews[0].body, /<!-- patchpaw:run=fixture-run:head=/);
});

test('recovery republishes a model truncation notice without treating it as a closeout-only status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-truncation-notice-'));
  const trace = new Trace(join(root, 'runs', 'truncated-run'));
  trace.save('run-notice.json', { run_id: 'truncated-run', head: sha, status: 'model_output_truncated', phase: 'review_running',
    reason: '模型连接正常，但输出上限已耗尽。', mentions: ['author'], bot_login: identity.botLogin });
  const { client, state } = githubFixture();
  const publication = await publishSavedCloseout(trace, client, 'example/repo', 7, root);
  assert.equal(publication.status, 'published');
  assert.equal(state.creates, 1);
});

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-recovery-'));
  const path = statePath(join(root, 'data/state'), 'example/repo', 7);
  const trace = new Trace(join(root, 'runs', runId));
  const state: RunState = { repo: 'example/repo', pr_number: 7, run_id: runId, current_head_sha: sha,
    phase: 'review', active: true, pid: 2147483647, waiting_for_ci: false, repair_attempts: 0, last_patchpaw_commit: null };
  await writeState(path, state);
  await writeFile(`${path}.lock`, String(state.pid));
  trace.save('manifest.json', { repo: state.repo, pr_number: 7, run_id: runId });
  trace.save('review.json', { ...review, head_sha: sha });
  const github = githubFixture();
  const config = { root, appId: 1, privateKey: '' };
  const connection = async () => ({ client: github.client, botLogin: identity.botLogin, mentions: [] });
  const recover = () => recoverRun(config, state.repo, 7, runId, connection);
  const artifact = async (name: string) => JSON.parse(await readFile(join(trace.dir, name), 'utf8'));
  return { ...github, originalState: state, root, path, trace, config, connection, recover, artifact };
}

test('dead worker + durable review recovers, finalizes and releases stale lock without model dependencies', async () => {
  const f = await recoveryFixture();
  assert.equal(workerStatus(f.originalState), 'interrupted');
  assert.equal((await f.recover()).status, 'review_completed');
  assert.equal(f.state.creates, 1);
  assert.equal((await f.artifact('recovery.json')).model_requests, 0);
  assert.equal((await f.artifact('review-publication.json')).recovered, true);
  const state = await readState(f.path);
  assert.equal(state?.active, false); assert.equal(state?.phase, 'review_completed');
  assert.equal(state?.waiting_for_ci, false);
  await assert.rejects(access(`${f.path}.lock`), { code: 'ENOENT' });
  const reads = f.state.reads;
  assert.equal((await f.recover()).status, 'already_completed');
  assert.equal(f.state.reads, reads); assert.equal(f.state.creates, 1);
});

test('remote success without publication artifact is adopted on recovery', async () => {
  const f = await recoveryFixture();
  await publishReview(f.client, 'example/repo', 7, sha, review, [], identity);
  assert.equal((await f.recover()).status, 'review_completed');
  assert.equal(f.state.creates, 1);
  assert.equal((await f.artifact('review-publication.json')).reused, true);
});

test('legacy unmarked review is matched by bot/head/content, not blindly duplicated', async () => {
  const f = await recoveryFixture();
  await publishReview(f.client, 'example/repo', 7, sha, review, ['old-recipient'], identity);
  f.state.reviews[0].body = f.state.reviews[0].body.replace(/\n\n<!-- patchpaw:.* -->$/, '');
  assert.equal((await f.recover()).status, 'review_completed');
  assert.equal(f.state.creates, 1);
});

test('ambiguous legacy review stops; foreign bot identity never counts as our publication', async () => {
  const f = await recoveryFixture();
  await publishReview(f.client, 'example/repo', 7, sha, review, [], identity);
  f.state.reviews[0].body = f.state.reviews[0].body.replace(/\n\n<!-- patchpaw:.* -->$/, '').replace('Summary', 'Different content');
  await assert.rejects(f.recover(), /Ambiguous legacy/);
  assert.equal(f.state.creates, 1); assert.equal((await readState(f.path))?.active, false);
  f.state.reviews[0].user.login = 'unrelated[bot]';
  assert.equal((await f.recover()).status, 'review_completed');
  assert.equal(f.state.creates, 2);
});

test('changed head or closed PR yields durable review_stale and never publishes', async () => {
  for (const change of [{ head: 'b'.repeat(40) }, { open: false }]) {
    const f = await recoveryFixture(); Object.assign(f.state, change);
    assert.equal((await f.recover()).status, 'review_stale');
    assert.equal(f.state.creates, 0);
    assert.equal((await f.artifact('review-stale.json')).expected_head, sha);
    assert.equal((await readState(f.path))?.active, false);
  }
});

test('saved publication without result finalizes offline even if the PR later moved', async () => {
  const f = await recoveryFixture();
  f.trace.save('review-publication.json', { id: 9, html_url: 'https://github.com/example/repo/pull/7#review-9',
    commit_id: sha, published_at: '2026-09-06T14:00:00Z', run_id: runId, kind: 'review', recovered: false, reused: false });
  const result = await recoverRun(f.config, 'example/repo', 7, runId, async () => { throw new Error('No GitHub access allowed'); });
  assert.equal(result.status, 'review_completed');
  assert.equal(f.state.creates, 0);
});

test('live worker is never displaced even when lock is absent', async () => {
  const f = await recoveryFixture();
  await writeState(f.path, { ...f.originalState, pid: process.pid });
  assert.equal((await f.recover()).status, 'already_running');
  assert.equal(f.state.creates, 0);
  assert.equal(await readFile(`${f.path}.lock`, 'utf8'), String(f.originalState.pid));
});

test('invalid artifact stops before GitHub; no durable model output reports missing without rerunning', async () => {
  const f = await recoveryFixture();
  f.trace.save('review.json', { head_sha: sha });
  await assert.rejects(f.recover()); assert.equal(f.state.reads, 0);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(f.trace.dir, 'review.json'));
  assert.equal((await f.recover()).status, 'review_output_missing');
  assert.equal(f.state.reads, 0);
});

test('normal publication and recovery share the same durable finalizer', async () => {
  const f = await recoveryFixture();
  const result = await completeReview({ trace: f.trace, state: f.originalState, path: f.path, runtimeHome: f.root,
    recovered: false, connection: f.connection });
  assert.equal(result.status, 'review_completed');
  assert.equal((await f.artifact('review-publication.json')).recovered, false);
  assert.equal((await f.recover()).status, 'already_completed');
  assert.equal(f.state.creates, 1);
});

test('interruption after publication persistence recovers offline and never creates another review', async () => {
  const f = await recoveryFixture();
  const save = f.trace.save.bind(f.trace);
  f.trace.save = (name, value) => { save(name, value); if (name === 'review-publication.json') throw new Error('Interrupted after durable publication'); };
  await assert.rejects(completeReview({ trace: f.trace, state: f.originalState, path: f.path, runtimeHome: f.root,
    recovered: false, connection: f.connection }), /Interrupted/);
  const reads = f.state.reads;
  assert.equal((await f.recover()).status, 'review_completed');
  assert.equal(f.state.reads, reads); assert.equal(f.state.creates, 1);
});

test('completed result reconciles a dead active owner without touching GitHub', async () => {
  const f = await recoveryFixture();
  await f.recover();
  await writeState(f.path, f.originalState);
  await writeFile(`${f.path}.lock`, String(f.originalState.pid));
  const reads = f.state.reads;
  assert.equal((await f.recover()).status, 'already_completed');
  assert.equal(f.state.reads, reads); assert.equal(f.state.creates, 1);
  assert.equal((await readState(f.path))?.active, false);
});
