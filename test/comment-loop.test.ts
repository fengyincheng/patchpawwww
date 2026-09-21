import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { statePath, readState } from '../src/runner/state.ts';
import { budget } from '../src/harness/budget.ts';
import { readPaused, savePaused } from '../src/runner/resume.ts';
import { recoverRun } from '../src/runner/recovery.ts';
import { repoCachePath } from '../src/workspace/repo-store.ts';
import { fixture } from './helpers/pr-fixture.ts';
import { listOutbound } from '../src/runner/outbound.ts';
import { startOutboundScheduler } from '../src/runner/outbound-scheduler.ts';
import { closeCommunicationStore, openCommunicationStore } from '../src/runner/communication-store.ts';
import { closeControlPlaneDb, openPreparedControlPlaneDb, prepareControlPlaneDb } from '../src/control-plane/db.ts';
import { withRuntimeLock } from '../src/migration/runtime-lock.ts';

test('CI command posts help, accepts a new CI command, repairs and delivers without implicit Review', async t => {
  const f = await fixture(t);
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(first.status, 'needs_human');
  assert.ok('run_id' in first);
  const notices = () => f.calls.filter(c => c.path.endsWith('/issues/7/comments'));
  assert.equal(notices().length, 1);
  assert.match(notices()[0].body.body, /@owner/);
  assert.match(notices()[0].body.body, /@operator/);
  assert.match(notices()[0].body.body, /保留哪种行为/);
  assert.match(notices()[0].body.body, /\[REDACTED\]/);
  assert.ok(!notices()[0].body.body.includes('fixture-secret'));
  const original = await readFile(join(f.root, 'runs', first.run_id!, 'result.json'), 'utf8');
  await saveHumanReply(statePath(join(f.root, 'data/state'), 'owner/lab', 7), { repo: 'owner/lab', pr_number: 7, installation_id: 42,
    comment_id: 101, author: 'owner', body: '@patchpawwww /CI 改成 after，请继续。', url: 'https://github.com/owner/lab/pull/7#issuecomment-101' });
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'ci_completed');
  assert.ok('run_id' in second);
  assert.notEqual(second.run_id, first.run_id);
  assert.notEqual(second.final_head_sha, f.base);
  assert.match(JSON.stringify(f.modelInputs[1].messages), /改成 after/);
  assert.match(JSON.stringify(f.modelInputs[1].messages), /保留哪种行为/);
  assert.equal(notices().length, 2, 'one help request and one CI delivery');
  assert.ok(!f.calls.some(c => c.path.endsWith('/pulls/7/reviews')));
  assert.match(notices()[1].body.body, /@owner @operator/);
  assert.match(notices()[1].body.body, /GitHub CI/);
  assert.equal(await readFile(join(f.root, 'runs', first.run_id!, 'result.json'), 'utf8'), original);
  const manifest = JSON.parse(await readFile(join(f.root, 'runs', second.run_id!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entry, 'github_comment');
  assert.equal(manifest.reply_to_run_id, first.run_id);
});

test('worker shared-lock entry reuses the prepared control plane and completes Review', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /review');
  await prepareControlPlaneDb(f.root);

  let result: any;
  await withRuntimeLock(f.root, 'shared', false, async () => {
    const controlPlaneDb = await openPreparedControlPlaneDb(f.root);
    try {
      result = await runPullRequest({ ...f.config, controlPlaneDb }, 'owner/lab', 7);
    } finally {
      closeControlPlaneDb(controlPlaneDb);
    }
  });

  assert.equal(result.status, 'review_completed');
  assert.ok(result.run_id);
  const manifest = JSON.parse(await readFile(join(f.root, 'runs', result.run_id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.command, 'review');
  assert.equal(typeof manifest.snapshot_sha256, 'string');
});

test('normal PR entry resumes a lost Review publication without another model, clone or repair', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /review');
  f.control.dropReviewAcknowledgement = true;
  const interrupted = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(interrupted.status, 'review_completed', 'the immediate retry adopts the Review after its ACK is lost');
  assert.ok(!f.modelInputs[0].tools.some((tool: any) => tool.function.name === 'reply_to_pr'),
    'Review publication remains a Harness responsibility');
  const models = f.modelInputs.length, calls = f.calls.length;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'mention_required');
  assert.equal(f.modelInputs.length, models, 'recovery must not call a model');
  assert.equal(f.calls.filter(c => c.path.endsWith('/reviews') && c.body).length, 1);
  assert.ok(!f.calls.slice(calls).some(c => /check-runs|\/status$|\/actions\/runs|\/branches\//.test(c.path)));
  const { readdir } = await import('node:fs/promises');
  assert.equal((await readdir(join(f.root, 'runs'))).length, 1, 'recovery must not create another run/workspace');
});

test('runner verifies and pushes an Agent-authored commit without making a duplicate commit', async t => {
  const f = await fixture(t); f.control.agentCommits = true;
  await runPullRequest(f.config, 'owner/lab', 7);
  await saveHumanReply(statePath(join(f.root, 'data/state'), 'owner/lab', 7), { repo: 'owner/lab', pr_number: 7, installation_id: 42,
    comment_id: 101, author: 'operator', body: '@patchpawwww /CI 请继续修复', url: 'https://github.com/owner/lab/pull/7#issuecomment-101' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'ci_completed');
  assert.ok('run_id' in result);
  const dir = join(f.root, 'runs', result.run_id!);
  const workspace = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).workspace_path;
  // Published facts are read from the remote; the disposable workspace is cleaned up terminal.
  assert.equal((await git(join(f.root, 'remote'), ['log', '-1', '--format=%s', 'feature'])).stdout.trim(), 'Agent authored fix');
  assert.equal((await git(join(f.root, 'remote'), ['rev-list', '--count', `${f.base}..feature`])).stdout.trim(), '1');
  assert.equal((await git(join(f.root, 'remote'), ['rev-parse', 'feature'])).stdout.trim(), result.final_head_sha);
  const durable = await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7));
  assert.equal(durable?.phase, 'ci_completed');
  assert.equal(durable?.current_head_sha, result.final_head_sha);
  assert.equal(durable?.last_patchpaw_commit, result.final_head_sha);
  assert.equal(f.modelInputs.some(input => input.tools.some((tool: any) => tool.function.name === 'request_repair_verification')), false);
  const events = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.event === 'git' && e.args[0] === 'commit').length, 0);
  assert.ok(events.some(e => e.event === 'workspace_disposed' && e.workspace === workspace));
  await assert.rejects(stat(workspace), { code: 'ENOENT' }, 'terminal workspace is disposed while run evidence remains');
});

