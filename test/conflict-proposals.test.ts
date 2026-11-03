import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, type Fixture } from './helpers/pr-fixture.ts';
import { git } from '../src/workspace/git.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { readPaused } from '../src/runner/resume.ts';
import { readState, statePath } from '../src/runner/state.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { attemptDelivery, listOutbound } from '../src/runner/outbound.ts';
import { finalizeDelayedDelivery } from '../src/runner/communication-scheduler.ts';
import { closeCommunicationStore, openCommunicationStore } from '../src/runner/communication-store.ts';
import {
  createApprovalPlan,
  approvalPlanDirectory,
  readApprovalPlan,
  readApprovalPlanClaim,
  readCurrentApprovalPlan,
  readUnfinishedApprovalPlanClaim,
  saveApprovalPlan,
  updateApprovalPlan,
} from '../src/runner/approval-plans.ts';
import { conflictProposalHash, createConflictProposal, validateConflictProposal } from '../src/runner/conflict-proposals.ts';
import { createGitHub } from '../src/github/client.ts';

async function divergent(f: Fixture) {
  await git(f.remote, ['checkout', 'feature']);
  await writeFile(join(f.remote, 'sample.txt'), 'feature\n');
  await git(f.remote, ['commit', '-am', 'feature edit']);
  await git(f.remote, ['checkout', 'main']);
  await writeFile(join(f.remote, 'sample.txt'), 'main\n');
  await git(f.remote, ['commit', '-am', 'main edit']);
  f.control.mainSha = (await git(f.remote, ['rev-parse', 'HEAD'])).stdout.trim();
  f.control.conflictRepair = true;
}

async function publishedPlan(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t, false);
  await divergent(f);
  await f.mention('@patchpawwww /conflict', 100);
  const initialHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  return { f, initialHead, path: statePath(join(f.root, 'data/state'), 'owner/lab', 7) };
}

async function pendingPlan(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t, false);
  await divergent(f);
  f.control.commentStatus = 503;
  await f.mention('@patchpawwww /conflict', 100);
  const initialHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'publication_pending', JSON.stringify(result));
  return { f, initialHead, path: statePath(join(f.root, 'data/state'), 'owner/lab', 7) };
}

test('fresh Conflict publishes one immutable Approval Plan with a bound receipt and retained workspace', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal(f.modelInputs.some(input => input.tools.some((tool: any) => tool.function.name === 'submit_conflict_proposal')), false);
  assert.equal(f.modelInputs[0].tools.some((tool: any) => /mastra_workspace_(edit_file|write_file|execute_command)/.test(tool.function.name)), false);

  const current = await readCurrentApprovalPlan(path);
  assert.equal(current?.plan.status, 'published');
  assert.equal(current?.plan.plan_revision, 1);
  assert.equal(current?.plan.publication?.remote_id, (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.purpose === 'approval_plan')?.item.receipt?.id);
  assert.equal((await readState(path))?.phase, 'awaiting_approval');
  const paused = await readPaused(path);
  assert.equal(paused?.status, 'awaiting_approval');
  assert.ok(paused?.workspace.path);
  await stat(paused!.workspace.path);
});

test('/close followed by a fresh Approval Plan accepts a new /approval', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const oldPlan = (await readCurrentApprovalPlan(path))!;
  const oldWorkspace = oldPlan.plan.workspace_path;

  await f.mention('@patchpawwww /close', 200);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  assert.equal(await readCurrentApprovalPlan(path), null);
  await assert.rejects(stat(approvalPlanDirectory(path)), { code: 'ENOENT' });
  await assert.rejects(stat(oldWorkspace), { code: 'ENOENT' });

  await f.mention('@patchpawwww /conflict', 300);
  const planResult = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(planResult.status, 'awaiting_approval', JSON.stringify(planResult));
  const freshPlan = await readCurrentApprovalPlan(path);
  assert.equal(freshPlan?.plan.status, 'published');
  assert.notEqual(freshPlan?.plan.plan_id, oldPlan.plan.plan_id);
  assert.equal(freshPlan?.plan.plan_revision, 1);
  assert.equal((await readState(path))?.closed_at, undefined);
  assert.equal((await readState(path))?.closed_through_comment_id, 200);

  f.control.conflictRepair = false;
  f.control.approvalRepair = true;
  await f.mention('@patchpawwww /approval', 400);
  const approvalResult = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(approvalResult.status, 'conflict_completed', JSON.stringify(approvalResult));
  const approved = await readCurrentApprovalPlan(path);
  assert.equal(approved?.plan.status, 'approved');
  assert.equal(approved?.approval?.source_comment_id, 400);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim() === initialHead, false);
});

