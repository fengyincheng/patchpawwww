import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Trace } from '../src/harness/trace.ts';
import { claimRun, writeState, readState, statePath, type RunState } from '../src/runner/state.ts';
import { hasRunnableWork } from '../src/runner/runnable.ts';
import { enqueueCommentDelivery, enqueueReviewDelivery, deliverImmediately, listOutbound, wakeOutboundScheduler } from '../src/runner/outbound.ts';
import { wakeCommunicationScheduler } from '../src/runner/communication-wake.ts';
import { startOutboundScheduler, type SchedulerConfig } from '../src/runner/outbound-scheduler.ts';
import { closeCommunicationStore, openCommunicationStore } from '../src/runner/communication-store.ts';

async function updateOutbound(root: string, deliveryId: string, fields: { status?: string; nextAttemptAt?: string; sendingUntilAt?: string | null; receipt?: unknown; nextFinalizationAt?: string | null; lifecycleStatus?: string }) {
  const store = await openCommunicationStore(root);
  try {
    await store.execute(`UPDATE outbound_delivery SET
      status = COALESCE(:status, status), next_attempt_at = COALESCE(:next_attempt_at, next_attempt_at),
      sending_until_at = :sending_until_at, receipt_json = COALESCE(:receipt_json, receipt_json),
      next_finalization_at = :next_finalization_at, lifecycle_status = COALESCE(:lifecycle_status, lifecycle_status),
      updated_at = :updated_at WHERE delivery_id = :delivery_id`, {
      status: fields.status ?? null, next_attempt_at: fields.nextAttemptAt ?? null,
      sending_until_at: fields.sendingUntilAt ?? null, receipt_json: fields.receipt === undefined ? null : JSON.stringify(fields.receipt),
      next_finalization_at: fields.nextFinalizationAt ?? null, lifecycle_status: fields.lifecycleStatus ?? null,
      updated_at: new Date().toISOString(), delivery_id: deliveryId,
    });
  } finally { await closeCommunicationStore(store); }
}

test('legacy review_ready state is reconciled and delivered without human input or model work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-'));
  const repo = 'owner/repo', number = 7, runId = 'live-review-run', headSha = 'a'.repeat(40);
  const path = statePath(join(root, 'data/state'), repo, number);
  const trace = new Trace(join(root, 'runs', runId));
  const review = { summary: 'Summary', recommendation: 'comment' as const, findings: [], limitations: [] };
  trace.save('manifest.json', { run_id: runId, repo, pr_number: number, request_author: 'author' });
  trace.save('review.json', { head_sha: headSha, ...review });
  const state: RunState = { repo, pr_number: number, run_id: runId, current_head_sha: headSha,
    phase: 'review_ready', repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false,
    active: false, pid: 2147483647, handled_comment_ids: [5580800992] };
  await writeState(path, state);
  assert.equal(await hasRunnableWork(root, repo, number), true);

  const config: SchedulerConfig = { root, appId: 1, privateKey: '', snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' };
  const remote: { creates: number; reviews: any[] } = { creates: 0, reviews: [] };
  const client: any = { rest: { pulls: {
    get: async () => ({ data: { state: 'open', head: { sha: headSha } } }),
    listReviews: async () => ({ data: remote.reviews }),
    createReview: async ({ body, commit_id }: { body: string; commit_id: string }) => {
      remote.creates++;
      const value = { id: remote.creates, html_url: `https://github.test/review/${remote.creates}`, commit_id,
        body, user: { login: 'patchpawwww[bot]', type: 'Bot' }, submitted_at: '2026-09-08T00:00:00Z', state: 'COMMENTED' };
      remote.reviews.push(value);
      return { data: value };
    },
  } }, paginate: async (method: Function, params: unknown) => (await method(params)).data };
  const github: any = { app: { rest: { apps: {
    getAuthenticated: async () => ({ data: { slug: 'patchpawwww' } }),
    getRepoInstallation: async () => ({ data: { id: 1 } }),
  } } }, installation: () => client };
  const service = startOutboundScheduler(config, 10, github);
  await service.ready;
  for (let attempt = 0; attempt < 100 && (await readState(path))?.phase !== 'review_completed'; attempt++) await delay(10);
  service.stop();
  assert.equal(remote.creates, 1);
  const delivered = (await listOutbound(root)).find(value => value.item.kind === 'review')!;
  assert.equal(delivered.item.status, 'delivered');
  assert.equal((await readState(path))?.phase, 'review_completed');
  assert.equal(JSON.parse(await readFile(join(trace.dir, 'result.json'), 'utf8')).status, 'review_completed');
  assert.equal(JSON.parse(await readFile(join(trace.dir, 'review-publication.json'), 'utf8')).id, 1);

  // A fresh service instance reconciles the same durable root without another
  // review POST, which is the restart path for the original handled comment.
  const restarted = startOutboundScheduler(config, 10, github);
  await restarted.ready;
  await delay(30);
  restarted.stop();
  assert.equal(remote.creates, 1);
  assert.equal((await listOutbound(root)).length, 1);
});

