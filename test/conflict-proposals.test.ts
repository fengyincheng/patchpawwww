import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers/pr-fixture.ts';
import { git } from '../src/workspace/git.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { readPaused } from '../src/runner/resume.ts';
import { readState, statePath, writeState } from '../src/runner/state.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { attemptDelivery, listOutbound } from '../src/runner/outbound.ts';
import { finalizeDelayedDelivery } from '../src/runner/communication-scheduler.ts';
import {
  conflictProposalCurrentPath, conflictProposalVersionPath, readCurrentConflictProposal,
  reconcileConflictProposalPublication,
} from '../src/runner/conflict-proposals.ts';
import { listConflictApprovals } from '../src/runner/conflict-approval.ts';
import { createGitHub } from '../src/github/client.ts';
import { bootstrapControlPlane, getCommandByName, getRepositoryByName, openControlPlaneDb, updateCommand } from '../src/control-plane/index.ts';

async function divergent(f: Awaited<ReturnType<typeof fixture>>) {
  await git(f.remote, ['checkout', 'feature']); await writeFile(join(f.remote, 'sample.txt'), 'feature\n');
  await git(f.remote, ['commit', '-am', 'feature edit']);
  await git(f.remote, ['checkout', 'main']); await writeFile(join(f.remote, 'sample.txt'), 'main\n');
  await git(f.remote, ['commit', '-am', 'main edit']);
  f.control.mainSha = (await git(f.remote, ['rev-parse', 'HEAD'])).stdout.trim();
  f.control.conflictRepair = true;
}

test('Conflict publishes an immutable read-only proposal and retains the real merge workspace', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict');
  const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'awaiting_approval');
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal(f.calls.some(call => call.path.endsWith('/reviews')), false);
  assert.equal(f.calls.some(call => call.path.endsWith('/check-runs')), false);
  assert.ok(f.modelInputs[0].tools.some((tool: any) => tool.function.name === 'submit_conflict_proposal'));
  assert.equal(f.modelInputs[0].tools.some((tool: any) => /edit_file|write_file|execute_command|git_add|git_commit|git_push/.test(tool.function.name)), false);

  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  const state = (await readState(path))!;
  assert.equal(state.phase, 'awaiting_approval'); assert.equal(state.active, false);
  assert.equal((await readPaused(path))?.status, 'awaiting_approval');
  const current = (await readCurrentConflictProposal(path))!;
  assert.equal(current.proposal.status, 'published'); assert.equal(current.pointer.status, 'published');
  assert.equal(current.proposal.proposal_revision, 1);
  assert.equal(JSON.parse(await readFile(conflictProposalCurrentPath(path), 'utf8')).proposal_revision, 1);
  assert.equal(JSON.parse(await readFile(conflictProposalVersionPath(path, 1), 'utf8')).status, 'draft', 'immutable version is not rewritten by publication');
  const outbound = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_proposal');
  assert.equal(outbound.length, 1); assert.equal(outbound[0].item.status, 'delivered'); assert.equal(outbound[0].item.lifecycle_status, 'finalized');
  assert.match(f.publishedComments[0].body, /PR 意图/); assert.match(f.publishedComments[0].body, /\/approval/);
  assert.ok((await stat(join(f.root, 'workspaces', result.run_id!))).isDirectory(), 'awaiting approval keeps the retained workspace');
});

test('Conflict discussion can publish a superseding revision without granting write capability', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  const retained = (await readPaused(path))!;
  f.control.conflictRevision = true; await f.mention('@patchpawwww 我不同意这个取舍', 101);
  const second = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(second.status, 'awaiting_approval');
  const current = (await readCurrentConflictProposal(path))!;
  assert.equal(current.proposal.proposal_revision, 2); assert.equal(current.proposal.status, 'published');
  assert.equal((await readCurrentConflictProposal(path))!.proposal.proposal_id,
    JSON.parse(await readFile(conflictProposalVersionPath(path, 1), 'utf8')).proposal_id);
  assert.equal((await readPaused(path))?.workspace.path, retained.workspace.path);
  const old = JSON.parse(await readFile(join(`${path}.conflict-proposals`, 'conflict-proposal-v1.status.json'), 'utf8'));
  assert.equal(old.status, 'superseded');
  const outbound = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_proposal');
  assert.equal(outbound.length, 2); assert.equal(new Set(outbound.map(value => value.item.semantic_key)).size, 2);
  assert.equal(f.modelInputs.at(-1).tools.some((tool: any) => /edit_file|write_file|execute_command|git_add|git_commit|git_push/.test(tool.function.name)), false);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal(current.proposal.repair_execution_id, JSON.parse(await readFile(conflictProposalVersionPath(path, 1), 'utf8')).repair_execution_id);
  assert.equal(current.proposal.repair_run_id, JSON.parse(await readFile(conflictProposalVersionPath(path, 1), 'utf8')).repair_run_id);
  assert.ok(current.proposal.discussion_execution_id); assert.ok(current.proposal.discussion_snapshot_id); assert.ok(current.proposal.discussion_snapshot_sha256);
});