test('an /approval after /close cannot revive the retired Approval Plan', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const oldPlan = (await readCurrentApprovalPlan(path))!;
  const oldWorkspace = oldPlan.plan.workspace_path;
  await f.mention('@patchpawwww /close', 200);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');

  const beforeModel = f.modelInputs.length;
  await f.mention('@patchpawwww /approval', 300);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human', JSON.stringify(result));
  assert.equal(f.modelInputs.length, beforeModel, 'a missing current Plan does not start an Agent turn');
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal(await readCurrentApprovalPlan(path), null);
  await assert.rejects(stat(oldWorkspace), { code: 'ENOENT' });
  assert.equal((await readState(path))?.closed_through_comment_id, 200);
});

test('close cancels a pending generic Approval Plan publication before delayed delivery can revive it', async t => {
  const { f, path } = await pendingPlan(t);
  const pending = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.purpose === 'approval_plan')!;
  assert.equal(pending.item.status, 'pending_retry');
  f.control.commentStatus = 201;
  await f.mention('@patchpawwww /close', 200);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');

  const retired = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.delivery_id === pending.item.delivery_id)!;
  assert.equal(retired.item.status, 'cancelled_stale');
  assert.equal(retired.item.last_error?.code, 'approval_plan_closed');
  assert.equal(retired.item.lifecycle_status, 'finalized');
  const connection = { client: createGitHub(f.config).installation(42), botLogin: 'patchpawwww[bot]' };
  await attemptDelivery(f.root, retired, connection, true);
  await finalizeDelayedDelivery(f.config, retired, connection);
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.delivery_id === pending.item.delivery_id)?.item.status, 'cancelled_stale');
  assert.equal(await readCurrentApprovalPlan(path), null);
  await assert.rejects(stat(approvalPlanDirectory(path)), { code: 'ENOENT' });
});

test('close waits for an in-flight generic Approval Plan POST before deleting its lifecycle', async t => {
  const { f, path } = await pendingPlan(t);
  const pending = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.purpose === 'approval_plan')!;
  const store = await openCommunicationStore(f.root);
  try {
    const sending = await store.claimOutbound(pending.item.delivery_id, new Date().toISOString(),
      new Date(Date.now() + 30_000).toISOString(), true);
    assert.equal(sending?.item.status, 'sending');
  } finally { await closeCommunicationStore(store); }

  f.control.commentStatus = 201;
  await f.mention('@patchpawwww /close', 200);
  const firstClose = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(firstClose.status, 'close_start_unpublished', JSON.stringify(firstClose));
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'stale');
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.delivery_id === pending.item.delivery_id)?.item.status, 'sending');
  assert.ok((await readPaused(path))?.workspace.path, 'the in-flight POST keeps destructive cleanup behind the retry boundary');

  const settled = await openCommunicationStore(f.root);
  try {
    await settled.markOutboundDelivered(pending.item.delivery_id, { id: 901, html_url: 'https://github.com/owner/lab/pull/7#issuecomment-901',
      published_at: new Date().toISOString() });
  } finally { await closeCommunicationStore(settled); }
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  assert.equal(await readCurrentApprovalPlan(path), null);
  await assert.rejects(stat(approvalPlanDirectory(path)), { code: 'ENOENT' });
});

test('a historical closed tombstone retires leftover Approval Plan claims before a fresh comment', async t => {
  const { f, path } = await publishedPlan(t);
  const historicalPlan = (await readCurrentApprovalPlan(path))!;
  const timestamp = new Date().toISOString();
  await updateApprovalPlan(path, historicalPlan.plan.plan_revision, {
    status: 'approved',
    approval: { plan_id: historicalPlan.plan.plan_id, plan_revision: historicalPlan.plan.plan_revision,
      body_sha256: historicalPlan.plan.body_sha256, source_event_id: 'historical-approval-event', source_comment_id: 150,
      author: 'operator', author_association: 'OWNER', accepted_at: timestamp,
      claim_run_id: 'historical-approval-run', phase: 'running', updated_at: timestamp },
  });
  const legacySidecar = `${path}.legacy-approval-plans`;
  await cp(approvalPlanDirectory(path), legacySidecar, { recursive: true });

  await f.mention('@patchpawwww /close', 200);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  assert.equal(await readCurrentApprovalPlan(path), null);
  await cp(legacySidecar, approvalPlanDirectory(path), { recursive: true });
  await rm(legacySidecar, { recursive: true, force: true });
  assert.equal((await readCurrentApprovalPlan(path))?.approval?.phase, 'running');

  await f.mention('@patchpawwww /conflict', 300);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  const freshPlan = await readCurrentApprovalPlan(path);
  assert.equal(freshPlan?.plan.status, 'published');
  assert.notEqual(freshPlan?.plan.plan_id, historicalPlan.plan.plan_id);
  assert.equal(freshPlan?.plan.plan_revision, 1);
  assert.equal(freshPlan?.approval, undefined);
  assert.equal((await readState(path))?.closed_at, undefined);
  assert.equal((await readState(path))?.closed_through_comment_id, 200);
});