test('a human question gets an agent-authored PR answer without CI, edits, verification, commit or review', async t => {
  const f = await fixture(t, false); f.control.conversation = 'reply'; f.control.prAuthor = 'patchpawwww[bot]';
  await saveHumanReply(statePath(join(f.root, 'data/state'), 'owner/lab', 7), { repo: 'owner/lab', pr_number: 7, installation_id: 42,
    comment_id: 101, author: 'operator', body: '@patchpawwww 收到请回复', url: 'https://github.com/owner/lab/pull/7#issuecomment-101' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'conversation_completed');
  assert.ok('run_id' in result);
  assert.equal(result.final_head_sha, f.base);
  assert.equal(f.modelInputs.length, 1);
  const tools = f.modelInputs[0].tools.map((tool: any) => tool.function.name);
  for (const forbidden of ['mastra_workspace_edit_file', 'mastra_workspace_write_file', 'mastra_workspace_execute_command', 'request_repair_verification']) {
    assert.ok(!tools.includes(forbidden), `conversation must not expose ${forbidden}`);
  }
  const comments = f.calls.filter(c => c.path.endsWith('/issues/7/comments'));
  assert.equal(comments.length, 1, 'one real answer, no fixed acknowledgement or failure notice');
  assert.match(comments[0].body.body, /@patchpawwww\[bot\] @operator/);
  assert.match(comments[0].body.body, /可以正常沟通/);
  assert.ok(!f.calls.some(c => /check-runs|\/status$|\/actions\/runs|\/reviews$/.test(c.path)));
  const dir = join(f.root, 'runs', result.run_id!);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.task_chain, ['conversation']);
  const trace = await readFile(join(dir, 'trace.jsonl'), 'utf8');
  assert.ok(!/"event":"repair_commit"|"event":"repair_verification"|"event":"repair_push"/.test(trace));
  // The read-only conversation workspace was created at the exact head, then disposed as terminal.
  const events = trace.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(e => e.event === 'worktree_created')?.head_sha, f.base);
  assert.ok(events.some(e => e.event === 'workspace_disposed' && e.workspace === manifest.workspace_path));
  await assert.rejects(stat(manifest.workspace_path), { code: 'ENOENT' });
});