test('Read-only Conflict still analyzes and publishes a proposal but cannot become approval-capable', async t => {
  const f = await fixture(t, false); await divergent(f);
  await bootstrapControlPlane({ root: f.root, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(f.root);
  try {
    const repository = await getRepositoryByName(db, 'owner/lab'); const command = await getCommandByName(db, repository!.id, 'conflict');
    await updateCommand(db, command!.id, { permission: 'read_only' }, { expectedRevision: command!.revision });
  } finally { db.close(); }
  await f.mention('@patchpawwww /conflict', 100);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'awaiting_approval'); assert.equal(f.modelInputs.length, 1);
  assert.ok(f.modelInputs[0].tools.some((tool: any) => tool.function.name === 'submit_conflict_proposal'));
  await f.mention('@patchpawwww /approval', 101);
  const approval = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(approval.status, 'needs_human'); assert.equal(f.modelInputs.length, 1);
  assert.match(f.publishedComments.at(-1)?.body ?? '', /Read \+ Write|command_read_only|不会升级权限/);
});

test('/approval claims the published proposal and runs the original snapshot through verified repair', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeModel = f.modelInputs.length;
  const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  f.control.conflictRepair = false; f.control.approvalRepair = true;
  await f.mention('@patchpawwww /approval', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'repair_completed'); assert.equal(f.modelInputs.length, beforeModel + 2);
  assert.notEqual((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal((await readPaused(path))?.status, 'completed');
  assert.equal((await readState(path))?.conflict_proposal?.status, 'published');
  const approvals = await listConflictApprovals(path);
  assert.equal(approvals.length, 1); assert.equal(approvals[0].status, 'accepted');
  assert.equal(approvals[0].phase, 'completed'); assert.ok(approvals[0].commit_sha); assert.ok(approvals[0].final_publication_remote_id);
  const repairOutbound = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_repair');
  assert.equal(repairOutbound.length, 1); assert.equal(repairOutbound[0].item.lifecycle_status, 'finalized');
  assert.equal(f.modelInputs.at(-2).tools.some((tool: any) => /git_push|git_commit/.test(tool.function.name)), false, 'model never receives Git publication tools');
});

test('/approval rejects an unqualified actor without changing the proposal or invoking repair', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  const beforeModel = f.modelInputs.length; const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  await saveHumanReply(path, { repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 101, author: 'outsider',
    author_association: 'NONE', source_event_id: 'fixture-delivery-101', body: '@patchpawwww /approval', url: 'https://github.com/owner/lab/pull/7#issuecomment-101' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal((await readCurrentConflictProposal(path))?.proposal.status, 'published');
  const approval = (await listConflictApprovals(path))[0];
  assert.equal(approval.status, 'rejected'); assert.equal(approval.rejection_code, 'unauthorized_actor');
});

test('an approved repair refuses a fork head instead of pushing through the base repository origin', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeModel = f.modelInputs.length;
  const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  f.control.prHeadRepo = 'fork/source';
  await f.mention('@patchpawwww /approval', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal((await readCurrentConflictProposal(path))?.proposal.status, 'published');
});

test('/approval marks a changed retained workspace stale before any model or Git write', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), paused = (await readPaused(path))!;
  await writeFile(join(paused.workspace.path, 'sample.txt'), 'external mutation\n');
  const beforeModel = f.modelInputs.length; const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  await f.mention('@patchpawwww /approval', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal((await readCurrentConflictProposal(path))?.proposal.status, 'stale');
  const approval = (await listConflictApprovals(path))[0];
  assert.equal(approval.status, 'stale'); assert.equal(approval.rejection_code, 'workspace_changed');
});

test('an approval event created before the current proposal revision cannot approve v2', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  f.control.conflictRevision = true; await f.mention('@patchpawwww 请修订提案', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'awaiting_approval');
  const beforeModel = f.modelInputs.length;
  await saveHumanReply(path, { repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 102, author: 'owner',
    author_association: 'OWNER', source_event_id: 'fixture-delivery-102', created_at: '2026-01-01T00:00:00.000Z', body: '@patchpawwww /approval',
    url: 'https://github.com/owner/lab/pull/7#issuecomment-102' });
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'needs_human'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await readCurrentConflictProposal(path))?.proposal.proposal_revision, 2);
  assert.equal((await readCurrentConflictProposal(path))?.proposal.status, 'published');
  assert.equal((await listConflictApprovals(path))[0].rejection_code, 'proposal_not_current');
});