function legacyStateGithub() {
  const comments: any[] = [];
  let installations = 0;
  const client: any = { rest: { issues: {
    listComments: async () => ({ data: comments }),
    createComment: async ({ body }: { body: string }) => {
      const comment = { id: 700 + comments.length, html_url: `https://github.test/comment/${comments.length}`, body,
        user: { login: 'patchpawwww[bot]', type: 'Bot' } };
      comments.push(comment); return { data: comment };
    },
  } } };
  const github: any = { app: { rest: { apps: {
    getAuthenticated: async () => ({ data: { slug: 'patchpawwww' } }),
    getRepoInstallation: async () => { installations++; return { data: { id: 1 } }; },
  } } }, installation: () => client };
  return { github, comments, get installations() { return installations; } };
}

async function waitUntil(predicate: () => Promise<boolean>, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('scheduler did not converge before timeout');
}

test('scheduler reconciles state-only legacy completion, refusal and closing journal layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-state-'));
  const stateRoot = join(root, 'data/state');
  const base = (repo: string, pr_number: number, phase: string): RunState => ({ repo, pr_number, run_id: '', current_head_sha: '',
    phase, repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: 2147483647, handled_comment_ids: [] });
  const completionPath = statePath(stateRoot, 'owner/completion', 7);
  await writeState(completionPath, { ...base('owner/completion', 7, 'closed'), close_comment_id: 701,
    closed_through_comment_id: 701, close_mentions: ['owner'], completion_notice_status: 'pending' });
  const refusalPath = statePath(stateRoot, 'owner/refusal', 8);
  await writeState(refusalPath, { ...base('owner/refusal', 8, 'needs_human'), pending_close_refusal: { comment_id: 702, author: 'author' } });
  const closingPath = statePath(stateRoot, 'owner/closing', 9);
  await writeState(closingPath, base('owner/closing', 9, 'closing'));
  await writeFile(`${closingPath}.close.json`, JSON.stringify({ status: 'closing', repo: 'owner/closing', pr_number: 9,
    close_comment_id: 703, start_notice_id: null, started_at: new Date().toISOString(), run_ids: [], workspace_paths: [],
    rejected_workspace_paths: [], mentions: ['owner'], last_step: 'preflight', last_error: null }) + '\n');
  const config: SchedulerConfig = { root, appId: 1, privateKey: '', snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' };
  const remote = legacyStateGithub();
  const service = startOutboundScheduler(config, 5, remote.github);
  await service.ready;
  await waitUntil(async () => (await readState(completionPath))?.completion_notice_status === 'published');
  await waitUntil(async () => !(await readState(refusalPath))?.pending_close_refusal);
  await waitUntil(async () => JSON.parse(await readFile(`${closingPath}.close.json`, 'utf8')).status === 'completed');
  service.stop();
  assert.equal((await listOutbound(root)).filter(value => value.item.status === 'delivered').length, 4,
    'legacy state-only notices should converge without human comments');
  assert.equal(remote.comments.some(comment => comment.body.includes('本地会话已清除')), true);
});