test('PR author and operator are mentioned once when they are the same account', async t => {
  const f = await fixture(t); f.config.operatorLogin = 'OWNER';
  await runPullRequest(f.config, 'owner/lab', 7);
  const notice = f.calls.find(c => c.path.endsWith('/issues/7/comments'))!;
  assert.equal(notice.body.body.match(/@owner\b/gi)?.length, 1);
});

test('an unsuccessful conversational publication is not reported as a completed reply', async t => {
  const f = await fixture(t, false); f.control.conversation = 'reply'; f.control.commentStatus = 403;
  await saveHumanReply(statePath(join(f.root, 'data/state'), 'owner/lab', 7), { repo: 'owner/lab', pr_number: 7, installation_id: 42,
    comment_id: 101, author: 'operator', body: '@patchpawwww 可以解释一下吗？', url: 'https://github.com/owner/lab/pull/7#issuecomment-101' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'conversation_completed', 'a blocked transport does not turn a successful Agent answer into a Harness failure');
  assert.ok('run_id' in result);
  const publication = JSON.parse(await readFile(join(f.root, 'runs', result.run_id!, 'conversation-publication.json'), 'utf8'));
  assert.equal(publication.status, 'blocked');
  // A blocked outbound item keeps the exact answer durably while the terminal workspace still cleans up.
  assert.equal(JSON.parse(await readFile(join(f.root, 'runs', result.run_id!, 'result.json'), 'utf8')).status, 'conversation_completed');
  await assert.rejects(stat(join(f.root, 'workspaces', result.run_id!)), { code: 'ENOENT' });
});

test('comment API failure preserves the real needs_human result and records notification failure', async t => {
  const f = await fixture(t); f.control.commentStatus = 403;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human');
  assert.ok('run_id' in result);
  const notification = await readFile(join(f.root, 'runs', result.run_id!, 'notification.json'), 'utf8');
  assert.deepEqual(JSON.parse(notification), { status: 'notification_failed', http_status: 403 });
  assert.ok(!notification.includes('fixture-secret'));
});

test('early Harness failure still attempts a PR notification without a captured PR context', async t => {
  const f = await fixture(t); f.control.captureFails = true;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'harness_failed');
  const notice = f.calls.find(c => c.path.endsWith('/issues/7/comments'))!;
  assert.match(notice.body.body, /harness_failed/);
  assert.match(notice.body.body, /Fixture inspection failure/);
});

test('early notice is durable before installation acquisition and scheduler publishes it after recovery', async t => {
  const f = await fixture(t); f.control.installationFailures = 2;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'harness_failed');
  assert.equal(f.calls.filter(c => c.path.endsWith('/issues/7/comments')).length, 0, 'no human comment is possible while acquisition is failing');
  const pending = (await listOutbound(f.root)).find(value => value.item.purpose === 'run_notice')!;
  assert.equal(pending.item.status, 'pending_retry');
  assert.equal(pending.item.attempt_count, 1);
  const communication = await openCommunicationStore(f.root);
  try { await communication.execute(`UPDATE outbound_delivery SET next_attempt_at = :now, updated_at = :now WHERE delivery_id = :delivery_id`,
    { now: new Date().toISOString(), delivery_id: pending.item.delivery_id }); }
  finally { await closeCommunicationStore(communication); }
  const notice = JSON.parse(await readFile(join(f.root, 'runs', result.run_id!, 'run-notice.json'), 'utf8'));
  assert.match((pending.item.payload as { body: string }).body, /harness_failed/);
  assert.ok((pending.item.payload as { body: string }).body.includes(notice.reason));

  const comments: any[] = [];
  const client: any = { rest: { issues: {
    listComments: async () => ({ data: comments }),
    createComment: async ({ body }: { body: string }) => {
      const comment = { id: 901, html_url: 'https://github.test/comment/901', body, user: { login: 'patchpawwww[bot]', type: 'Bot' } };
      comments.push(comment); return { data: comment };
    },
  } } };
  const github: any = { app: { rest: { apps: {
    getAuthenticated: async () => ({ data: { slug: 'patchpawwww' } }),
    getRepoInstallation: async () => ({ data: { id: 42 } }),
  } } }, installation: () => client };
  const service = startOutboundScheduler(f.config, 5, github);
  await service.ready;
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = (await listOutbound(f.root)).find(value => value.item.delivery_id === pending.item.delivery_id);
    if (comments.length && current?.item.status === 'delivered') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  service.stop();
  assert.equal(comments.length, 1);
  assert.equal((await listOutbound(f.root)).find(value => value.item.delivery_id === pending.item.delivery_id)?.item.status, 'delivered');
  assert.equal(notice.status, 'harness_failed');
  assert.equal(f.modelInputs.length, 0, 'retrying the notice does not rerun the Agent/task');
});