test('approval publication recovery finalizes the existing outbox without another model turn or push', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  f.control.conflictRepair = false; f.control.approvalRepair = true; f.control.commentStatus = 503;
  await f.mention('@patchpawwww /approval', 101);
  const pending = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(pending.status, 'publication_pending');
  const headAfterPush = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  assert.notEqual(headAfterPush, beforeHead);
  const beforeRecoveryModel = f.modelInputs.length;
  assert.equal((await listConflictApprovals(path))[0].phase, 'publication_pending');
  f.control.commentStatus = 201;
  const recovered = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(recovered.status, 'repair_completed'); assert.equal(f.modelInputs.length, beforeRecoveryModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), headAfterPush);
  assert.equal((await listConflictApprovals(path))[0].phase, 'completed');
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_repair').length, 1);
});

test('the communication scheduler mechanically finalizes a delivered Conflict repair', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  f.control.conflictRepair = false; f.control.approvalRepair = true; f.control.commentStatus = 503; await f.mention('@patchpawwww /approval', 101);
  const pending = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(pending.status, 'publication_pending');
  const pendingItem = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_repair')!;
  f.control.commentStatus = 201;
  const delivered = await attemptDelivery(f.root, pendingItem, { client: createGitHub(f.config).installation(42), botLogin: 'patchpawwww[bot]' }, true);
  assert.equal(delivered?.item.status, 'delivered');
  const deliveredItem = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_repair')!;
  await finalizeDelayedDelivery(f.config, deliveredItem);
  assert.equal((await readState(path))?.phase, 'repair_completed');
  assert.equal((await listConflictApprovals(path))[0].phase, 'completed');
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_repair')?.item.lifecycle_status, 'finalized');
  await assert.rejects(stat(join(f.root, 'workspaces', pending.run_id!)));
});

test('/close retires a delivered Conflict repair before deleting its local evidence', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  f.control.conflictRepair = false; f.control.approvalRepair = true; f.control.commentStatus = 503;
  await f.mention('@patchpawwww /approval', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'publication_pending');
  const pending = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_repair')!;
  f.control.commentStatus = 201;
  const delivered = await attemptDelivery(f.root, pending, { client: createGitHub(f.config).installation(42), botLogin: 'patchpawwww[bot]' }, true);
  assert.equal(delivered?.item.status, 'delivered');
  await f.mention('@patchpawwww /close', 102);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'closed');
  const approval = (await listConflictApprovals(path))[0];
  assert.equal(approval.status, 'stale'); assert.equal(approval.phase, 'interrupted'); assert.equal(approval.rejection_code, 'approval_after_close');
  assert.equal((await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_repair')?.item.lifecycle_status, 'finalized');
  assert.equal((await readState(path))?.phase, 'closed');
});

test('/close cancels an unpublished Conflict proposal before its ordered start notice', async t => {
  const f = await fixture(t, false); await divergent(f); f.control.commentStatus = 503;
  await f.mention('@patchpawwww /conflict', 100);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'publication_pending');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  f.control.commentStatus = 201; await f.mention('@patchpawwww /close', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'closed', JSON.stringify(result));
  const proposal = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).find(value => value.item.purpose === 'conflict_proposal')!;
  assert.equal(proposal.item.status, 'cancelled_stale'); assert.equal(proposal.item.lifecycle_status, 'finalized');
  assert.equal((await readState(path))?.phase, 'closed');
  assert.equal(f.publishedComments.some(comment => /Conflict Proposal/.test(comment.body)), false);
});

test('/stop recognizes an awaiting Conflict Proposal without calling the model or releasing its workspace', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeModel = f.modelInputs.length;
  const beforeHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  await f.mention('@patchpawwww /stop', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stopped'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await git(f.remote, ['rev-parse', 'feature'])).stdout.trim(), beforeHead);
  assert.equal((await readPaused(path))?.status, 'awaiting_approval');
  assert.equal((await readState(path))?.conflict_proposal?.status, 'published');
});