test('repeated sweeps skip historical delivered and finalized comments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-finalized-'));
  const remote = legacyStateGithub();
  const connection = { client: remote.github.installation(1), botLogin: 'patchpawwww[bot]' };
  for (let index = 0; index < 40; index++) {
    const stored = await enqueueCommentDelivery({ root, repo: 'owner/repo', prNumber: 10, purpose: 'conversation_reply',
      semanticKey: `historical:${index}`, body: `message ${index}`, mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
    const result = await deliverImmediately(root, stored, connection, [0]);
    assert.equal(result.item.lifecycle_status, 'finalized');
  }
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  await service.ready;
  await delay(50);
  service.stop();
  assert.equal(remote.installations, 0, 'ordinary finalized comments do not reacquire GitHub installations');
  assert.equal((await listOutbound(root)).length, 40);
});

test('wake bind failure rejects readiness instead of starting a degraded service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-bind-'));
  const parent = join(root, 'socket-parent');
  await writeFile(parent, 'this is a file, not a directory\n');
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', snapshotRoot: join(root, 'snapshots'),
    wakeTransport: 'unix', wakeSocketPath: join(parent, 'outbound.sock') }, 5, legacyStateGithub().github);
  await assert.rejects(service.ready, error => ['ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''));
  service.stop();
});

test('producer wake failure is observable after a durable enqueue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-wake-failure-'));
  const result = await wakeCommunicationScheduler(root);
  assert.equal(result, false);
});