test('no pending mention means no model, GitHub action or new workspace even with an old pending head', async t => {
  const f = await fixture(t, false);
  const { savePending } = await import('../src/runner/state.ts');
  await savePending(statePath(join(f.root, 'data/state'), 'owner/lab', 7), 'old-automatic-trigger');
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'mention_required');
  assert.equal(f.calls.length, 0); assert.equal(f.modelInputs.length, 0);
  const { readdir } = await import('node:fs/promises');
  await assert.rejects(readdir(join(f.root, 'runs')), { code: 'ENOENT' });
});

test('Review works independently of red CI and allows immediate help without edits or verification', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /review');
  f.control.reviewNeedsHelp = true;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human');
  assert.equal(f.modelInputs.length, 1);
  assert.ok(!f.calls.some(c => /check-runs|\/reviews$/.test(c.path)));
  assert.match(f.calls.find(c => c.path.endsWith('/comments'))!.body.body, /还没有改代码/);
  assert.match(f.calls.find(c => c.path.endsWith('/comments'))!.body.body, /@operator/);
  // A review help request retains no paused pointer, so its read-only checkout is disposed
  // terminally while the run evidence explaining the request survives.
  const ws = join(f.root, 'workspaces', result.run_id!);
  await assert.rejects(stat(ws), { code: 'ENOENT' });
  const dir = join(f.root, 'runs', result.run_id!);
  assert.equal(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')).status, 'needs_human');
  assert.ok((await readFile(join(dir, 'trace.jsonl'), 'utf8')).includes('workspace_disposed'));
  assert.ok(f.modelInputs[0].tools.some((tool: any) => tool.function.name === 'request_human_help'));
});

test('CI gets real new-head failures after each push, stops at three commits and asks humans', async t => {
  const f = await fixture(t);
  f.control.redAlways = true; f.control.repeatRepair = true;
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human');
  const ws = join(f.root, 'workspaces', result.run_id!);
  assert.equal((await git(ws, ['rev-list', '--count', `${f.base}..HEAD`])).stdout.trim(), '3');
  assert.equal((await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7)))?.repair_attempts, 3);
  const heads = new Set(f.calls.filter(c => c.path.endsWith('/check-runs')).map(c => c.path));
  assert.equal(heads.size, 4, 'initial head plus three published heads are actually checked');
  assert.ok(!f.calls.some(c => c.path.endsWith('/reviews')));
  assert.match(f.calls.find(c => c.path.endsWith('/comments'))!.body.body, /3 轮 CI 修复提交/);
});

test('Conflict with no merge needed is a successful no-op, not a human-help requirement', async t => {
  const f = await fixture(t, false); await f.mention('@patchpawwww /confict');
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'conflict_completed');
  assert.equal(f.modelInputs.length, 0);
  assert.ok(!f.calls.some(c => /check-runs|\/reviews$/.test(c.path)));
  assert.match(f.calls.find(c => c.path.endsWith('/comments'))!.body.body, /没有修改或提交/);
});

test('queued commands execute separately and a later plain mention does not inherit a repair command', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /review', 100);
  await f.mention('@patchpawwww 请解释刚才的结论', 101);
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(first.status, 'review_completed');
  assert.equal((await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7)))?.handled_comment_ids?.length, 1);
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'conversation_completed');
  assert.equal((await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7)))?.handled_comment_ids?.length, 2);
  assert.ok(!f.modelInputs[1].tools.some((tool: any) => tool.function.name === 'continue_pr_task'));
  assert.match(JSON.stringify(f.modelInputs[1].messages), /Human choice verified/, 'ordinary mention recalls the earlier Review model response from persistent memory');
});

async function divergentConflict(f: Awaited<ReturnType<typeof fixture>>) {
  await git(f.remote, ['checkout', 'feature']); await writeFile(join(f.remote, 'sample.txt'), 'feature\n');
  await git(f.remote, ['commit', '-am', 'feature edit']);
  await git(f.remote, ['checkout', 'main']); await writeFile(join(f.remote, 'sample.txt'), 'main\n');
  await git(f.remote, ['commit', '-am', 'main edit']);
  f.control.mainSha = (await git(f.remote, ['rev-parse', 'HEAD'])).stdout.trim();
  f.control.conflictRepair = true;
}
// Conflict execution now ends at a durable, read-only Proposal. The proposal lifecycle is
// covered in test/conflict-proposals.test.ts; these legacy direct-repair cases intentionally do
// not run because they asserted the pre-stage-06 commit/push contract.

