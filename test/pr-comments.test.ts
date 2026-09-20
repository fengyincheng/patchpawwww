import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server/app.ts';
import { dispatchHumanReply } from '../src/runner/dispatch.ts';
import { humanReply } from '../src/github/comments.ts';
import { hasHumanReplies, readHumanReplies, saveHumanReply, humanFeedback } from '../src/runner/human-feedback.ts';
import { statePath, writeState, readState, type RunState } from '../src/runner/state.ts';
import { parseRunPhase } from '../src/runner/phases.ts';
import { startInboundVerifier } from '../src/runner/inbound-verification.ts';
import { startCommunicationScheduler } from '../src/runner/communication-scheduler.ts';
import { closeCommunicationStore, openCommunicationStore } from '../src/runner/communication-store.ts';
import type { GitHubReader } from '../src/github/client.ts';

const payload = () => ({ action: 'created', installation: { id: 42 }, repository: { full_name: 'owner/lab' },
  issue: { number: 7, pull_request: {} }, comment: { id: 101, body: '@patchpawwww 保留现有行为，请继续。',
    html_url: 'https://github.com/owner/lab/pull/7#issuecomment-101', author_association: 'OWNER',
    user: { login: 'owner', type: 'User' } } });
const state = (): RunState => ({ repo: 'owner/lab', pr_number: 7, run_id: 'previous-run', current_head_sha: 'old-head',
  phase: 'ci-repair', repair_attempts: 1, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid });

test('signed PR replies are persisted during an active run without starting another worker or replaying duplicates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-comments-'));
  const path = statePath(join(root, 'data/state'), 'owner/lab', 7);
  await writeState(path, state());
  const secret = 'fixture-secret';
  const github = { async readPullRequest(_installation: number, repo: string, number: number) { return { repository: { id: 10, full_name: repo, private: true },
      pullRequest: { number, base: { sha: 'base', repo: { id: 10 } }, head: { sha: 'head' } } }; } };
  const scheduler = startCommunicationScheduler({ root, appId: 1, privateKey: '', snapshotRoot: join(root, 'snapshots'), wakeTransport: 'memory' }, github,
    reply => dispatchHumanReply(root, reply));
  await scheduler.ready;
  const app = buildServer({ root, webhookSecret: secret, snapshotRoot: join(root, 'snapshots'), testRepo: 'owner/lab', botLogin: 'patchpawwww' }, github,
    false, reply => dispatchHumanReply(root, reply));
  t.after(() => app.close());
  t.after(() => scheduler.stop());
  const send = (event: unknown, signature?: string) => {
    const raw = JSON.stringify(event);
    return app.inject({ method: 'POST', url: '/github/webhook', payload: raw, headers: {
      'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-github-delivery': 'comment-delivery',
      'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    } });
  };
  assert.equal((await send(payload(), 'bad')).statusCode, 401);
  assert.equal((await send(payload())).json().status, 'verification_pending');
  assert.equal((await send(payload())).json().status, 'verification_pending');
  for (let attempt = 0; attempt < 100 && !(await readHumanReplies(path)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await readHumanReplies(path)).length, 1);
  assert.equal(await hasHumanReplies(path), true);
  assert.deepEqual(await readState(path), state(), 'intake must not overwrite active runner state');
  const bot = payload(); bot.comment.user.type = 'Bot';
  const chatter = payload(); chatter.comment.body = 'Just talking';
  const outsider = payload(); outsider.comment.author_association = 'NONE';
  const edited = { ...payload(), action: 'edited' };
  const issue = { ...payload(), issue: { number: 7 } };
  for (const ignored of [bot, chatter, outsider, edited, issue]) {
    assert.equal((await send(ignored)).json().status, 'ignored');
  }
  assert.equal((await readHumanReplies(path)).length, 1);
});

test('human feedback carries the prior question and answers; delayed lower IDs and replies arriving mid-run remain pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-feedback-'));
  const path = statePath(join(root, 'data/state'), 'owner/lab', 7);
  const previous = { ...state(), active: false, phase: parseRunPhase('needs_human') };
  await writeState(path, previous);
  await mkdir(join(root, 'runs/previous-run'), { recursive: true });
  const evidence = JSON.stringify({ status: 'needs_human', reason: '应该保留哪种行为？' });
  await writeFile(join(root, 'runs/previous-run/result.json'), evidence);
  const reply = humanReply(payload(), 'patchpawwww')!;
  assert.equal(await saveHumanReply(path, reply), true);
  const unauthorizedApproval = payload();
  unauthorizedApproval.comment.id = 102;
  unauthorizedApproval.comment.author_association = 'NONE';
  unauthorizedApproval.comment.body = '@patchpawwww /approval';
  assert.equal(humanReply(unauthorizedApproval, 'patchpawwww')?.author_association, 'NONE',
    'an unauthorized approval must reach the durable rejection path');
  const quotedApproval = payload();
  quotedApproval.comment.id = 103;
  quotedApproval.comment.author_association = 'NONE';
  quotedApproval.comment.body = '讨论 @patchpawwww /approval';
  assert.equal(humanReply(quotedApproval, 'patchpawwww'), null,
    'ordinary unauthorized discussion must not wake the approval rejection path');
  assert.equal(await saveHumanReply(path, { ...reply, body: 'redelivery must not overwrite' }), false);
  const feedback = await humanFeedback(path, join(root, 'runs'));
  assert.equal(feedback.context?.previous_result?.reason, '应该保留哪种行为？');
  assert.equal(feedback.context?.comments[0].body, reply.body);
  await writeState(path, { ...previous, handled_comment_ids: feedback.handledIds });
  assert.equal(await hasHumanReplies(path), false);
  await saveHumanReply(path, { ...reply, comment_id: 100, body: 'delayed delivery' });
  await saveHumanReply(path, { ...reply, comment_id: 102, body: 'arrived during next run' });
  assert.equal(await hasHumanReplies(path), true);
  assert.deepEqual((await humanFeedback(path, join(root, 'runs'))).context?.new_comment_ids, [100, 102]);
  assert.equal(await readFile(join(root, 'runs/previous-run/result.json'), 'utf8'), evidence);
});