test('fresh Approval Plan uses provenance, approved-write context, and Harness-owned commit/push/writeback', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  f.control.conflictRepair = false;
  f.control.approvalRepair = true;
  await f.mention('@patchpawwww /approval', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  const finalHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  assert.equal(result.status, 'conflict_completed', JSON.stringify(result));
  assert.notEqual(finalHead, initialHead);
  const repairCommits = (await git(f.remote, ['log', '--format=%s', `${initialHead}..feature`])).stdout.trim().split('\n')
    .filter(message => message === 'fix: PatchPaw conflict repair');
  assert.equal(repairCommits.length, 1);
  assert.equal(finalHead, (result as any).final_head_sha);
  assert.equal((await readState(path))?.phase, 'conflict_completed');
  assert.equal((await readState(path))?.current_head_sha, finalHead);
  assert.equal((await readState(path))?.last_patchpaw_commit, finalHead);
  const plan = await readCurrentApprovalPlan(path);
  assert.equal(plan?.plan.status, 'approved');
  assert.equal(plan?.approval?.source_comment_id, 800);
  assert.equal(plan?.approval?.phase, 'completed');
  assert.match(JSON.stringify(f.modelInputs.at(-2)?.messages), /用户批准了你的计划/);
  assert.equal(f.modelInputs.some(input => input.tools.some((tool: any) => /git_push|git_commit/.test(tool.function.name))), false);
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'delivery_report').length, 1);
});

test('generic Approval Plan publication retry finalizes the same receipt without an Agent turn', async t => {
  const { f, initialHead, path } = await pendingPlan(t);
  const beforeModel = f.modelInputs.length;
  const pending = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.purpose === 'approval_plan');
  assert.ok(pending);
  f.control.commentStatus = 201;
  const connection = { client: createGitHub(f.config).installation(42), botLogin: 'patchpawwww[bot]' };
  const retried = await attemptDelivery(f.root, pending!, connection, true);
  assert.equal(retried?.item.status, 'delivered');
  const delivered = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.delivery_id === pending!.item.delivery_id)!;
  assert.equal(delivered.item.lifecycle_status, 'pending', 'the delivered Plan still needs lifecycle finalization');
  await finalizeDelayedDelivery(f.config, delivered, connection);
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'published');
  assert.equal((await readState(path))?.phase, 'awaiting_approval');
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 }))
    .find(value => value.item.delivery_id === pending!.item.delivery_id)?.item.lifecycle_status, 'finalized');
});

test('generic Approval Plan never reuses a superseded revision claim for the new revision', async t => {
  const { path } = await publishedPlan(t);
  const current = (await readCurrentApprovalPlan(path))!;
  const acceptedAt = new Date().toISOString();
  await updateApprovalPlan(path, current.plan.plan_revision, {
    status: 'approved',
    approval: { plan_id: current.plan.plan_id, plan_revision: current.plan.plan_revision, body_sha256: current.plan.body_sha256,
      source_event_id: 'old-approval-event', source_comment_id: 800, author: 'operator', author_association: 'OWNER',
      accepted_at: acceptedAt, claim_run_id: 'old-approval-run', phase: 'running', updated_at: acceptedAt },
  });
  const { publication: _publication, status: _status, body_sha256: _bodyHash, schema_version: _schema, ...immutable } = current.plan;
  const replacement = createApprovalPlan({ ...immutable, plan_revision: current.plan.plan_revision + 1,
    run_id: 'replacement-run', execution_id: current.plan.execution_id + 1, body: '新的自然语言计划。', status: 'published' });
  await updateApprovalPlan(path, current.plan.plan_revision, { status: 'superseded' });
  await saveApprovalPlan(path, replacement);

  assert.equal((await readApprovalPlan(path, current.plan.plan_revision))?.status, 'superseded');
  assert.equal((await readApprovalPlanClaim(path, current.plan.plan_revision))?.plan_revision, current.plan.plan_revision);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.plan_revision, replacement.plan_revision);
  assert.equal(await readUnfinishedApprovalPlanClaim(path), null);
});