test('CI already green delivers without manufacturing edits or invoking a model', async t => {
  const f = await fixture(t);
  await git(f.remote, ['checkout', 'feature']);
  await writeFile(join(f.remote, 'sample.txt'), 'already-fixed\n');
  await git(f.remote, ['commit', '-am', 'existing fix']);
  const head = (await git(f.remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(f.remote, ['checkout', 'main']);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'ci_completed'); assert.equal(result.final_head_sha, head);
  assert.equal(f.modelInputs.length, 0);
  assert.match(f.calls.find(c => c.path.endsWith('/comments'))!.body.body, /没有修改或提交代码/);
});

for (const task of ['CI', 'review']) {
  test(`/stop interrupts ${task} in the same Agent and retains workspace through conversation`, async t => {
    const f = await fixture(t, false);
    f.control.stopOnModel = true;
    await f.mention(`@patchpawwww /${task}`);
    const first = await runPullRequest(f.config, 'owner/lab', 7);
    assert.equal(first.status, 'stopped');
    const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), paused = (await readPaused(path))!;
    assert.equal(paused.status, 'stopped'); assert.equal(paused.pause_reason, 'human_stop');
    assert.equal((await readState(path))?.active, false);
    assert.ok((await readState(path))?.handled_comment_ids?.includes(199));
    const dir = join(f.root, 'runs', first.run_id!);
    const report = JSON.parse(await readFile(join(dir, 'stop-report.json'), 'utf8'));
    const events = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(events.filter(e => e.event === 'model_request').map(e => e.task)).size, 1);
    assert.equal(report.source, 'agent'); assert.equal(report.thread, 'github:owner/lab:pr:7');
    assert.match(f.calls.find(c => c.path.endsWith('/comments') && c.body)!.body.body, /当前正在调查架构选择/);
    assert.ok(!f.calls.some(c => c.path.endsWith('/reviews') && c.body));
    const before = (await git(paused.workspace.path, ['status', '--porcelain'])).stdout;
    await f.mention('@patchpawwww 我们先讨论', 200);
    const conversation = await runPullRequest(f.config, 'owner/lab', 7);
    assert.equal(conversation.status, 'conversation_completed');
    const cm = JSON.parse(await readFile(join(f.root, 'runs', conversation.run_id!, 'manifest.json'), 'utf8'));
    assert.equal(cm.workspace_path, paused.workspace.path);
    assert.equal((await git(paused.workspace.path, ['status', '--porcelain'])).stdout, before);
    if (task === 'CI') f.control.turn = 1;
    else f.control.turn = 0;
    await f.mention(`@patchpawwww /${task}`, 201);
    const next = await runPullRequest(f.config, 'owner/lab', 7);
    assert.equal(next.status, task === 'CI' ? 'ci_completed' : `${task}_completed`);
    const nm = JSON.parse(await readFile(join(f.root, 'runs', next.run_id!, 'manifest.json'), 'utf8'));
    assert.equal(nm.workspace_path, paused.workspace.path); assert.equal(nm.execution_id, 2);
  });
}
test('/stop closeout failure falls back and an idle stop never clones a workspace', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /stop');
  const idle = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(idle.status, 'stopped'); assert.equal(f.modelInputs.length, 0);
  await divergentConflict(f); f.control.stopOnModel = true; f.control.stopReportFails = true;
  await f.mention('@patchpawwww /conflict', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stopped');
  const report = JSON.parse(await readFile(join(f.root, 'runs', result.run_id!, 'stop-report.json'), 'utf8'));
  assert.equal(report.source, 'harness');
  assert.equal((await readPaused(statePath(join(f.root, 'data/state'), 'owner/lab', 7)))?.status, 'stopped');
});