test('a transient publication failure retries the same outbox item and proposal version', async t => {
  const f = await fixture(t, false); await divergent(f); f.control.commentStatus = 503;
  await f.mention('@patchpawwww /conflict', 100);
  const first = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(first.status, 'publication_pending');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  const pending = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_proposal');
  assert.equal(pending.length, 1); assert.equal(pending[0].item.status, 'pending_retry');
  assert.equal((await readCurrentConflictProposal(path))!.proposal.proposal_revision, 1);

  f.control.commentStatus = 201;
  const retried = await attemptDelivery(f.root, pending[0], { client: createGitHub(f.config).installation(42), botLogin: 'patchpawwww[bot]' }, true);
  assert.equal(retried?.item.status, 'delivered');
  await reconcileConflictProposalPublication(f.root, path, 'owner/lab', 7);
  const delivered = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_proposal');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].item.lifecycle_status, 'finalized');
  assert.equal((await readCurrentConflictProposal(path))!.proposal.proposal_revision, 1);
  assert.equal((await readPaused(path))?.status, 'awaiting_approval');
  assert.equal(f.publishedComments.length, 1);
});

test('a restart reconciliation restores awaiting_approval from a delivered receipt without a model turn', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), state = (await readState(path))!;
  await writeState(path, { ...state, phase: 'publication_pending', conflict_proposal: { ...state.conflict_proposal!, status: 'publication_pending' } });
  const beforeModel = f.modelInputs.length;
  await reconcileConflictProposalPublication(f.root, path, 'owner/lab', 7);
  assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await readState(path))?.phase, 'awaiting_approval');
  assert.equal((await readState(path))?.conflict_proposal?.status, 'published');
  assert.equal((await readPaused(path))?.status, 'awaiting_approval');
});

test('superseding a pending proposal cancels its old outbox item before publishing the revision', async t => {
  const f = await fixture(t, false); await divergent(f); f.control.commentStatus = 503;
  await f.mention('@patchpawwww /conflict', 100);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'publication_pending');
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7);
  f.control.commentStatus = 201; f.control.conflictRevision = true; await f.mention('@patchpawwww 请修订提案', 101);
  assert.equal((await runPullRequest(f.config, 'owner/lab', 7)).status, 'awaiting_approval');
  const outbound = (await listOutbound(f.root, { repo: 'owner/lab', prNumber: 7 })).filter(value => value.item.purpose === 'conflict_proposal');
  assert.equal(outbound.length, 2); assert.equal(outbound[0].item.status, 'cancelled_stale'); assert.equal(outbound[0].item.lifecycle_status, 'finalized');
  assert.equal(f.publishedComments.length, 1); assert.match(f.publishedComments[0].body, /v2/);
});

test('external retained-workspace changes stale discussion before a model turn', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeModel = f.modelInputs.length;
  const paused = (await readPaused(path))!;
  await writeFile(join(paused.workspace.path, 'sample.txt'), 'external mutation\n');
  await f.mention('@patchpawwww 请讨论刚才的提案', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await readCurrentConflictProposal(path))!.proposal.status, 'stale');
  assert.equal((await readPaused(path))?.status, 'stale');
});

test('a changed current base makes a pending Conflict proposal stale instead of discussing or revising it', async t => {
  const f = await fixture(t, false); await divergent(f); await f.mention('@patchpawwww /conflict', 100);
  await runPullRequest(f.config, 'owner/lab', 7);
  const path = statePath(join(f.root, 'data/state'), 'owner/lab', 7), beforeModel = f.modelInputs.length;
  await writeFile(join(f.remote, 'current-base-only.txt'), 'new base\n'); await git(f.remote, ['add', '.']); await git(f.remote, ['commit', '-m', 'advance current base']);
  f.control.mainSha = (await git(f.remote, ['rev-parse', 'main'])).stdout.trim();
  await f.mention('@patchpawwww 请讨论刚才的提案', 101);
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'stale'); assert.equal(f.modelInputs.length, beforeModel);
  assert.equal((await readCurrentConflictProposal(path))!.proposal.status, 'stale');
  assert.equal((await readPaused(path))?.status, 'stale');
  assert.match(f.publishedComments.at(-1)?.body ?? '', /重新发送 \/conflict/);
});