test('generic Approval Plan rejects bot approval without changing the plan or starting an Agent', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const beforeModel = f.modelInputs.length;
  await saveHumanReply(path, { repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 800,
    author: 'patchpawwww[bot]', author_association: 'BOT', source_event_id: 'fixture-bot-approval',
    body: '@patchpawwww /approval', url: 'https://github.com/owner/lab/pull/7#issuecomment-800' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human');
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'published');
  assert.match(String((result as any).reason), /Bot|bot/);
});

test('generic Approval Plan fails closed for fork writeback before Agent or remote mutation', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const beforeModel = f.modelInputs.length;
  f.control.prHeadRepo = 'fork/source';
  await f.mention('@patchpawwww /approval', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale');
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'stale');
});

test('generic Approval Plan marks workspace drift stale before approved write', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const paused = (await readPaused(path))!;
  await writeFile(join(paused.workspace.path, 'sample.txt'), 'external mutation\n');
  const beforeModel = f.modelInputs.length;
  await f.mention('@patchpawwww /approval', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale');
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'stale');
});

test('generic Approval Plan marks base drift stale instead of applying an old approval', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  await writeFile(join(f.remote, 'current-base-only.txt'), 'new base\n');
  await git(f.remote, ['add', '.']);
  await git(f.remote, ['commit', '-m', 'advance current base']);
  f.control.mainSha = (await git(f.remote, ['rev-parse', 'main'])).stdout.trim();
  const beforeModel = f.modelInputs.length;
  await f.mention('@patchpawwww /approval', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale');
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'stale');
});

test('generic Approval Plan marks PR head drift stale instead of applying an old approval', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  await git(f.remote, ['checkout', 'feature']);
  await writeFile(join(f.remote, 'head-drift.txt'), 'new head\n');
  await git(f.remote, ['add', '.']);
  await git(f.remote, ['commit', '-m', 'advance PR head']);
  await git(f.remote, ['checkout', 'main']);
  const beforeModel = f.modelInputs.length;
  await f.mention('@patchpawwww /approval', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale');
  assert.equal(f.modelInputs.length, beforeModel);
  assert.notEqual((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'stale');
});

test('generic Approval Plan /stop preserves the published plan and retained workspace without a model turn', async t => {
  const { f, initialHead, path } = await publishedPlan(t);
  const beforeModel = f.modelInputs.length;
  await f.mention('@patchpawwww /stop', 800);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stopped', JSON.stringify(result));
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), initialHead);
  assert.equal((await readCurrentApprovalPlan(path))?.plan.status, 'published');
  assert.equal((await readPaused(path))?.status, 'awaiting_approval');
});

test('historical conflict proposal payloads remain readable only as explicit legacy compatibility', () => {
  const draft = { summary: '历史提案', pr_intent: '保留 PR 行为', current_base_intent: '保留 base 行为',
    conflicts: [{ path: 'sample.txt', issue: '同一行冲突', pr_side: 'feature', base_side: 'main', proposed_resolution: '人工确认', disagreement_or_tradeoff: '语义取舍' }],
    affected_files: ['sample.txt'], verification_plan: ['test -f sample.txt'], risks_or_open_questions: [], human_markdown_summary: '历史结构化提案。' };
  const basis = { pr_head_sha: 'a'.repeat(40), pr_head_ref: 'feature', pr_head_repo: 'owner/lab', current_base_tip_sha: 'b'.repeat(40), base_ref: 'main',
    workspace_evidence_sha256: 'c'.repeat(64), command_snapshot_id: 'legacy-snapshot', command_snapshot_sha256: 'd'.repeat(64) };
  const current = createConflictProposal({ draft, proposalRevision: 1, executionId: 'legacy-execution', runId: 'legacy-run', basis });
  const historical = structuredClone(current) as any;
  delete historical.repair_run_id;
  delete historical.basis.pr_head_ref;
  delete historical.basis.pr_head_repo;
  historical.proposal_hash = conflictProposalHash(historical);
  assert.doesNotThrow(() => validateConflictProposal(historical));
});