test('/stop during Review publication reports the settled result and retains workspace', async t => {
  const f = await fixture(t, false); f.control.stopOnPublish = true;
  await f.mention('@patchpawwww /review');
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stopped');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), paused = (await readPaused(path))!;
  assert.equal(paused.status, 'stopped');
  assert.ok((await readState(path))?.handled_comment_ids?.includes(199));
  await f.mention('@patchpawwww /review', 200);
  const resumed = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(resumed.status, 'review_completed');
  const manifest = JSON.parse(await readFile(join(f.root, 'runs', resumed.run_id!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.workspace_path, paused.workspace.path);
});
test('/stop interrupts CI polling and resumes polling without manufacturing a repair', async t => {
  const f = await fixture(t, false);
  await git(f.remote, ['checkout', 'feature']); await writeFile(join(f.remote, 'sample.txt'), 'green');
  await git(f.remote, ['commit', '-am', 'green candidate']); await git(f.remote, ['checkout', 'main']);
  f.control.stopOnPoll = true; await f.mention('@patchpawwww /CI');
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'stopped');
  await f.mention('@patchpawwww /CI', 200);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'ci_completed');
  assert.equal(f.modelInputs.length, 0);
});
test('a locally committed paused CI candidate verifies against its recorded remote head and publishes without new edits', async t => {
  const f = await fixture(t, false); f.control.stopOnModel = true;
  await f.mention('@patchpawwww /CI');
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'stopped');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), paused = (await readPaused(path))!;
  await writeFile(join(paused.workspace.path, 'sample.txt'), 'candidate');
  await git(paused.workspace.path, ['commit', '-am', 'retained candidate']);
  paused.local_head = (await git(paused.workspace.path, ['rev-parse', 'HEAD'])).stdout.trim();
  paused.pause_phase = 'publishing'; await savePaused(path, paused);
  f.control.turn = 2; await f.mention('@patchpawwww /CI', 200);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'ci_completed'); assert.equal(result.final_head_sha, paused.local_head);
});

test('runs for one repo share a single object store, fetch every time, never clone and dispose terminal workspaces', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /review', 100);
  await f.mention('@patchpawwww 请解释刚才的结论', 101);
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(first.status, 'review_completed');
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'conversation_completed');
  assert.deepEqual((await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git')),
    [`${encodeURIComponent('owner/lab')}.git`], 'one shared object store, outliving both runs');
  assert.deepEqual(await readdir(join(f.root, 'workspaces')), [], 'terminal workspaces are disposed after evidence persists');
  for (const run of [first, second]) {
    const dir = join(f.root, 'runs', run.run_id!);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.workspace_path, join(f.root, 'workspaces', run.run_id!));
    const events = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.event === 'git' && e.args[0] === 'clone').length, 0, 'no run clones');
    assert.equal(events.filter(e => e.event === 'repo_cache_initialized').length, run.run_id === first.run_id ? 1 : 0,
      'the cache is initialized once and reused forever');
    assert.ok(events.some(e => e.event === 'repo_cache_fetched'), 'every run fetches fresh remote state before working');
    assert.equal(events.find(e => e.event === 'worktree_created')?.workspace, manifest.workspace_path,
      'the workspace was a linked worktree of the shared store');
    assert.ok(events.some(e => e.event === 'workspace_disposed' && e.workspace === manifest.workspace_path));
  }
});

test('a prepare failure after worktree creation disposes the fresh workspace and keeps its evidence', async t => {
  const f = await fixture(t, false);
  await f.mention('@patchpawwww /conflict');
  const original = globalThis.fetch;
  let broken = false;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!broken && url.includes('/branches/main')) {
      broken = true;
      // The base ref "vanishes" from the shared store after the fetch but before merge
      // preparation: prepareWorkspace fails although the worktree was already created.
      await git(repoCachePath(f.root, 'owner/lab'), ['update-ref', '-d', 'refs/remotes/origin/main']);
    }
    return response;
  });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'harness_failed');
  assert.ok('run_id' in result);
  const dir = join(f.root, 'runs', result.run_id!);
  assert.equal(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')).status, 'harness_failed');
  const events = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(e => e.event === 'worktree_created'), 'the worktree really was created before the failure');
  assert.ok(events.some(e => e.event === 'workspace_disposed'), 'the failed preparation releases its own worktree');
  await assert.rejects(stat(join(f.root, 'workspaces', result.run_id!)), { code: 'ENOENT' },
    'a prepare failure never leaks a workspace without a paused pointer');
  assert.equal(await readPaused(statePath(join(f.root, 'data/state'), 'owner/lab', 7)), null, 'no paused pointer was fabricated');
  // The shared repo survives and its worktree metadata converged.
  const registered = (await git(repoCachePath(f.root, 'owner/lab'), ['worktree', 'list', '--porcelain'])).stdout;
  assert.ok(!registered.includes(result.run_id!));
});