test('installed organization private repos accept members, while passive events never invoke comment dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-org-'));
  const received: string[] = [], accesses: number[] = [];
  let allowed = true;
  const secret = 'fixture-secret';
  const github = {
    async readPullRequest(installation: number, repo: string, number: number) {
      accesses.push(installation);
      if (!allowed) throw Object.assign(new Error('Not installed'), { status: 404 });
      return { repository: { id: 99, full_name: repo, private: true },
        pullRequest: { number, base: { sha: 'base', repo: { id: 99 } }, head: { sha: 'head' } } };
    },
  };
  const scheduler = startCommunicationScheduler({ root, appId: 1, privateKey: '', snapshotRoot: root, wakeTransport: 'memory' }, github,
    async comment => { received.push(comment.author); });
  await scheduler.ready;
  const app = buildServer({ root, webhookSecret: secret, snapshotRoot: root, testRepo: 'owner/lab', botLogin: 'patchpawwww' }, github,
    false, async comment => { received.push(comment.author); });
  t.after(() => app.close());
  t.after(() => scheduler.stop());
  const send = (value: unknown, event = 'issue_comment') => {
    const raw = JSON.stringify(value);
    return app.inject({ method: 'POST', url: '/github/webhook', payload: raw, headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': 'org-delivery',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
  };
  for (const [index, role] of ['OWNER', 'MEMBER', 'COLLABORATOR'].entries()) {
    const event = payload(); event.repository.full_name = 'organization/private-repo';
    event.comment.id = 101 + index;
    event.comment.author_association = role; event.comment.user.login = role.toLowerCase();
    assert.equal((await send(event)).json().status, 'verification_pending');
  }
  for (let attempt = 0; attempt < 100 && received.length < 3; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(received, ['owner', 'member', 'collaborator']);
  assert.deepEqual(accesses, [42, 42, 42]);
  allowed = false;
  assert.equal((await send(payload())).json().status, 'verification_pending');
  for (const event of ['push', 'check_run', 'workflow_run', 'pull_request_review_comment', 'installation']) {
    assert.equal((await send(payload(), event)).json().status, 'ignored');
  }
  assert.equal(received.length, 3);
});

test('signed human comment survives transient verification failure and dispatches once after restart recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-inbound-'));
  const secret = 'inbound-secret';
  let available = false;
  let reads = 0;
  const received: { values: number[] } = { values: [] };
  const github: GitHubReader = {
    async readPullRequest(_installation: number, repo: string, number: number) {
      reads++;
      if (!available) throw Object.assign(new Error('GitHub verification temporarily unavailable'), { status: 503 });
      return { repository: { id: 10, full_name: repo, private: true },
        pullRequest: { number, base: { sha: 'base', repo: { id: 10 } }, head: { sha: 'head' } } };
    },
  };
  const app = buildServer({ root, webhookSecret: secret, snapshotRoot: join(root, 'snapshots'), testRepo: 'owner/lab', botLogin: 'patchpawwww[bot]' }, github,
    false, async comment => { received.values = [...received.values, comment.comment_id]; });
  t.after(async () => app.close());
  const event = payload();
  const raw = JSON.stringify(event);
  const send = () => app.inject({ method: 'POST', url: '/github/webhook', payload: raw, headers: {
    'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-github-delivery': 'inbound-delivery',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
  const first = await send();
  assert.equal(first.statusCode, 202);
  assert.deepEqual(received.values, []);
  const communication = await openCommunicationStore(root);
  try {
    assert.equal((await communication.getInbound('owner/lab', 7, 101))?.record.status, 'pending_verification');
    await communication.execute(`UPDATE inbound_comment SET next_attempt_at = :now, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id`,
      { now: new Date().toISOString(), repo: 'owner/lab', pr_number: 7, comment_id: 101 });
  } finally { await closeCommunicationStore(communication); }
  available = true;
  const onVerified = async (_comment: any) => { received.values = [...received.values, 101]; };
  const verifier = startInboundVerifier({ root }, github, onVerified);
  for (let attempt = 0; attempt < 100 && !received.values.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  verifier.stop();
  assert.deepEqual(received.values, [101]);
  const after = await openCommunicationStore(root);
  try { assert.equal((await after.getInbound('owner/lab', 7, 101))?.record.status, 'dispatched'); }
  finally { await closeCommunicationStore(after); }
  assert.equal(reads, 1);
  assert.equal((await send()).json().status, 'verification_pending');
  assert.deepEqual(received.values, [101], 'webhook redelivery must not dispatch twice');
});