test('a child process can wake the ready scheduler over the Unix socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-child-'));
  const remote = legacyStateGithub();
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'unix' }, 5, remote.github);
  try {
    await service.ready;
    const moduleUrl = new URL('../src/runner/outbound.ts', import.meta.url).href;
    const source = `import { enqueueCommentDelivery } from ${JSON.stringify(moduleUrl)};
      await enqueueCommentDelivery({ root: ${JSON.stringify(root)}, repo: 'owner/repo', prNumber: 7,
        purpose: 'conversation_reply', semanticKey: 'child-wake', body: 'child wake', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const output = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
    });
    assert.equal(output.code, 0, output.stderr);
    await waitUntil(async () => (await listOutbound(root))[0]?.item.status === 'delivered');
    assert.equal(remote.comments.length, 1);
  } finally {
    service.stop();
  }
});

test('an item written before wake readiness is recovered by the post-bind startup scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-race-'));
  const remote = legacyStateGithub();
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  // This enqueue races initialize(): the memory listener is registered but the recovery scan
  // has not necessarily begun. The same ordering is what the post-bind Unix scan protects.
  const pending = await enqueueCommentDelivery({ root, repo: 'owner/repo', prNumber: 7, purpose: 'conversation_reply',
    semanticKey: 'startup-race', body: 'startup race', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
  await service.ready;
  await waitUntil(async () => (await listOutbound(root)).find(value => value.item.delivery_id === pending.item.delivery_id)?.item.status === 'delivered');
  service.stop();
  assert.equal(remote.comments.length, 1);
});

test('a wake during a running pump is remembered and processed in a later pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-dirty-'));
  const remote = legacyStateGithub();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const client = remote.github.installation(1);
  const original = client.rest.issues.createComment;
  let posts = 0;
  client.rest.issues.createComment = async (input: any) => {
    posts++;
    if (posts === 1) { firstStarted(); await release; }
    return original(input);
  };
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  try {
    await service.ready;
    const first = await enqueueCommentDelivery({ root, repo: 'owner/first', prNumber: 1, purpose: 'conversation_reply',
      semanticKey: 'dirty-first', body: 'first', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
    await firstReady;
    const second = await enqueueCommentDelivery({ root, repo: 'owner/second', prNumber: 2, purpose: 'conversation_reply',
      semanticKey: 'dirty-second', body: 'second', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
    for (let index = 0; index < 20; index++) void wakeOutboundScheduler(root);
    releaseFirst();
    await waitUntil(async () => (await listOutbound(root)).every(item => item.item.status === 'delivered')
      && (await listOutbound(root)).length === 2);
    assert.equal((await listOutbound(root)).find(item => item.item.delivery_id === first.item.delivery_id)?.item.status, 'delivered');
    assert.equal((await listOutbound(root)).find(item => item.item.delivery_id === second.item.delivery_id)?.item.status, 'delivered');
    assert.equal(posts, 2, 'coalesced wakes must not duplicate GitHub POSTs');
  } finally { service.stop(); }
});

test('a wake during deadline arm does not leave new due work behind the old timer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-deadline-race-'));
  const remote = legacyStateGithub();
  const future = await enqueueCommentDelivery({ root, repo: 'owner/future', prNumber: 3, purpose: 'conversation_reply',
    semanticKey: 'future', body: 'future', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
  await updateOutbound(root, future.item.delivery_id, { nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  let injected = false;
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory', schedulerHooks: {
      afterDeadlineRead: async () => {
        if (injected) return;
        injected = true;
        await enqueueCommentDelivery({ root, repo: 'owner/urgent', prNumber: 4, purpose: 'conversation_reply',
          semanticKey: 'urgent', body: 'urgent', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
      },
    } }, 5, remote.github);
  try {
    await service.ready;
    await waitUntil(async () => (await listOutbound(root)).find(item => item.item.semantic_key === 'urgent')?.item.status === 'delivered');
    assert.equal(remote.comments.length, 1, 'the injected due item must run immediately');
    assert.equal((await listOutbound(root)).find(item => item.item.semantic_key === 'future')?.item.status, 'pending');
  } finally { service.stop(); }
});

test('rapid wakes keep one pump and one POST per durable item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-wake-storm-'));
  const remote = legacyStateGithub();
  const client = remote.github.installation(1);
  let active = 0;
  let maximum = 0;
  const original = client.rest.issues.createComment;
  client.rest.issues.createComment = async (input: any) => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(10);
    const result = await original(input);
    active--;
    return result;
  };
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  try {
    await service.ready;
    for (let index = 0; index < 8; index++) await enqueueCommentDelivery({ root, repo: `owner/repo-${index}`, prNumber: 1,
      purpose: 'conversation_reply', semanticKey: `storm-${index}`, body: `storm ${index}`, mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
    for (let index = 0; index < 100; index++) void wakeOutboundScheduler(root);
    await waitUntil(async () => (await listOutbound(root)).length === 8
      && (await listOutbound(root)).every(item => item.item.status === 'delivered'));
    assert.equal(maximum, 1, 'wake coalescing must keep one pump active');
    assert.equal(remote.comments.length, 8);
  } finally { service.stop(); }
});

test('a sending item held by another worker gets a non-zero retry deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-busy-'));
  const remote = legacyStateGithub();
  const pending = await enqueueCommentDelivery({ root, repo: 'owner/repo', prNumber: 7, purpose: 'conversation_reply',
    semanticKey: 'busy-sender', body: 'busy sender', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
  await updateOutbound(root, pending.item.delivery_id, { status: 'sending', nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
    sendingUntilAt: new Date(Date.now() + 30_000).toISOString() });
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  await service.ready;
  wakeOutboundScheduler(root);
  await delay(150);
  assert.equal(remote.comments.length, 0);
  assert.equal(remote.installations, 0, 'a non-expired sending lease must not acquire a connection');
  await updateOutbound(root, pending.item.delivery_id, { status: 'pending_retry', nextAttemptAt: new Date().toISOString(), sendingUntilAt: null });
  wakeOutboundScheduler(root);
  await waitUntil(async () => (await listOutbound(root)).find(value => value.item.delivery_id === pending.item.delivery_id)?.item.status === 'delivered');
  service.stop();
  assert.equal(remote.comments.length, 1);
});

test('review lifecycle finalization waits for the active PR owner and converges once after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-review-lock-'));
  const repo = 'owner/repo', number = 7, runId = 'review-lock-run', headSha = 'b'.repeat(40);
  const path = statePath(join(root, 'data/state'), repo, number);
  const trace = new Trace(join(root, 'runs', runId));
  const workspace = join(root, 'workspaces', 'review-lock-workspace');
  await mkdir(workspace, { recursive: true });
  trace.save('manifest.json', { run_id: runId, repo, pr_number: number, workspace_path: workspace });
  trace.save('review.json', { head_sha: headSha, summary: 'summary', recommendation: 'comment', findings: [], limitations: [] });
  await writeState(path, { repo, pr_number: number, run_id: runId, current_head_sha: headSha, phase: 'review_publishing',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid, handled_comment_ids: [] });
  const ownerRelease = await claimRun(path); assert.ok(ownerRelease);
  const stored = await enqueueReviewDelivery({ root, repo, prNumber: number, purpose: 'pr_review', semanticKey: 'review-lock',
    headSha, review: { summary: 'summary', recommendation: 'comment', findings: [], limitations: [] }, mentions: ['owner'],
    botLogin: 'patchpawwww[bot]', runId });
  await updateOutbound(root, stored.item.delivery_id, { status: 'delivered', nextAttemptAt: new Date().toISOString(), sendingUntilAt: null,
    receipt: { id: 1, html_url: 'https://github.test/review/1' }, nextFinalizationAt: new Date().toISOString() });
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, legacyStateGithub().github);
  await service.ready;
  await delay(50);
  assert.equal((await readState(path))?.phase, 'review_publishing');
  assert.equal(await stat(workspace).then(() => true, () => false), true);
  await writeState(path, { ...(await readState(path))!, active: false });
  await ownerRelease!();
  const due = (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)!;
  await updateOutbound(root, due.item.delivery_id, { nextFinalizationAt: new Date().toISOString() });
  wakeOutboundScheduler(root);
  await waitUntil(async () => (await readState(path))?.phase === 'review_completed'
    && (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)?.item.lifecycle_status === 'finalized');
  service.stop();
  assert.equal(await stat(workspace).then(() => true, () => false), false);
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)?.item.lifecycle_status, 'finalized');
});

test('/close lifecycle finalization waits for the active PR owner before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scheduler-close-lock-'));
  const repo = 'owner/repo', number = 7;
  const path = statePath(join(root, 'data/state'), repo, number);
  await writeState(path, { repo, pr_number: number, run_id: '', current_head_sha: '', phase: 'closing', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid, handled_comment_ids: [] });
  await writeFile(`${path}.close.json`, JSON.stringify({ status: 'closing', repo, pr_number: number, close_comment_id: 88,
    start_notice_id: 8, started_at: new Date().toISOString(), run_ids: [], workspace_paths: [], rejected_workspace_paths: [],
    mentions: ['owner'], last_step: 'start_published', last_error: null }) + '\n');
  const stored = await enqueueCommentDelivery({ root, repo, prNumber: number, purpose: 'close_start', semanticKey: 'close-lock',
    body: 'start', mentions: ['owner'], botLogin: 'patchpawwww[bot]', source: { close_comment_id: 88 } });
  await updateOutbound(root, stored.item.delivery_id, { status: 'delivered', nextAttemptAt: new Date().toISOString(), sendingUntilAt: null,
    receipt: { id: 8, html_url: 'https://github.test/comment/8' }, nextFinalizationAt: new Date().toISOString() });
  const remote = legacyStateGithub();
  const ownerRelease = await claimRun(path); assert.ok(ownerRelease);
  const service = startOutboundScheduler({ root, appId: 1, privateKey: '', appSlug: 'patchpawwww',
    snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, 5, remote.github);
  await service.ready;
  await delay(50);
  assert.equal((await readState(path))?.phase, 'closing');
  assert.equal(remote.installations, 0, 'active close owner must prevent connection acquisition');
  await writeState(path, { ...(await readState(path))!, active: false });
  await ownerRelease!();
  const due = (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)!;
  await updateOutbound(root, due.item.delivery_id, { nextFinalizationAt: new Date().toISOString() });
  wakeOutboundScheduler(root);
  await waitUntil(async () => (await readState(path))?.phase === 'closed'
    && remote.comments.length === 1
    && (await listOutbound(root)).filter(value => value.item.purpose === 'close_completion')
      .every(value => value.item.lifecycle_status === 'finalized'));
  service.stop();
  assert.equal(remote.comments.length, 1, 'completion is published once after close ownership is released');
});
