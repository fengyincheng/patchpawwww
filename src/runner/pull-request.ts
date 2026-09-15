import { watchStop, TaskStopped } from './stop.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import type { PRTask, ParsedIntent } from './command.ts';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createGitHub } from '../github/client.ts';
import { capturePullRequest, assertCurrentPR, installationGitToken, type InspectedPR } from '../github/pull-request.ts';
import { waitForCI, failureEvidence } from '../github/ci.ts';
import { prepareWorkspace, commitRepair, pushRepair } from '../workspace/manager.ts';
import { ensureRepo, fetchPRState, createWorktree, disposeWorkspacePath, runWorkspacePath, isManagedWorktree } from '../workspace/repo-store.ts';
import { git, gitAuth } from '../workspace/git.ts';
import { Trace } from '../harness/trace.ts';
import { providerError } from '../harness/retry.ts';
import { seedContext } from '../harness/context/seed.ts';
import { excerpt } from '../harness/context/policy.ts';
import { budget } from '../harness/budget.ts';
import { runConflict } from '../tasks/conflict/agent.ts';
import { runCIRepair } from '../tasks/ci-repair/agent.ts';
import { runReview } from '../tasks/review/agent.ts';
import { claimRun, statePath, writeState, readState, workerStatus, type RunState } from './state.ts';
import { completeReview, readArtifact, reviewCheckpoint, needsReviewRecovery } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { OPERATION_PROMPT_VERSION } from '../operation/load.ts';
import { recoverLockedRun, reviewConnection } from './recovery.ts';
import { humanFeedback, hasHumanReplies, readHumanReplies } from './human-feedback.ts';
import { parsePRIntent, parsePRTask } from './command.ts';
import { prepareCloseStart, preparePendingCloseStart, runClose, retryPendingCloseCompletion, hasPendingClose, resumePendingClose, closeRefusalBody } from './close.ts';
import { HumanHelpRequested } from '../tasks/human-help.ts';
import { runNoticeBody, type HumanReply } from '../github/comments.ts';
import { runConversation } from '../tasks/conversation/agent.ts';
import { runCustom } from '../tasks/custom/agent.ts';
import { runRepair } from '../tasks/repair.ts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { captureConflictWorkspaceEvidence, captureExecutionBaseline, compareConflictWorkspaceEvidence, workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { stopEvidence } from './stop-evidence.ts';
import { resumeWorkspace, retainWorkspace, readPaused, savePaused } from './resume.ts';
import { prThreadId } from '../harness/pr-memory.ts';
import { closeoutMarker } from './closeout-publication.ts';
import { deferDelivery, deliverImmediately, enqueueAndDeliverComment, enqueueCommentDelivery, finalizeDelivery, listOutbound, OutboundPending, requeueOldestBlockedDelivery } from './outbound.ts';
import { hasRunnableWork } from './runnable.ts';
import { bootstrapControlPlane, getCommand, getRepositoryByName, openControlPlaneDb, resolveExecution, writeCommandSnapshot, validateCommandSnapshot, snapshotSha256 } from '../control-plane/index.ts';
import type { CommandSnapshot } from '../control-plane/snapshots.ts';
import type { ControlPlaneDb } from '../control-plane/db.ts';
import { runtimeExecutionFromSnapshot, type RuntimeExecution } from '../harness/runtime.ts';
import { classifyRunFailure, terminalStatusForFailure, type RunFailure } from './failures.ts';
import { loadOrReconstructLegacySnapshot } from './legacy-snapshot.ts';
import {
  CONFLICT_APPROVAL_ENABLED, cancelConflictProposalPublication, createConflictProposal, markConflictProposalStatus, markCurrentConflictProposalStale,
  proposalDeliverySemanticKey, proposalPublicationFromOutbound, proposalPointerForState, readCurrentConflictProposal,
  reconcileConflictProposalPublication, renderConflictProposal, saveConflictProposal, saveProposalState,
  type ConflictProposal,
} from './conflict-proposals.ts';
import {
  approvalDeliverySemanticKey, isUnfinishedConflictApproval, newConflictApproval, readConflictApprovalByIdempotency,
  readUnfinishedConflictApproval, saveConflictApproval, updateConflictApproval, type ConflictApprovalRecord,
} from './conflict-approval.ts';
import type { ConflictApprovalRejectionCode } from './conflict-approval.ts';
import { runGitLabMergeRequest } from '../scm/gitlab/runner.ts';

const APPROVAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

class ConflictApprovalRejected extends Error {
  constructor(readonly code: ConflictApprovalRejectionCode, message: string) { super(message); this.name = 'ConflictApprovalRejected'; }
}

function rejectApproval(code: ConflictApprovalRejectionCode, message: string): never {
  throw new ConflictApprovalRejected(code, message);
}

const CONFLICT_REPAIR_VERIFICATION_EVIDENCE = 'conflict-repair-verification-evidence.json';
const CONFLICT_REPAIR_COMMIT_EVIDENCE = 'conflict-repair-commit-evidence.json';

function sameRepairCandidateContent(previous: ConflictWorkspaceEvidence, current: ConflictWorkspaceEvidence) {
  const fields: (keyof ConflictWorkspaceEvidence)[] = [
    'repository', 'pr_number', 'pr_head_sha', 'historical_base_sha', 'current_base_tip_sha', 'base_ref',
    'initial_head', 'merge_base', 'unresolved_paths', 'pr_diff_paths', 'current_base_affected_paths', 'files',
  ];
  return fields.every(field => JSON.stringify(previous[field]) === JSON.stringify(current[field]));
}

function committedRepairCandidate(previous: ConflictWorkspaceEvidence, current: ConflictWorkspaceEvidence, expectedHead?: string) {
  return sameRepairCandidateContent(previous, current)
    && current.workspace_head !== previous.workspace_head
    && (!expectedHead || current.workspace_head === expectedHead)
    && !current.git_status_porcelain_v2.trim() && !current.git_index.trim() && !current.git_unmerged_index.trim()
    && current.merge_head === null && !current.merge_pending;
}

async function loadConflictApprovalSnapshot(root: string, proposal: ConflictProposal): Promise<{ snapshot: CommandSnapshot; hash: string; path: string }> {
  const path = join(patchpawPaths(root).runs, proposal.repair_run_id, 'command-snapshot.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') rejectApproval('snapshot_missing', 'Conflict Proposal 绑定的 Command Snapshot 不存在；旧工作区与证据保留，请重新发送 /conflict。');
    rejectApproval('snapshot_corrupt', 'Conflict Proposal 绑定的 Command Snapshot 无法安全读取；旧工作区与证据保留，请重新发送 /conflict。');
  }
  const allowLegacy = (raw as { schema_version?: string })?.schema_version?.endsWith('legacy-v1') ?? false;
  let snapshot: CommandSnapshot;
  try { snapshot = validateCommandSnapshot(raw, { allowLegacy }); }
  catch { rejectApproval('snapshot_corrupt', 'Conflict Proposal 绑定的 Command Snapshot 校验失败；不会套用当前配置，请重新发送 /conflict。'); }
  const hash = snapshotSha256(snapshot);
  if (hash !== proposal.basis.command_snapshot_sha256 || snapshot.snapshot_id !== proposal.basis.command_snapshot_id
      || snapshot.execution_id !== proposal.repair_execution_id) {
    rejectApproval('snapshot_hash_mismatch', 'Conflict Proposal 的 Command Snapshot id/hash 不一致；不会使用最新配置替代原快照，请重新发送 /conflict。');
  }
  if (snapshot.template_type !== 'conflict' || snapshot.target !== 'command' || snapshot.command?.permission !== 'read_write') {
    rejectApproval('command_read_only', 'Conflict Proposal 的原始命令快照不是 Read + Write；审批不会升级权限或启动修复。');
  }
  return { snapshot, hash, path };
}

async function readConflictEvidence(root: string, proposal: ConflictProposal) {
  const artifact = await readArtifact(join(patchpawPaths(root).runs, proposal.repair_run_id), 'workspace-evidence.json') as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
  if (!artifact?.evidence_sha256) rejectApproval('workspace_missing', 'Conflict Proposal 的 WorkspaceEvidence 缺失；不会在未知工作区上修复，请重新发送 /conflict。');
  const { evidence_sha256, ...evidence } = artifact;
  if (evidence_sha256 !== proposal.basis.workspace_evidence_sha256 || workspaceEvidenceSha256(evidence) !== proposal.basis.workspace_evidence_sha256) {
    rejectApproval('workspace_changed', 'Conflict Proposal 的 WorkspaceEvidence hash 不一致；工作区可能被外部修改，请重新发送 /conflict。');
  }
  return evidence;
}

function qualifiedApprovalActor(reply: Pick<HumanReply, 'author' | 'author_association'>, botLogin: string) {
  if (reply.author.toLowerCase() === botLogin.toLowerCase() || reply.author.toLowerCase().endsWith('[bot]')) return false;
  return reply.author_association !== undefined && APPROVAL_ASSOCIATIONS.has(reply.author_association.toUpperCase());
}

function isApprovalComment(body: string) {
  return /^\s*@[^\s]+\s+\/(?:approval|approve)(?=$|\s)/i.test(body);
}

async function prepareConflictApproval(input: {
  root: string; statePath: string; repo: string; prNumber: number; runId: string; botLogin: string;
  trace: Trace; state: RunState; pr: InspectedPR; currentBase: { ref: string; sha: string };
  retained: Awaited<ReturnType<typeof readPaused>>; current: Awaited<ReturnType<typeof readCurrentConflictProposal>>;
  reply?: HumanReply; recovery?: ConflictApprovalRecord; controlPlane: ControlPlaneDb;
}): Promise<{ record: ConflictApprovalRecord; proposal: ConflictProposal; snapshot: CommandSnapshot; evidence: ConflictWorkspaceEvidence } | { rejected: ConflictApprovalRejected }> {
  const { root, statePath, repo, prNumber, runId, botLogin, trace, state, pr, currentBase, retained, current, reply, recovery, controlPlane } = input;
  try {
    if (pr.pr.state !== 'open') rejectApproval('pr_closed', 'PR 已关闭；迟到的 /approval 不会复活已退休的本地 generation。');
    if (reply && (!reply.source_event_id || !reply.author_association)) rejectApproval('approval_event_invalid', 'Approval 必须来自已验证的 GitHub webhook，并带有 source event 与 author_association；不会把本地缺失 provenance 的评论当作授权。');
    if (reply && !qualifiedApprovalActor(reply, botLogin)) rejectApproval('unauthorized_actor', '该 /approval 评论者没有 OWNER、MEMBER 或 COLLABORATOR 审批资格。');
    if (!current) rejectApproval('no_pending_proposal', '没有可审批的 Conflict Proposal；请先发送 /conflict。');
    const proposal = current.proposal;
    if (!proposal.basis.pr_head_ref || !proposal.basis.pr_head_repo
        || proposal.basis.pr_head_ref !== pr.pr.head.ref || proposal.basis.pr_head_repo.toLowerCase() !== repo.toLowerCase()) {
      rejectApproval('git_facts_changed', 'Approval 绑定的 PR 来源分支或仓库已变化；旧 Proposal 不会套用到新的 head target，请重新发送 /conflict。');
    }
    if (current.pointer.proposal_revision !== proposal.proposal_revision || current.pointer.proposal_hash !== proposal.proposal_hash) {
      rejectApproval('proposal_not_current', '审批对象不是当前 Proposal 版本；旧版本不能自动批准新版本。请重新发送 /conflict。');
    }
    if (proposal.status === 'stale' || proposal.status === 'superseded') rejectApproval('proposal_stale', '当前 Conflict Proposal 已过期或被新版本取代；请重新发送 /conflict。');
    if (proposal.status !== 'published' || !proposal.publication?.delivery_id) rejectApproval('proposal_not_published', '当前 Conflict Proposal 尚未成功发布；发布 receipt 确认前不会进入修复。');
    if (reply && proposal.publication.remote_id !== undefined && reply.comment_id <= proposal.publication.remote_id) {
      rejectApproval('proposal_not_current', '该审批评论早于当前已发布 Proposal，不能把旧审批套用到新版本。请对当前版本重新发送 /approval。');
    }
    if (reply?.created_at) {
      const createdAt = Date.parse(reply.created_at);
      if (!Number.isFinite(createdAt)) rejectApproval('approval_event_invalid', 'Approval 评论的 created_at 不是有效 RFC 3339 时间；不会猜测其对应的 Proposal 版本。');
      const publishedAt = proposal.publication.published_at ? Date.parse(proposal.publication.published_at) : NaN;
      if (Number.isFinite(publishedAt) && createdAt <= publishedAt) {
        rejectApproval('proposal_not_current', '该审批评论早于当前已发布 Proposal，不能把旧审批套用到新版本。请对当前版本重新发送 /approval。');
      }
    }
    if (!retained || !['awaiting_approval', 'claimed', 'repairing', 'needs_human', 'budget_exhausted', 'stopped', 'publication_pending'].includes(retained.status)
        || retained.task !== 'conflict' || retained.run_id !== proposal.repair_run_id || retained.workspace.path !== current.pointer.workspace_path
        || basename(retained.workspace.path) !== proposal.repair_run_id
        || retained.base_ref !== proposal.basis.base_ref || retained.workspace.initialHead !== proposal.basis.pr_head_sha
        || retained.workspace.mainSha !== proposal.basis.current_base_tip_sha
        || !await isManagedWorktree(root, repo, retained.workspace.path, undefined, trace)) {
      rejectApproval('workspace_missing', '原 Conflict retained workspace 缺失、路径不受 PatchPaw 管理或不是当前 Proposal 所指向的工作区；请重新发送 /conflict。');
    }
    if (state.phase === 'closed' || state.closed_at) rejectApproval('approval_after_close', '该 PR 的本地 generation 已 closed；迟到 /approval 不会复活它。');

    const snapshotInfo = await loadConflictApprovalSnapshot(root, proposal);
    const command = snapshotInfo.snapshot.command ? await getCommand(controlPlane, snapshotInfo.snapshot.command.id) : undefined;
    if (!command) rejectApproval('command_missing', 'Conflict Command 已被删除或不再可用；不能用新配置替代原审批快照。');
    if (!command.enabled) rejectApproval('command_disabled', 'Conflict Command 已被禁用；审批不会重新启用它或升级权限。');
    if (command.executionType !== 'conflict' || command.permission !== 'read_write') rejectApproval('command_read_only', '当前 Conflict Command 不是 Read + Write；审批不会升级权限或启动修复。');

    if (proposal.basis.pr_head_sha !== pr.pr.head.sha || proposal.basis.current_base_tip_sha !== currentBase.sha || proposal.basis.base_ref !== currentBase.ref) {
      rejectApproval('git_facts_changed', 'PR head、current base tip 或 base ref 已变化；旧 Proposal 已失去审批前提，请重新发送 /conflict。');
    }
    const publication = (await listOutbound(root, { repo, prNumber })).find(value => value.item.semantic_key === proposalDeliverySemanticKey(proposal));
    if (!publication || publication.item.status !== 'delivered' || !publication.item.receipt || publication.item.receipt.id !== proposal.publication.remote_id) {
      rejectApproval('proposal_publication_missing', '当前 Proposal 的远程 publication receipt 不完整；不会在未确认的人类可见提案上修复。');
    }
    try { await assertCurrentPR(pr, proposal.basis.pr_head_sha, currentBase.sha, undefined, proposal.basis.base_ref, pr.pr.head.ref, repo); }
    catch { rejectApproval('git_facts_changed', '审批领取前 PR head、来源分支、current base 或 PR 状态已变化；旧 Proposal 已失去审批前提，请重新发送 /conflict。'); }
    const evidence = (await captureConflictWorkspaceEvidence(retained.workspace.path, {
      repository: repo, prNumber, prHeadSha: pr.pr.head.sha, historicalBaseSha: pr.pr.base.sha,
      currentBaseTipSha: currentBase.sha, baseRef: currentBase.ref, runId, executionId: proposal.repair_execution_id,
      commandSnapshotId: snapshotInfo.snapshot.snapshot_id, commandSnapshotSha256: snapshotInfo.hash,
    }, trace)).evidence;
    // Before the repair starts, retained workspace evidence must still match. Once a durable
    // repair phase exists, the workspace is expected to differ from that pre-repair evidence;
    // recovery instead relies on the phase, recorded commit, and independent repair artifact.
    if (!recovery || ['accepted', 'claimed'].includes(recovery.phase)) {
      const originalEvidence = await readConflictEvidence(root, proposal);
      const compatibility = compareConflictWorkspaceEvidence(originalEvidence, evidence);
      if (!compatibility.ok) rejectApproval('workspace_changed', `retained workspace 与审批前证据不一致（${compatibility.reason}）；请重新发送 /conflict。`);
    }

    let record = recovery;
    if (!record && reply) {
      const idempotencyKey = `approval:${reply.comment_id}:${proposal.proposal_hash}:${proposal.repair_execution_id}`;
      record = await readConflictApprovalByIdempotency(statePath, idempotencyKey) ?? undefined;
      if (!record) {
        record = newConflictApproval({
          source_event_id: reply.source_event_id!, source_comment_id: reply.comment_id,
          source_comment_url: reply.url, source_comment_created_at: reply.created_at, author: reply.author, author_association: reply.author_association ?? 'OWNER',
          received_at: new Date().toISOString(), verified_at: new Date().toISOString(), repair_execution_id: proposal.repair_execution_id,
          proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
          proposal_publication_delivery_id: proposal.publication.delivery_id, proposal_publication_remote_id: proposal.publication.remote_id,
          pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: proposal.basis.pr_head_ref!, pr_head_repo: proposal.basis.pr_head_repo!,
          current_base_tip_sha: proposal.basis.current_base_tip_sha, base_ref: proposal.basis.base_ref,
          command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256,
          status: 'accepted', phase: 'accepted',
        });
        await saveConflictApproval(statePath, record);
      }
    }
    if (!record) rejectApproval('approval_event_invalid', '缺少可恢复的 Approval event；请重新发送一条单独的 /approval。');
    if (record.status !== 'accepted' || record.proposal_hash !== proposal.proposal_hash || record.proposal_revision !== proposal.proposal_revision) {
      rejectApproval('approval_already_processed', '这条 Approval 已被处理，或不再绑定当前 Proposal；不会重复启动修复。');
    }
    if (record.phase === 'interrupted') rejectApproval('repair_interrupted', '该 Approval 已有一次未完成的修复尝试；为避免重复调用模型，保留现有工作区与证据，请人工检查后重新发送 /conflict。');

    const claimedAt = record.claimed_at ?? new Date().toISOString();
    record = await updateConflictApproval(statePath, record.approval_id, {
      phase: ['accepted', 'claimed'].includes(record.phase) ? 'claimed' : record.phase,
      // claim_run_id is the current worker owner. A recovery run may replace the worker that
      // originally claimed the approval, while repair_run_id continues to point at the durable
      // repair artifacts used for evidence and idempotent commit/push recovery.
      claim_run_id: runId, repair_run_id: record.repair_run_id ?? runId, claimed_at: claimedAt,
    }) ?? record;
    state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), record.source_comment_id])];
    await writeState(statePath, { ...state, run_id: runId, pid: process.pid, active: true, phase: 'claimed', waiting_for_ci: false,
      current_head_sha: pr.pr.head.sha, conflict_proposal: { ...proposalPointerForState(proposal, retained.workspace.path), status: 'published' } });
    // Keep the workspace's original repair-run owner stable; the approval record separately
    // records the current claim worker. This lets a crash recovery prove it is still the same
    // retained workspace instead of accidentally rebinding it to a new run directory.
    await savePaused(statePath, { ...retained, status: 'claimed', run_id: retained.run_id, pause_phase: 'claimed', reason: undefined });
    trace.save('approval.json', record);
    trace.emit('conflict_approval_claimed', { approval_id: record.approval_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
      source_comment_id: record.source_comment_id, source_event_id: record.source_event_id, repair_execution_id: record.repair_execution_id });
    return { record, proposal, snapshot: snapshotInfo.snapshot, evidence };
  } catch (error) {
    if (!(error instanceof ConflictApprovalRejected)) throw error;
    if (input.reply && input.current) {
      const proposal = input.current.proposal;
      try {
        const record = newConflictApproval({
          source_event_id: input.reply.source_event_id ?? '', source_comment_id: input.reply.comment_id,
          source_comment_url: input.reply.url, source_comment_created_at: input.reply.created_at, author: input.reply.author, author_association: input.reply.author_association ?? 'UNKNOWN',
          received_at: new Date().toISOString(), verified_at: new Date().toISOString(), repair_execution_id: proposal.repair_execution_id,
          proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
          proposal_publication_delivery_id: proposal.publication?.delivery_id ?? 'unpublished', proposal_publication_remote_id: proposal.publication?.remote_id,
          // Legacy v1 proposals may not contain source ref/repository. A rejection record still
          // carries the current inspected PR target, while the missing proposal binding remains
          // the mechanical reason that this approval cannot be accepted.
          pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: input.pr.pr.head.ref, pr_head_repo: repo,
          current_base_tip_sha: proposal.basis.current_base_tip_sha, base_ref: proposal.basis.base_ref,
          command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256,
          status: error.code === 'git_facts_changed' || error.code === 'proposal_stale' || error.code === 'workspace_changed' ? 'stale' : 'rejected',
          rejection_code: error.code, phase: 'interrupted',
        });
        await saveConflictApproval(statePath, record);
      } catch { /* a rejected approval must never block the clear mechanical response */ }
    }
    return { rejected: error };
  }
}

export async function runPullRequest(config: { appId: number; privateKey: string; snapshotRoot: string; root: string; operatorLogin?: string; appSlug?: string; botLogin?: string; controlPlaneDb?: ControlPlaneDb; gitlabConnections?: Array<{ id: string; instanceUrl: string; projectIds: string[]; token?: string; botUserId?: string; botLogin?: string }> }, repo: string, number: number) {
  if (repo.startsWith('gitlab:')) return runGitLabMergeRequest(config, repo, number);
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
  if (!await hasRunnableWork(config.root, repo, number)) return { status: 'mention_required' };
  const release = await claimRun(path);
  if (!release) return { status: 'already_running' };
  const github = createGitHub(config);
  let controlPlane: ControlPlaneDb | undefined = config.controlPlaneDb;
  let ownsControlPlane = false;
  let botLogin = config.botLogin ?? (config.appSlug ? `${config.appSlug}[bot]` : '');
  let appSlug = config.appSlug ?? config.botLogin?.replace(/\[bot\]$/, '');
  let recoveryTarget: string | undefined;
  let priorConflictProposal: RunState['conflict_proposal'];
  let approvalRecovery: ConflictApprovalRecord | undefined = await readUnfinishedConflictApproval(path) ?? undefined;
  let priorClose: Pick<RunState, 'closed_at' | 'closed_through_comment_id' | 'close_start_notice_id' | 'close_comment_id' | 'close_mentions' | 'completion_notice_id' | 'completion_notice_status' | 'pending_close_refusal'> | undefined;
  let closeResult: Awaited<ReturnType<typeof runClose>> | undefined;
  try {
    const previous = await readState(path);
    // A new human entry is the explicit operator requeue point for the oldest blocked
    // outbound item. The scheduler never performs this transition on its own, and later
    // entries remain behind the requeued item so PR ordering is preserved.
    if (await hasHumanReplies(path)) await requeueOldestBlockedDelivery(config.root, repo, number);
    // /close is a mechanical storage-lifecycle command: parsed from the oldest pending comment
    // BEFORE recovery, run allocation, workspace or model work. The substring prefilter avoids
    // an extra App-slug round trip on ordinary runs; exact parsing still decides.
    const handledIds = new Set(previous?.handled_comment_ids ?? []);
    const oldest = (await readHumanReplies(path)).find(c => c.comment_id > (previous?.closed_through_comment_id ?? 0) && !handledIds.has(c.comment_id));
    if (oldest?.body.includes('/close')) {
      if (!appSlug) {
        const { data: app } = await github.app.rest.apps.getAuthenticated();
        appSlug = app?.slug;
        if (appSlug) botLogin = `${appSlug}[bot]`;
      }
      if (appSlug && parsePRTask(oldest.body, appSlug) === 'close') {
        const [owner, name] = repo.split('/');
        const mentions = [oldest.author, config.operatorLogin ?? owner].filter((login): login is string => !!login);
        const prepared = await prepareCloseStart(config, repo, number, path,
          { comment_id: oldest.comment_id, mentions, bot_login: botLogin });
        try {
          const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
          closeResult = await runClose(config, repo, number, path, { comment_id: oldest.comment_id, connection: { client: github.installation(installation.id),
            botLogin },
            mentions, bot_login: botLogin });
        } catch (error) {
          if (!prepared.start) throw error;
          const deferred = await deferDelivery(config.root, prepared.start, error);
          closeResult = { status: 'close_start_unpublished', run_ids: prepared.runIds.length, publication: deferred.publication };
        }
      }
    }
    if (!closeResult && await hasPendingClose(path)) {
      // A crashed /close is durable state: destructive steps may already have run while the
      // tombstone and even the original inbox comment are gone. Finish it mechanically BEFORE
      // any recovery, run allocation, model or workspace work; ordinary tasks must not start.
      const prepared = await preparePendingCloseStart(config, repo, number, path, botLogin);
      const [owner, name] = repo.split('/');
      try {
        const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
        closeResult = await resumePendingClose(config, repo, number, path, { client: github.installation(installation.id), botLogin }, botLogin);
      } catch (error) {
        if (!prepared?.start) throw error;
        const deferred = await deferDelivery(config.root, prepared.start, error);
        closeResult = { status: 'close_start_unpublished', run_ids: prepared.runIds.length, publication: deferred.publication };
      }
    }
    if (!closeResult && (previous?.completion_notice_status === 'pending' || previous?.pending_close_refusal)) {
      // Deterministic notice outbox from earlier entries: a missing /close completion notice
      // and/or an unpublished active-task refusal. Both retry BEFORE recovery or a new
      // generation; failure keeps the durable markers for the next entry and never blocks this one.
      try {
        const [owner, name] = repo.split('/');
        const client = async () => {
          const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
          return github.installation(installation.id);
        };
        const bot = botLogin;
        if (previous?.completion_notice_status === 'pending') await retryPendingCloseCompletion(path, repo, number, async () => ({ client: await client(), botLogin: bot }), config.root, bot);
        const refusal = (await readState(path))?.pending_close_refusal;
        if (refusal) {
          try {
            const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'close_refusal',
              semanticKey: `close-refusal:${refusal.comment_id}`, body: closeRefusalBody,
              mentions: [refusal.author ?? owner].filter((login): login is string => !!login), botLogin: bot,
              source: { comment_id: refusal.comment_id } });
            const delivered = await deliverImmediately(config.root, stored, { client: await client(), botLogin: bot });
            if (delivered.item.status === 'delivered') {
              const cleared = await readState(path);
              if (cleared) await writeState(path, { ...cleared, pending_close_refusal: undefined });
            }
          } catch { /* the refusal stays pending for the next entry */ }
        }
      } catch { /* best effort; the durable pending markers survive for the next entry */ }
    }
    // A communication scheduler normally finalizes a delivered proposal. A worker entry also
    // reconciles it before parsing a new comment, so a crash or a delayed scheduler cannot leave
    // the durable outbox receipt and PR-local lifecycle projection disagreeing.
    if (!closeResult) {
      const currentState = await readState(path);
      if (currentState?.conflict_proposal) {
        await reconcileConflictProposalPublication(config.root, path, repo, number);
      }
    }
    if (!closeResult) {
      const current = await readState(path); // re-read: the notice retries may have updated it
      const { closed_at, closed_through_comment_id, close_start_notice_id, close_comment_id, close_mentions, completion_notice_id, completion_notice_status, pending_close_refusal } = current ?? {};
      // Durable /close facts must survive every later state overwrite in a new generation.
      if (closed_at || closed_through_comment_id || completion_notice_status || pending_close_refusal) {
        priorClose = { closed_at, closed_through_comment_id, close_start_notice_id, close_comment_id, close_mentions,
          completion_notice_id, completion_notice_status, pending_close_refusal };
      }
      priorConflictProposal = current?.conflict_proposal;
      if (current && await needsReviewRecovery(current, join(patchpawPaths(config.root).runs, current.run_id))) {
        recoveryTarget = current.run_id;
      }
      if (current && await readArtifact(join(patchpawPaths(config.root).runs, current.run_id), 'run-notice.json')
        && (await readArtifact(join(patchpawPaths(config.root).runs, current.run_id), 'notification.json'))?.status !== 'published') {
        recoveryTarget = current.run_id;
      }
    }
  } catch (error) {
    await release(); throw error;
  }
  if (closeResult) {
    try { return closeResult; }
    finally { await release(); }
  }
  if (recoveryTarget) {
    try { return await recoverLockedRun(config, repo, number, recoveryTarget); }
    finally { await release(); }
  }
  if (!await hasHumanReplies(path) && !approvalRecovery) {
    // Pure outbound retries belong to the independent scheduler. A direct
    // worker invocation must not allocate a new Agent run for them.
    try { return { status: 'mention_required' }; }
    finally { await release(); }
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(join(patchpawPaths(config.root).runs, runId));
  trace.secret(config.privateKey);
  const priorHandledCommentIds = (await readState(path))?.handled_comment_ids ?? [];
  const state: RunState = { repo, pr_number: number, run_id: runId, current_head_sha: '', phase: 'inspect', repair_attempts: 0,
    last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid,
    // Durable /close facts carry into the fresh generation: the retired-comment high-water mark
    // and a still-pending completion notice are never lost to a state overwrite.
    ...(priorClose ?? {}), ...(priorConflictProposal ? { conflict_proposal: priorConflictProposal } : {}) };
  let inspected: InspectedPR | undefined;
  let confirmedRemoteHead: string | undefined;
  let executionId = 1;
  let workspaceNotice = '';
  let activeWorkspace: WorkspaceState | undefined;
  let conflictEvidence: { evidence: ConflictWorkspaceEvidence; evidenceSha256: string } | undefined;
  let conflictWorkspaceStaleReason: string | undefined;
  let approvalRequested = false;
  let approvedConflictRepair = false;
  let approvalRecord: ConflictApprovalRecord | undefined = approvalRecovery;
  let runtimeExecution: RuntimeExecution | undefined;
  let manifest: Record<string, any>;
  // Cleanup ownership of a fresh worktree begins the moment its creation is attempted: a
  // half-created or prepare-failed worktree must never leak outside the run's lifecycle.
  let createdWorkspace: string | undefined;
  let activeTask: PRTask = 'conversation';
  let stop: ReturnType<typeof watchStop> | undefined;
  let feedback: Awaited<ReturnType<typeof humanFeedback>>['context'];
  const recipients = () => [inspected?.pr.user?.login, config.operatorLogin ?? repo.split('/')[0],
    ...feedback?.comments.filter(c => feedback!.new_comment_ids.includes(c.comment_id)).map(c => c.author) ?? []]
    .filter((login): login is string => !!login);
  const deliverComment = (purpose: string, semanticKey: string, body: string, mentions: string[], source: Record<string, string | number | null | undefined> = {}) => {
    if (!inspected || !botLogin) throw new Error('PR inspection and bot identity are required before publishing a task report');
    return enqueueAndDeliverComment({ root: config.root, repo, prNumber: number, purpose, semanticKey, body, mentions,
      botLogin, source }, { client: inspected.client, botLogin });
  };
  const phase = async (value: string) => { state.phase = value; state.waiting_for_ci = value === 'ci';
    await writeState(path, state); trace.emit('phase', { phase: value }); console.log(JSON.stringify({ run_id: runId, phase: value })); };
  const finish = async (status: string, extra: { reason?: string; message?: string; [key: string]: unknown } = {}, persistedPhase = status) => {
    const stoppedPhase = state.phase;
    if (['ci', 'repair'].includes(activeTask) && activeWorkspace && inspected && ['needs_human', 'budget_exhausted'].includes(status)) {
      await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: activeTask as 'ci' | 'repair', workspace: activeWorkspace,
        base_sha: inspected.pr.base.sha, base_ref: inspected.pr.base.ref, remote_head: confirmedRemoteHead, pause_phase: stoppedPhase,
        pause_reason: status === 'needs_human' ? 'human_decision' : 'budget' });
    }
    if (approvedConflictRepair && activeWorkspace && inspected
        && ['needs_human', 'budget_exhausted', 'stopped', 'harness_failed', 'provider_unavailable'].includes(status)) {
      const pauseStatus = status === 'stopped' ? 'stopped' : status === 'budget_exhausted' ? 'budget_exhausted' : 'needs_human';
      const retainedPause = await readPaused(path);
      await retainWorkspace(path, trace, { run_id: retainedPause?.run_id ?? runId, execution_id: retainedPause?.execution_id ?? executionId, task: 'conflict', workspace: activeWorkspace,
        base_sha: inspected.pr.base.sha, base_ref: inspected.pr.base.ref, remote_head: confirmedRemoteHead, pause_phase: stoppedPhase,
        pause_reason: pauseStatus === 'stopped' ? 'human_stop' : pauseStatus === 'budget_exhausted' ? 'budget' : 'human_decision', status: pauseStatus });
    }
    const stopRequest = stop?.request();
    if (stopRequest) state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), stopRequest.comment_id])];
    const stopped = !['review_completed', 'conversation_completed', 'custom_completed', 'conflict_completed', 'ci_completed', 'repair_completed', 'publication_pending', 'awaiting_approval'].includes(status);
    let evidence = '';
    if (stopped) {
      try { evidence = await stopEvidence(trace.dir, confirmedRemoteHead); }
      catch { evidence = '补充证据读取失败；原始任务结果与 trace 仍保留。'; }
      trace.save('stop-evidence.json', { status, failed_phase: stoppedPhase, evidence });
    }
    state.active = false; await phase(persistedPhase);
    const result = { status, run_id: runId, execution_id: executionId, repo, pr_number: number, final_head_sha: state.current_head_sha,
      ...(status === 'budget_exhausted' ? { closeout: 'closeout.json' } : {}),
      duration_ms: Date.now() - trace.started, ...extra, ...(stopped ? { evidence } : {}) };
    trace.save('result.json', result);
    trace.emit((status === 'stopped' || status === 'budget_exhausted' || (status === 'needs_human' && stoppedPhase === 'conflict')) ? 'execution_paused' : 'execution_completed', { execution_id: executionId, status });
    // Successful Review already communicates the outcome on this PR; don't post it twice.
    if (!['review_completed', 'conversation_completed', 'custom_completed', 'conflict_completed', 'ci_completed', 'repair_completed', 'publication_pending', 'awaiting_approval'].includes(status)) {
      const failure = extra.failure as RunFailure | undefined;
      const notice = JSON.parse(trace.clean({ run_id: runId, head: state.current_head_sha, status, phase: stoppedPhase,
        ...(failure ? { failure } : {}),
        reason: `${status === 'harness_failed' && !failure ? 'Harness 执行／验证过程出错，不等同于代码测试失败。\n' : ''}${status === 'model_output_truncated' && !failure ? '模型连接正常，但单次输出上限已耗尽，未生成完整评审结果；这不是 Provider 不可用，也没有生成可发布的代码验收记录。\n' : ''}${workspaceNotice}${extra.reason ?? extra.message ?? '本次任务尚未完成。'}\n${state.last_patchpaw_commit ? `本次记录的 PatchPaw 提交：\`${state.last_patchpaw_commit}\`。\n` : '本次没有记录 PatchPaw 提交或推送；失败不代表代码已交付。\n'}\n${evidence}`,
        mentions: recipients(), bot_login: botLogin }));
      trace.save('run-notice.json', notice);
      try {
        // Persist the exact sanitized notice before obtaining an installation or making any
        // other GitHub request. A transient failure in that acquisition must leave this item
        // pending for the scheduler rather than erase the only human-visible outcome.
        const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'run_notice',
          semanticKey: `run-notice:${runId}`, body: runNoticeBody(notice), mentions: notice.mentions,
          botLogin: botLogin || undefined,
          legacyMarkers: ['budget_exhausted', 'stopped'].includes(status) ? [closeoutMarker(runId)] : undefined,
          source: { run_id: runId, status } });
        let publication;
        try {
          let client = inspected?.client;
          if (!client) {
            const [owner, name] = repo.split('/');
            const { data } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
            client = github.installation(data.id);
          }
          publication = (await deliverImmediately(config.root, stored, { client, botLogin: botLogin || undefined })).publication;
        } catch (error) {
          publication = (await deferDelivery(config.root, stored, error)).publication;
        }
        trace.emit('run_notice_published', publication);
        trace.save('notification.json', publication.status === 'published' ? publication
          : publication.status === 'blocked' ? { status: 'notification_failed', http_status: publication.last_error?.status ?? null }
          : { ...publication, status: 'notification_pending' });
      } catch (error) {
        const failure = { status: 'notification_failed', http_status: (error as { status?: number }).status ?? null };
        trace.emit('run_notice_failed', failure);
        trace.save('notification.json', failure);
      }
    }
    return result;
  };
  // Workspace lifecycle: ONLY an explicit resumable pause keeps its workspace — a durable paused
  // pointer in budget_exhausted/needs_human/stopped status pointing at it. Every other run with a
  // durable terminal result is disposed Git-aware after its evidence persists: successes AND
  // non-resumable failures (harness_failed, provider_unavailable, a review needs_human that never
  // retained, a prepare failure on a freshly created worktree), so no checkout without a paused
  // pointer can outlive its run. A run without any result (publication_interrupted) stays owned
  // by recovery. A failed disposal never invalidates the durable result; it is recorded for the
  // next lifecycle operation.
  const disposeTerminalWorkspace = async () => {
    try {
      const target = activeWorkspace?.path ?? createdWorkspace;
      if (!target) return;
      const result = await readArtifact(trace.dir, 'result.json');
      if (!result) return;
      const paused = await readPaused(path);
      if (activeWorkspace && paused && paused.workspace.path === activeWorkspace.path
        && ['budget_exhausted', 'needs_human', 'stopped', 'publication_pending', 'awaiting_approval'].includes(paused.status)) return;
      await disposeWorkspacePath(config.root, repo, target, trace);
      trace.emit('workspace_disposed', { workspace: target, status: result.status });
    } catch (error) {
      trace.emit('workspace_dispose_failed', { workspace: activeWorkspace?.path ?? createdWorkspace, message: (error as Error).message });
    }
  };
  try {
    // A claimed Approval is an ordered PR-local job. Do not consume a later human comment while
    // recovering it; the later comment remains in the inbox for the next generation.
    const replies = approvalRecovery
      ? { handledIds: (await readState(path))?.handled_comment_ids ?? [], context: undefined }
      : await humanFeedback(path, patchpawPaths(config.root).runs, true);
    feedback = replies.context; state.handled_comment_ids = replies.handledIds;
    if (!feedback && !approvalRecovery) return { status: 'mention_required' };
    // Production configuration supplies the app slug. Keeping identity in local config lets
    // failure notices be prepared durably before any GitHub installation/app lookup; identity
    // discovery remains a delivery-time fallback for old callers without the configured slug.
    if (!appSlug) {
      const configured = config.botLogin?.replace(/\[bot\]$/, '');
      if (configured) appSlug = configured;
    }
    if (!appSlug) throw new Error('GitHub App slug is unavailable');
    botLogin = botLogin || `${appSlug}[bot]`;
    // Do not persist the approval comment's high-water mark during the initial inspect phase.
    // The approval record must win the crash race: once that record is durable, prepare below
    // retires the source comment atomically with the claimed state; before then it remains wakeable.
    const pendingApprovalComment = feedback?.comments.find(comment => feedback!.new_comment_ids.includes(comment.comment_id) && isApprovalComment(comment.body));
    if (pendingApprovalComment) state.handled_comment_ids = priorHandledCommentIds.filter((id: number) => id !== pendingApprovalComment.comment_id);
    const triggeringComment = feedback?.comments.find(c => feedback!.new_comment_ids.includes(c.comment_id));
    let task: PRTask = 'conversation';
    let intent: ParsedIntent = { kind: 'conversation', repositoryId: '' };
    activeTask = task;
    // An /close arriving mid-task is refused mechanically by the owning worker (no model, no
    // queued destruction). Durable retirement comes FIRST: the comment must never become an
    // executable /close after this task ends, even when the refusal notice cannot be published.
    // A failed notice waits in the tiny state outbox (pending_close_refusal) and the next
    // PatchPaw entry retries it deterministically.
    const refuseClose = async (comment: HumanReply) => {
      state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), comment.comment_id])];
      if (!state.pending_close_refusal) state.pending_close_refusal = { comment_id: comment.comment_id, author: comment.author };
      // Later phase()/finish writes persist the same in-memory retirement even if this write fails.
      try { await writeState(path, state); }
      catch (error) { trace.emit('close_refusal_retire_degraded', { comment_id: comment.comment_id, message: (error as Error).message }); }
      try {
        const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'close_refusal',
          semanticKey: `close-refusal:${comment.comment_id}`, body: closeRefusalBody, mentions: [comment.author], botLogin,
          source: { comment_id: comment.comment_id, run_id: runId } });
        let client = inspected?.client;
        if (!client) {
          const [owner, name] = repo.split('/');
          const { data } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
          client = github.installation(data.id);
        }
        const delivered = await deliverImmediately(config.root, stored, { client, botLogin });
        if (delivered.item.status === 'delivered') {
          state.pending_close_refusal = undefined;
          await writeState(path, state);
        }
        trace.emit('close_refused_active_task', { comment_id: comment.comment_id });
      } catch (error) {
        trace.emit('close_refusal_notice_pending', { comment_id: comment.comment_id, message: (error as Error).message });
      }
    };
    stop = watchStop(path, botLogin, () => state.handled_comment_ids ?? [], refuseClose);
    if (feedback) trace.save('human-feedback.json', feedback);
    await phase('inspect');
    // Approval needs to explain a closed PR without turning the inspection failure into a
    // generic harness error. All other task types retain the historical open-PR guard below.
    const pr = await capturePullRequest(github, repo, number, config.snapshotRoot, { allowClosed: true });
    inspected = pr;
    state.current_head_sha = pr.pr.head.sha;
    confirmedRemoteHead = pr.pr.head.sha;
    // Bootstrap only fills genuinely missing control-plane records. Existing repository
    // edits remain authoritative, so every new invocation resolves the current config.
    controlPlane = config.controlPlaneDb ?? await openControlPlaneDb(config.root);
    ownsControlPlane = !config.controlPlaneDb;
    await bootstrapControlPlane({ root: config.root, repositories: [{ fullName: repo }], controlPlaneDb: controlPlane });
    const repository = await getRepositoryByName(controlPlane, repo);
    if (!repository) throw new Error(`Control-plane repository is missing after bootstrap: ${repo}`);
    intent = triggeringComment
      ? await parsePRIntent(controlPlane, repository.id, triggeringComment.body, appSlug)
      : { kind: 'control', control: 'approval' };
    task = intent.kind === 'command' ? intent.executionType : intent.kind === 'control' && intent.control === 'stop' ? 'stop'
      : intent.kind === 'control' && intent.control === 'close' ? 'close'
      : intent.kind === 'control' && intent.control === 'approval' ? 'conflict' : 'conversation';
    activeTask = task;
    approvalRequested = intent.kind === 'control' && intent.control === 'approval';
    if (approvalRequested && state.closed_at) {
      if (approvalRecovery && isUnfinishedConflictApproval(approvalRecovery)) {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, {
          status: 'stale', phase: 'interrupted', rejection_code: 'approval_after_close',
        }) ?? approvalRecovery;
      }
      return await finish('closed', { reason: '该 PR 的 PatchPaw 本地 generation 已 closed；迟到 /approval 评论已退休，不会复活旧的 Proposal、workspace 或 repair。' }, 'closed');
    }
    if (pr.pr.state !== 'open' && !approvalRequested) throw new Error('PR is not open or has no head repository');
    if (approvalRequested && !CONFLICT_APPROVAL_ENABLED) {
      return await finish('needs_human', { reason: 'Conflict approval gate is disabled.' });
    }
    if (intent.kind === 'control' && intent.control === 'close') {
      return await finish('needs_human', { reason: '/close 是机械生命周期命令，但本条评论未能在前置生命周期入口处理；没有启动模型或修复。请重发一次单独的 /close。' });
    }
    if (['conflict', 'ci', 'repair'].includes(task) && pr.pr.head.repo?.full_name.toLowerCase() !== repo.toLowerCase()) {
      return await finish('needs_human', { reason: '此 PR 来自 fork，目前没有向该来源分支发布修复的安装权限上下文，请协助提供可发布的分支。' });
    }
    const token = async () => {
      const value = await installationGitToken(pr);
      trace.secret(value); trace.secret(Buffer.from(`x-access-token:${value}`).toString('base64'));
      return value;
    };
    await stop.guard();
    const retained = await readPaused(path);
    const currentConflictProposal = await readCurrentConflictProposal(path);
    const retainedForDiscussion = retained && ['budget_exhausted', 'needs_human', 'stopped', 'publication_pending', 'awaiting_approval', 'claimed', 'repairing'].includes(retained.status);
    const discussingConflict = task === 'conversation' && !!retainedForDiscussion && !!currentConflictProposal
      && retained!.workspace.path === currentConflictProposal.pointer.workspace_path
      && ['draft', 'publication_pending', 'published'].includes(currentConflictProposal.proposal.status);
    const discussingPause = (task === 'conversation' && !!retainedForDiscussion && !currentConflictProposal)
      || discussingConflict;
    if (task === 'stop' && currentConflictProposal) {
      // /stop is mechanical even while a proposal is awaiting publication/approval. Preserve the
      // proposal pointer and retained checkout, but never turn a stop comment into a model turn.
      state.conflict_proposal = proposalPointerForState(currentConflictProposal.proposal, currentConflictProposal.pointer.workspace_path);
      return await finish('stopped', { reason: 'Conflict Proposal 已保留；/stop 只停止当前本地会话，不会调用模型或启动修复。' });
    }
    if (task === 'stop' && !discussingPause) return await finish('stopped', { reason: '当前没有正在执行的任务或可继续的暂停工作区。没有启动新任务。' });
    if (retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status)
      && !discussingPause && task !== retained.task) {
      return await finish('needs_human', { reason: `当前有暂停的 /${retained.task} 工作区。请先沟通并用 /${retained.task} 继续该任务；此次没有另建工作区。` });
    }
    await phase('workspace');
    // Every run refreshes the one shared object store for this GitHub repo BEFORE the
    // resume/fresh decision; fetching never mutates an existing paused worktree's HEAD/index.
    await ensureRepo(config.root, repo, pr.repository.clone_url, trace);
    const fetchedBase = await fetchPRState(config.root, repo, { headSha: pr.pr.head.sha, baseRef: pr.pr.base.ref }, trace, gitAuth(await token()));
    const currentBase = { ref: fetchedBase.baseRef, sha: fetchedBase.currentBaseTipSha };
    const staleApprovedRepair = async (reason: string) => {
      if (approvalRecovery && currentConflictProposal && retained) {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, {
          status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed',
        }) ?? approvalRecovery;
        await markConflictProposalStatus(path, currentConflictProposal.proposal.proposal_revision, 'stale', retained.workspace.path);
        await savePaused(path, { ...retained, status: 'stale', reason });
        state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained.workspace.path), status: 'stale' };
        try { await disposeWorkspacePath(config.root, repo, retained.workspace.path, trace); }
        catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained.workspace.path, reason, message: (error as Error).message }); }
      }
      return await finish('stale', { reason });
    };
    const retireSupersededApproval = async (reason: string) => {
      approvalRecord = await updateConflictApproval(path, approvalRecovery!.approval_id, {
        status: 'stale', phase: 'interrupted', rejection_code: 'proposal_stale',
      }) ?? approvalRecovery;
      return await finish('needs_human', { reason, approval_rejection_code: 'proposal_stale' },
        currentConflictProposal?.proposal.status === 'published' ? 'awaiting_approval' : 'needs_human');
    };
    if (approvalRequested && approvalRecovery) {
      const current = currentConflictProposal?.proposal;
      const sameProposal = !!current && current.proposal_id === approvalRecovery.proposal_id
        && current.proposal_revision === approvalRecovery.proposal_revision
        && current.proposal_hash === approvalRecovery.proposal_hash;
      if (!sameProposal) {
        return await retireSupersededApproval('已有更新的 Conflict Proposal；旧 Approval 已标记 stale，不会发布旧修复报告。请对当前版本重新发送 /approval。');
      }
      if (current!.status !== 'published'
          || approvalRecovery.base_ref !== currentBase.ref
          || current!.basis.base_ref !== currentBase.ref
          || approvalRecovery.pr_head_sha !== current!.basis.pr_head_sha
          || approvalRecovery.pr_head_ref !== current!.basis.pr_head_ref
          || !current!.basis.pr_head_repo || approvalRecovery.pr_head_repo.toLowerCase() !== current!.basis.pr_head_repo.toLowerCase()
          || approvalRecovery.current_base_tip_sha !== current!.basis.current_base_tip_sha
          || approvalRecovery.command_snapshot_id !== current!.basis.command_snapshot_id
          || approvalRecovery.command_snapshot_sha256 !== current!.basis.command_snapshot_sha256) {
        return await staleApprovedRepair('Approval 绑定的 Proposal、base ref、Git 事实或 Command Snapshot 已变化；旧修复不会继续发布，请重新发送 /conflict。');
      }
    }
    // A crash after the remote head was confirmed but before the final report was finalized
    // must converge from durable artifacts/outbox only. The next worker must not re-run Repair,
    // re-commit, or re-push an already published candidate.
    if (approvalRequested && approvalRecovery && currentConflictProposal
        && ['remote_confirmed', 'publication_pending'].includes(approvalRecovery.phase)) {
      const remoteHead = approvalRecovery.remote_head_sha;
      if (!remoteHead || !retained) {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, {
          phase: 'interrupted', rejection_code: 'workspace_missing',
        }) ?? approvalRecovery;
        return await finish('needs_human', { reason: '已确认远程修复提交，但 retained workspace 证据已丢失；没有重复调用模型或推送，请人工检查后重新发送 /conflict。' }, 'needs_human');
      }
      try { await assertCurrentPR(pr, remoteHead, currentBase.sha, undefined, approvalRecovery.base_ref, pr.pr.head.ref, repo); }
      catch { return await staleApprovedRepair('最终发布前 Git freshness 检查失败；已确认的修复不会重复推送，请重新发送 /conflict。'); }
      const repairRun = approvalRecovery.repair_run_id ?? state.run_id;
      try {
        const recoveredSnapshot = await loadConflictApprovalSnapshot(config.root, currentConflictProposal.proposal);
        const recoveredCommand = recoveredSnapshot.snapshot.command ? await getCommand(controlPlane!, recoveredSnapshot.snapshot.command.id) : undefined;
        if (!recoveredCommand || !recoveredCommand.enabled || recoveredCommand.executionType !== 'conflict' || recoveredCommand.permission !== 'read_write') {
          throw new Error('the bound Conflict Command is missing, disabled, or no longer read_write');
        }
        if (!await isManagedWorktree(config.root, repo, retained.workspace.path, undefined, trace)) throw new Error('retained workspace is not a managed worktree');
        const commitArtifact = await readArtifact(join(patchpawPaths(config.root).runs, repairRun), CONFLICT_REPAIR_COMMIT_EVIDENCE) as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
        if (!commitArtifact?.evidence_sha256) throw new Error('commit evidence is missing');
        const { evidence_sha256: storedHash, ...commitEvidence } = commitArtifact;
        if (storedHash !== workspaceEvidenceSha256(commitEvidence) || commitEvidence.workspace_head !== remoteHead) throw new Error('commit evidence is invalid');
        const currentEvidence = (await captureConflictWorkspaceEvidence(retained.workspace.path, {
          repository: repo, prNumber: number, prHeadSha: approvalRecovery.pr_head_sha, historicalBaseSha: retained.base_sha,
          currentBaseTipSha: currentBase.sha, baseRef: approvalRecovery.base_ref, runId, executionId: approvalRecovery.repair_execution_id,
          commandSnapshotId: approvalRecovery.command_snapshot_id, commandSnapshotSha256: approvalRecovery.command_snapshot_sha256,
        }, trace, 'conflict-repair-recovery-evidence.json')).evidence;
        if (!compareConflictWorkspaceEvidence(commitEvidence, currentEvidence).ok) throw new Error('retained workspace differs from committed evidence');
      } catch (error) {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, { phase: 'interrupted', rejection_code: 'workspace_changed' }) ?? approvalRecovery;
        return await finish('needs_human', { reason: `已确认远程修复提交，但本地恢复证据校验失败（${(error as Error).message}）；不会重复调用模型或推送，请人工检查后重新发送 /conflict。` }, 'needs_human');
      }
      const repair = await readArtifact(join(patchpawPaths(config.root).runs, repairRun), 'repair-result.json') as Awaited<ReturnType<typeof runRepair>> | null;
      if (!repair || repair.status !== 'repaired') {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, { phase: 'interrupted' }) ?? approvalRecovery;
        return await finish('needs_human', { reason: '已确认远程修复提交，但缺少可独立重建的 repair-result 证据；没有重复调用模型或推送，请人工检查后重新发送 /conflict。' }, 'needs_human');
      }
      state.current_head_sha = remoteHead; confirmedRemoteHead = remoteHead;
      const oldDelivery = await readArtifact(join(patchpawPaths(config.root).runs, repairRun), 'delivery.json') as { body?: string } | null;
      const answer = oldDelivery?.body ?? JSON.parse(trace.clean(`## Conflict 修复完成\n\n${repair.summary}\n\n提交：\`${remoteHead}\`\n本地验证：${repair.tests?.join('；') || repair.validation_not_applicable}`)) as string;
      trace.save('delivery.json', { status: 'repair_completed', head_sha: remoteHead, body: answer,
        approval_id: approvalRecovery.approval_id, proposal_hash: approvalRecovery.proposal_hash, recovered_from_run_id: repairRun });
      const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'conflict_repair',
        semanticKey: approvalDeliverySemanticKey(approvalRecovery), body: answer, mentions: recipients(), botLogin,
        source: { run_id: approvalRecovery.repair_run_id ?? runId, approval_id: approvalRecovery.approval_id, proposal_id: approvalRecovery.proposal_id,
          proposal_revision: approvalRecovery.proposal_revision, proposal_hash: approvalRecovery.proposal_hash,
          commit_sha: remoteHead, repair_execution_id: approvalRecovery.repair_execution_id } });
      // The durable outbox row is the recovery marker. Enqueue it before changing the approval
      // phase so a crash cannot leave publication_pending with no row for the scheduler to find.
      const deliveryRunId = typeof stored.item.source.run_id === 'string' ? stored.item.source.run_id : runId;
      approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, { phase: 'publication_pending', claim_run_id: runId }) ?? approvalRecovery;
      await savePaused(path, { ...retained, status: 'publication_pending', run_id: deliveryRunId, pause_phase: 'publication_pending' });
      const published = await deliverImmediately(config.root, stored, { client: pr.client, botLogin });
      trace.save('conflict-repair-publication.json', published.publication);
      if (published.item.status !== 'delivered' || !published.item.receipt) {
        return await finish('publication_pending', { reason: '已确认远程修复提交，最终报告仍在 durable outbox 中；恢复不会重复调用模型或推送。' });
      }
      const paused = await readPaused(path);
      if (paused?.workspace.path === retained.workspace.path) await savePaused(path, { ...paused, status: 'completed' });
      try { await disposeWorkspacePath(config.root, repo, retained.workspace.path, trace); }
      catch (error) {
        trace.emit('workspace_dispose_failed', { workspace: retained.workspace.path, message: (error as Error).message });
        return await finish('publication_pending', { reason: '最终报告已送达，但本地 workspace 清理尚未确认；durable outbox 将重试收敛，不会重复调用模型或推送。' });
      }
      const result = await finish('repair_completed', { answer, publication: published.publication });
      // Keep the approval pending until the local lifecycle result is durable. If the process
      // dies between these two writes, the durable approval wake-up re-enters the same finalizer
      // instead of leaving a completed approval with no recovery trigger.
      approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, { phase: 'completed',
        final_publication_delivery_id: published.item.delivery_id, final_publication_remote_id: published.item.receipt.id,
        final_published_at: published.item.receipt.published_at ?? new Date().toISOString() }) ?? approvalRecovery;
      await finalizeDelivery(config.root, stored);
      return result;
    }
    if (discussingConflict && currentConflictProposal) {
      const basis = currentConflictProposal.proposal.basis;
      const staleReason = basis.pr_head_sha !== pr.pr.head.sha ? 'pr_head_changed'
        : basis.current_base_tip_sha !== currentBase.sha ? 'current_base_tip_changed'
        : basis.base_ref !== currentBase.ref ? 'base_ref_changed' : undefined;
      if (staleReason) {
        await markCurrentConflictProposalStale(path, retained!.workspace.path, staleReason);
        await savePaused(path, { ...retained!, status: 'stale', reason: staleReason });
        state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained!.workspace.path), status: 'stale' };
        await writeState(path, { ...state, active: false, phase: 'stale' });
        try { await disposeWorkspacePath(config.root, repo, retained!.workspace.path, trace); }
        catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained!.workspace.path, reason: staleReason, message: (error as Error).message }); }
        return await finish('stale', { reason: `当前 Git 事实已变化（${staleReason}），旧 Conflict Proposal 已标记 stale；不会基于旧工作区继续讨论或发布修订。请重新发送 /conflict。` });
      }
    }
    let approvalSnapshot: CommandSnapshot | undefined;
    if (approvalRequested) {
      const prepared = await prepareConflictApproval({ root: config.root, statePath: path, repo, prNumber: number, runId, botLogin,
        trace, state, pr, currentBase, retained, current: currentConflictProposal, reply: triggeringComment, recovery: approvalRecovery, controlPlane });
      if ('rejected' in prepared) {
        const rejected = prepared.rejected;
        if (triggeringComment) state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), triggeringComment.comment_id])];
        if (approvalRecovery && ['pr_closed', 'approval_after_close'].includes(rejected.code)) {
          approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, {
            status: 'stale', phase: 'interrupted', rejection_code: rejected.code,
          }) ?? approvalRecovery;
        }
        const stale = ['git_facts_changed', 'proposal_stale', 'workspace_changed'].includes(rejected.code);
        if (stale && currentConflictProposal && retained) {
          await markCurrentConflictProposalStale(path, retained.workspace.path, rejected.code);
          await savePaused(path, { ...retained, status: 'stale', reason: rejected.code });
          state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained.workspace.path), status: 'stale' };
          try { await disposeWorkspacePath(config.root, repo, retained.workspace.path, trace); }
          catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained.workspace.path, reason: rejected.code, message: (error as Error).message }); }
          return await finish('stale', { reason: rejected.message });
        }
        // A rejected actor/config/publication check leaves a valid published Proposal waiting for
        // a qualified, explicit approval. The rejected comment itself is already handled by the
        // inbox high-water mark and can never be replayed as an approval.
        return await finish('needs_human', { reason: rejected.message, approval_rejection_code: rejected.code }, 'awaiting_approval');
      }
      approvedConflictRepair = true;
      approvalRecord = prepared.record;
      approvalSnapshot = prepared.snapshot;
      conflictEvidence = { evidence: prepared.evidence, evidenceSha256: workspaceEvidenceSha256(prepared.evidence) };
    }
    const resumableTask = !approvedConflictRepair && ['conflict', 'ci', 'repair', 'review'].includes(task);
    const candidateSnapshot = resumableTask && !discussingPause && retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status)
      ? await loadOrReconstructLegacySnapshot(config.root, retained.run_id, repo, number, retained).catch(error => ({ error }))
      : null;
    if (candidateSnapshot && 'error' in candidateSnapshot) {
      const error = candidateSnapshot.error;
      trace.emit('legacy_snapshot_required', { previous_run_id: retained?.run_id, code: error?.code ?? 'snapshot_unavailable' });
      return await finish('needs_human', { reason: '该暂停任务没有可验证的 Command Snapshot，不能安全套用当前最新配置继续。请发起新的明确任务；旧工作区与证据已保留。' });
    }
    const branch = resumableTask ? await pr.client.rest.repos.getBranch({ owner: pr.owner, repo: pr.repo, branch: pr.pr.base.ref }) : null;
    const resumed = resumableTask ? await resumeWorkspace(path, { head: pr.pr.head.sha, base: pr.pr.base.sha,
      main: branch!.data.commit.sha, baseRef: pr.pr.base.ref, ownerRunId: runId, task: task as 'conflict' | 'ci' | 'repair' | 'review' }, trace,
      workspace => disposeWorkspacePath(config.root, repo, workspace, trace)) : null;
    if (!resumed && !discussingPause && retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status)) {
      const rejected = await readPaused(path);
      if (rejected?.status === 'stale') workspaceNotice = `原暂停工作区无法继续（${rejected.reason}）；旧证据已保留，本次按最新 Git 状态重新准备工作区，对话线程保持不变。\n\n`;
    }
    const freshWorkspace = async () => {
      const wsPath = runWorkspacePath(config.root, runId);
      createdWorkspace = wsPath;
      await createWorktree(config.root, repo, wsPath, pr.pr.head.sha, trace);
      return prepareWorkspace({ path: wsPath, headSha: pr.pr.head.sha, baseRef: pr.pr.base.ref, mergeBase: task === 'conflict' }, trace);
    };
    const ws = (approvedConflictRepair ? retained!.workspace : discussingPause ? retained!.workspace : resumed?.workspace) ?? await freshWorkspace();
    activeWorkspace = ws;
    await stop.guard();
    executionId = approvedConflictRepair ? retained!.execution_id : resumed?.execution_id ?? 1;
    trace.executionId = executionId;
    state.execution_id = executionId;
    const snapshot = approvedConflictRepair
      ? approvalSnapshot!
      : resumed
      ? (candidateSnapshot as { snapshot: import('../control-plane/snapshots.ts').CommandSnapshot }).snapshot
      : (await resolveExecution(controlPlane!, task === 'conversation' || task === 'stop' ? { kind: 'conversation', repositoryId: repository.id, executionId: `${runId}:${executionId}` } : {
        kind: 'command', repositoryId: repository.id, commandId: (intent as Extract<ParsedIntent, { kind: 'command' }>).commandId, executionId: `${runId}:${executionId}`
      })).snapshot;
    if (snapshot.template_type !== (task === 'stop' ? 'conversation' : task)) throw new Error('Resolved command snapshot template does not match the selected task.');
    runtimeExecution = runtimeExecutionFromSnapshot(snapshot, config.root);
    const snapshotReference = await writeCommandSnapshot(config.root, runId, snapshot, { allowLegacy: snapshot.schema_version.endsWith('legacy-v1') });
    manifest = { run_id: runId, repo, pr_number: number, initial_head_sha: pr.pr.head.sha,
      base_sha: pr.pr.base.sha, current_main_sha: null as string | null,
      current_base_ref: pr.pr.base.ref, current_base_tip_sha: null as string | null, workspace_base_tip_sha: null as string | null,
      pr_diff_basis: null as string | null,
      pr_thread_id: prThreadId(repo, number), execution_id: executionId, workspace_path: runWorkspacePath(config.root, runId),
      previous_execution_run_id: null as string | null,
      command: intent.kind === 'command' ? intent.slashName : task, command_id: snapshot.command?.id ?? null,
      command_revision: snapshot.command?.revision ?? snapshot.conversation_profile?.revision ?? null,
      provider_id: snapshot.provider.id, model_id: snapshot.provider.model.id, model: snapshot.provider.model.identifier,
      provider: snapshot.provider.base_url, reasoning_effort: snapshot.provider.request_options.reasoning_effort ?? null,
      task_chain: [] as string[], prompt_version: OPERATION_PROMPT_VERSION, toolset_version: snapshot.toolset_version,
      started_at: new Date(trace.started).toISOString(), entry: feedback ? 'github_comment' : 'github_api', github_snapshot_path: pr.snapshotPath,
      snapshot_path: snapshotReference.snapshot_path, snapshot_id: snapshotReference.snapshot_id, snapshot_sha256: snapshotReference.snapshot_sha256,
      snapshot_schema_version: snapshotReference.snapshot_schema_version, snapshot_execution_id: snapshot.execution_id,
      reply_to_run_id: feedback?.previous_run_id, human_comment_ids: feedback?.new_comment_ids,
      request_author: triggeringComment?.author };
    manifest.execution_id = executionId; manifest.workspace_path = ws.path;
    manifest.previous_execution_run_id = resumed?.run_id ?? null;
    if (resumed) {
      const previous = join(patchpawPaths(config.root).runs, resumed.run_id);
      const lastValidation = await readArtifact(previous, 'last-validation.json');
      if (lastValidation) trace.save('last-validation.json', lastValidation);
      const closeout = await readArtifact(previous, 'closeout.json');
      const stopReport = await readArtifact(previous, 'stop-report.json');
      if (stopReport) trace.save('resume-stop-report.json', stopReport);
      if (closeout) trace.save('resume-closeout.json', closeout);
      new Trace(previous).emit('execution_resumed', { next_run_id: runId, execution_id: executionId });
    }
    trace.emit(resumed ? 'execution_resumed' : 'execution_started', { execution_id: executionId, previous_run_id: resumed?.run_id, workspace: ws.path });
    manifest.current_main_sha = ws.mainSha;
    manifest.current_base_tip_sha = currentBase.sha;
    manifest.workspace_base_tip_sha = ws.mainSha;
    manifest.pr_diff_basis = `merge-base(${currentBase.sha}, ${pr.pr.head.sha}) -> ${pr.pr.head.sha}`;
    trace.save('manifest.json', manifest);
    if (task === 'conflict' && !approvedConflictRepair) {
      conflictEvidence = await captureExecutionBaseline(ws.path, trace, {
        repository: repo, prNumber: number, prHeadSha: pr.pr.head.sha, historicalBaseSha: pr.pr.base.sha,
        currentBaseTipSha: currentBase.sha, baseRef: pr.pr.base.ref, runId, executionId: snapshot.execution_id,
        commandSnapshotId: snapshot.snapshot_id, commandSnapshotSha256: snapshotReference.snapshot_sha256,
      });
    } else if (discussingConflict && currentConflictProposal) {
      // Discussion has its own Conversation snapshot, but evidence is still tied to the original
      // repair snapshot and retained workspace. This prevents a conversation snapshot replacing
      // the snapshot that a future approval would have to bind.
      conflictEvidence = await captureConflictWorkspaceEvidence(ws.path, {
        repository: repo, prNumber: number, prHeadSha: pr.pr.head.sha, historicalBaseSha: pr.pr.base.sha,
        currentBaseTipSha: currentBase.sha, baseRef: pr.pr.base.ref, runId, executionId: snapshot.execution_id,
        commandSnapshotId: currentConflictProposal.proposal.basis.command_snapshot_id,
        commandSnapshotSha256: currentConflictProposal.proposal.basis.command_snapshot_sha256,
      }, trace);
      const priorEvidence = await readArtifact(join(patchpawPaths(config.root).runs, currentConflictProposal.proposal.repair_run_id), 'workspace-evidence.json') as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
      if (!priorEvidence) {
        conflictWorkspaceStaleReason = 'workspace_evidence_missing';
      } else {
        const { evidence_sha256: storedHash, ...evidence } = priorEvidence;
        const evidenceHashMatches = storedHash === currentConflictProposal.proposal.basis.workspace_evidence_sha256
          && workspaceEvidenceSha256(evidence) === currentConflictProposal.proposal.basis.workspace_evidence_sha256;
        if (!evidenceHashMatches) conflictWorkspaceStaleReason = 'workspace_evidence_hash_mismatch';
        else {
          const compatibility = compareConflictWorkspaceEvidence(evidence, conflictEvidence.evidence);
          if (!compatibility.ok) conflictWorkspaceStaleReason = compatibility.reason;
        }
      }
    }
    if (discussingConflict && currentConflictProposal && conflictWorkspaceStaleReason) {
      await markCurrentConflictProposalStale(path, retained!.workspace.path, conflictWorkspaceStaleReason);
      await savePaused(path, { ...retained!, status: 'stale', reason: conflictWorkspaceStaleReason });
      state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained!.workspace.path), status: 'stale' };
      await writeState(path, { ...state, active: false, phase: 'stale' });
      return await finish('stale', { reason: `保留的 Conflict workspace 证据已变化（${conflictWorkspaceStaleReason}）；不会基于外部修改继续讨论或发布修订。请重新发送 /conflict。` });
    }
    const taskOptions = { task, prompt: '', ws, trace, runId, currentBase, execution: runtimeExecution!, prMemory: { root: patchpawPaths(config.root).memory, repo, number },
      repairStartHead: resumed ? (resumed.remote_head ?? ws.initialHead) : undefined,
      stopSignal: stop.signal, stopRequest: stop.request,
      onCloseout: () => phase('repair_closeout') };
    const seed = async () => ({ ...await seedContext(pr, ws, trace, currentBase), human_feedback: feedback,
      execution_id: executionId, resumed: !!resumed, retained_for_discussion: !!discussingPause, workspace_notice: workspaceNotice, previous_stop_report: resumed ? await readArtifact(trace.dir, 'resume-stop-report.json') : null,
      previous_closeout: resumed ? await readArtifact(trace.dir, 'resume-closeout.json') : null,
      conflict_workspace_evidence: conflictEvidence?.evidence ?? null,
      pending_conflict_proposal: discussingConflict || approvedConflictRepair ? currentConflictProposal?.proposal ?? null : null,
      conflict_approval: approvedConflictRepair ? approvalRecord ?? null : null,
      approved_conflict_proposal: approvedConflictRepair ? currentConflictProposal?.proposal ?? null : null });
    const beginTask = async (task: string) => { manifest.task_chain.push(task); trace.save('manifest.json', manifest);
      await stop!.guard();
      await phase(task === 'review' ? 'review_running' : task); };
    const assertCurrent = () => assertCurrentPR(pr, state.current_head_sha, ws.mainSha);
    const deliver = async (status: 'custom_completed' | 'conflict_completed' | 'ci_completed' | 'repair_completed', body: string) => {
      await stop!.guard();
      const paused = await readPaused(path);
      if (paused?.workspace.path === ws.path) await savePaused(path, { ...paused, status: 'completed' });
      const answer = JSON.parse(trace.clean(workspaceNotice + body)) as string;
      trace.save('delivery.json', { status, head_sha: state.current_head_sha, body: answer });
      const publication = (await deliverComment('delivery_report', `run:${runId}:delivery:${status}`, answer, recipients(), { run_id: runId, status })).publication;
      trace.save('delivery-publication.json', publication);
      await stop!.guard();
      return await finish(status, { answer, publication });
    };
    const retainConflictProposalWorkspace = async (proposalStatus: 'publication_pending' | 'awaiting_approval') => {
      await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: 'conflict', workspace: ws,
        base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, remote_head: pr.pr.head.sha, pause_phase: 'awaiting_approval',
        pause_reason: 'human_decision', status: proposalStatus });
    };
    const publishConflictProposal = async (proposal: ConflictProposal) => {
      try {
        // A model may have spent time reading before GitHub facts move. Never publish a plan
        // whose basis is no longer current; an awaiting human must be shown a fresh analysis.
        await assertCurrentPR(pr, proposal.basis.pr_head_sha, proposal.basis.current_base_tip_sha);
      } catch (error) {
        trace.emit('conflict_proposal_stale_before_persist', { proposal_revision: proposal.proposal_revision,
          proposal_hash: proposal.proposal_hash, reason: (error as Error).message });
        if (currentConflictProposal) {
          const oldWorkspacePath = currentConflictProposal.pointer.workspace_path;
          await markCurrentConflictProposalStale(path, oldWorkspacePath, 'git_facts_changed_before_publication');
          state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, oldWorkspacePath), status: 'stale' };
          await savePaused(path, { ...(await readPaused(path) ?? {
            task: 'conflict', run_id: currentConflictProposal.proposal.run_id, execution_id: executionId,
            base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, remote_head: pr.pr.head.sha,
            local_head: ws.initialHead, workspace: { ...ws, path: oldWorkspacePath },
          }), status: 'stale', reason: 'git_facts_changed_before_publication' });
        }
        return await finish('stale', { reason: 'Conflict 分析期间 PR head 或 current base 已变化；提案未保存/发布，旧版本已标记 stale。请重新发送 /conflict。' });
      }
      // The immutable version and the PR state pointer are durable before the outbox write.
      await saveConflictProposal(path, proposal, ws.path);
      await saveProposalState(path, proposal, ws.path, { ...state, phase: 'draft', active: true, waiting_for_ci: false });
      trace.save(`conflict-proposal-v${proposal.proposal_revision}.json`, proposal);
      trace.save('conflict-proposal.json', proposal);
      const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'conflict_proposal',
        semanticKey: proposalDeliverySemanticKey(proposal), body: renderConflictProposal(proposal), mentions: recipients(), botLogin,
        source: { run_id: runId, execution_id: proposal.execution_id, repair_execution_id: proposal.execution_id,
          proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
          pr_head_sha: proposal.basis.pr_head_sha, current_base_tip_sha: proposal.basis.current_base_tip_sha,
          base_ref: proposal.basis.base_ref, workspace_evidence_sha256: proposal.basis.workspace_evidence_sha256,
          command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256 } });
      await markConflictProposalStatus(path, proposal.proposal_revision, 'publication_pending', ws.path);
      await saveProposalState(path, { ...proposal, status: 'publication_pending' }, ws.path,
        { ...state, phase: 'publication_pending', active: false, waiting_for_ci: false });
      await retainConflictProposalWorkspace('publication_pending');
      const result = await deliverImmediately(config.root, stored, { client: pr.client, botLogin });
      trace.save('conflict-proposal-publication-attempt.json', result.publication);
      if (result.item.status !== 'delivered' || !result.item.receipt) {
        state.conflict_proposal = proposalPointerForState({ ...proposal, status: 'publication_pending' }, ws.path);
        return await finish('publication_pending', { reason: '结构化 Conflict Proposal 已保存并进入 durable outbox，但远程发布尚未确认；通信调度器将重试，不会生成第二个提案或通知。',
          proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash, publication: result.publication });
      }
      const publication = proposalPublicationFromOutbound(result.item);
      const published = await markConflictProposalStatus(path, proposal.proposal_revision, 'published', ws.path, publication);
      const publishedProposal = published?.proposal ?? { ...proposal, status: 'published' as const, publication };
      await saveProposalState(path, publishedProposal, ws.path, { ...state, phase: 'awaiting_approval', active: false, waiting_for_ci: false });
      state.conflict_proposal = proposalPointerForState(publishedProposal, ws.path);
      await retainConflictProposalWorkspace('awaiting_approval');
      await finalizeDelivery(config.root, stored);
      trace.save('conflict-proposal-publication.json', { ...publication, proposal_revision: proposal.proposal_revision,
        proposal_hash: proposal.proposal_hash, status: 'published' });
      trace.emit('conflict_proposal_published', { ...publication, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash });
      return await finish('awaiting_approval', { proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
        publication, answer: renderConflictProposal(publishedProposal) });
    };
    if (task === 'conversation' || task === 'stop') {
      await beginTask('conversation');
      const conversationTools = {
        read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior PR conversation comments for context, paginated oldest first.',
          inputSchema: z.object({ page: z.number().int().positive().default(1) }),
          execute: async ({ page }: { page: number }) => {
            const [owner, name] = repo.split('/');
            const { data } = await pr.client.rest.issues.listComments({ owner, repo: name, issue_number: number, per_page: 20, page });
            return excerpt(JSON.stringify(data.map(c => ({ id: c.id, author: c.user?.login, body: c.body, url: c.html_url }))));
          } }),
      };
      const conversation = await runConversation({ ...taskOptions, tools: {
        ...conversationTools,
      }, conflictDiscussion: discussingConflict && currentConflictProposal ? {
        proposalId: currentConflictProposal.proposal.proposal_id, revision: currentConflictProposal.proposal.proposal_revision,
        hash: currentConflictProposal.proposal.proposal_hash,
      } : undefined }, await seed());
      trace.save('conversation.json', conversation);
      if (conversation.kind === 'reply') {
        const body = JSON.parse(trace.clean(conversation.body)) as string;
        const publication = (await deliverComment('conversation_reply', `run:${runId}:conversation`, body, recipients(), { run_id: runId })).publication;
        trace.save('conversation-publication.json', publication);
        trace.emit('conversation_reply_published', publication);
        return await finish('conversation_completed', { answer: body, publication });
      }
      if (conversation.kind === 'proposal_revision' && currentConflictProposal && conflictEvidence) {
        await markConflictProposalStatus(path, currentConflictProposal.proposal.proposal_revision, 'superseded', ws.path);
        await cancelConflictProposalPublication(config.root, repo, number, currentConflictProposal.proposal);
        const revision = createConflictProposal({
          draft: conversation.draft, proposalId: currentConflictProposal.proposal.proposal_id,
          proposalRevision: currentConflictProposal.proposal.proposal_revision + 1,
          executionId: currentConflictProposal.proposal.execution_id, runId,
          repairRunId: currentConflictProposal.proposal.repair_run_id,
          basis: { ...currentConflictProposal.proposal.basis, pr_head_sha: pr.pr.head.sha,
            current_base_tip_sha: currentBase.sha, base_ref: currentBase.ref },
          discussion: { discussion_execution_id: snapshot.execution_id, discussion_snapshot_id: snapshot.snapshot_id,
            discussion_snapshot_sha256: snapshotReference.snapshot_sha256 },
        });
        return await publishConflictProposal(revision);
      }
      if (conversation.kind === 'proposal_revision') {
        return await finish('needs_human', { reason: '讨论提交的 Conflict Proposal 缺少可验证的当前提案或 workspace evidence；未发布任何修订。' });
      }
    }
    if (task === 'custom') {
      await beginTask('custom');
      const answer = await runCustom(taskOptions, await seed());
      return await deliver('custom_completed', answer);
    }
    const publish = async (kind: string) => {
      await stop!.guard();
      await assertCurrent();
      await stop!.guard();
      const previousHead = state.current_head_sha;
      const sha = await commitRepair(ws, kind, trace, previousHead);
      state.current_head_sha = sha; state.last_patchpaw_commit = sha;
      // Persist the candidate before push; passive synchronize never starts another task.
      await phase('publishing');
      await stop!.guard();
      await pushRepair(ws, pr.pr.head.ref, await token(), trace);
      trace.emit('repair_push', { kind, sha, branch: pr.pr.head.ref });
      await assertCurrentPR(pr, sha, ws.mainSha, previousHead);
      confirmedRemoteHead = sha;
      trace.emit('repair_push_confirmed', { sha, previous_head: previousHead });
      ws.mergePending = false; ws.unmerged = [];
    };
    if (task === 'review') {
      await beginTask('review');
      // A resumed review whose prior execution already settled its publication converges
      // mechanically from that durable remote evidence: no repeated model turn, no second review.
      const priorDir = resumed ? join(patchpawPaths(config.root).runs, resumed.run_id) : null;
      const settledPublication = priorDir ? await readArtifact(priorDir, 'review-publication.json') : null;
      if (settledPublication?.commit_id === state.current_head_sha) {
        const settledReview = await readArtifact(priorDir!, 'review.json');
        if (settledReview) {
          trace.save('resume-review.json', settledReview);
          trace.save('resume-review-publication.json', settledPublication);
          trace.save('review.json', settledReview);
          trace.save('review-publication.json', settledPublication);
          trace.emit('review_settled_resume', { previous_run_id: resumed!.run_id, commit_id: settledPublication.commit_id });
        }
      }
      const settled = await readArtifact(trace.dir, 'review-publication.json');
      if (!settled) {
        const review = await runReview(taskOptions, await seed());
        await stop.guard();
        if (workspaceNotice) review.summary = workspaceNotice + review.summary;
        trace.save('review.json', { head_sha: state.current_head_sha, ...review });
      }
      const connection = reviewConnection(config, repo, number);
      await stop!.guard();
      const paused = await readPaused(path);
      if (paused?.workspace.path === ws.path) await savePaused(path, { ...paused, status: 'completed' });
      const result = await completeReview({ trace, state, path, runtimeHome: config.root, recovered: false,
        settled_run_id: settled ? resumed?.run_id : undefined,
        connection: async () => ({ ...await connection(), mentions: recipients() }) });
      await stop.guard();
      return result;
    }
    if (task === 'conflict') {
      if (approvedConflictRepair) {
        if (!approvalRecord || !currentConflictProposal) throw new Error('Approved Conflict repair is missing its durable approval or proposal.');
        await beginTask('conflict-repair');
        const previousApprovalPhase = approvalRecord.phase;
        let repair: Awaited<ReturnType<typeof runRepair>> | undefined;
        const priorRepairRun = approvalRecord.repair_run_id && approvalRecord.repair_run_id !== runId
          ? approvalRecord.repair_run_id : undefined;
        const priorRepairResult = priorRepairRun
          ? await readArtifact(join(patchpawPaths(config.root).runs, priorRepairRun), 'repair-result.json') as Awaited<ReturnType<typeof runRepair>> | null
          : null;
        if (previousApprovalPhase === 'repairing' && !priorRepairResult) {
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
          await retainWorkspace(path, trace, { run_id: retained!.run_id, execution_id: retained!.execution_id, task: 'conflict', workspace: ws,
            base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, remote_head: confirmedRemoteHead, pause_phase: 'repairing',
            pause_reason: 'human_decision', status: 'needs_human' });
          return await finish('needs_human', { reason: '上一次 Conflict repair 在模型/验收结果落盘前中断；为避免重复调用模型，现有工作区与证据已保留，请人工检查后重新发送 /conflict。' });
        }
        if (priorRepairResult) {
          repair = priorRepairResult;
          trace.save('resumed-repair-result.json', repair);
          trace.emit('conflict_repair_result_reused', { approval_id: approvalRecord.approval_id, previous_run_id: priorRepairRun });
        } else if (['verification_passed', 'committing', 'committed', 'pushing', 'remote_confirmed', 'publication_pending'].includes(previousApprovalPhase)) {
          // The model and independent verification already have a durable result. Continue only
          // with mechanical commit/publish reconciliation; never ask the model to guess what it did.
          repair = await readArtifact(join(patchpawPaths(config.root).runs, approvalRecord.repair_run_id ?? runId), 'repair-result.json') as Awaited<ReturnType<typeof runRepair>> | null ?? undefined;
        } else {
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'repairing', repair_started_at: approvalRecord.repair_started_at ?? new Date().toISOString(), repair_run_id: runId }) ?? approvalRecord;
          await phase('repairing');
          repair = await runRepair(taskOptions, await seed());
          trace.save('repair-result.json', repair);
        }
        if (!repair || repair.status !== 'repaired') {
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
          await retainWorkspace(path, trace, { run_id: retained!.run_id, execution_id: retained!.execution_id, task: 'conflict', workspace: ws,
            base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, remote_head: confirmedRemoteHead, pause_phase: 'repairing',
            pause_reason: repair?.status === 'budget_exhausted' ? 'budget' : 'human_decision', status: repair?.status === 'budget_exhausted' ? 'budget_exhausted' : 'needs_human' });
          return await finish(repair?.status ?? 'needs_human', { reason: repair?.summary ?? 'Approved Conflict repair did not produce an independently verified result.' });
        }
        const repairEvidenceInput = {
          repository: repo, prNumber: number, prHeadSha: approvalRecord.pr_head_sha, historicalBaseSha: retained!.base_sha,
          currentBaseTipSha: currentBase.sha, baseRef: approvalRecord.base_ref, runId, executionId: approvalRecord.repair_execution_id,
          commandSnapshotId: approvalRecord.command_snapshot_id, commandSnapshotSha256: approvalRecord.command_snapshot_sha256,
        };
        const verificationPhases = ['verification_passed', 'committing', 'committed', 'pushing'];
        const repairEvidenceRun = approvalRecord.repair_run_id ?? runId;
        let verifiedEvidence: ConflictWorkspaceEvidence | null = null;
        if (priorRepairResult || verificationPhases.includes(previousApprovalPhase)) {
          const committedArtifact = ['committed', 'pushing'].includes(previousApprovalPhase)
            ? await readArtifact(join(patchpawPaths(config.root).runs, repairEvidenceRun), CONFLICT_REPAIR_COMMIT_EVIDENCE) as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null
            : null;
          const artifact = committedArtifact ?? await readArtifact(join(patchpawPaths(config.root).runs, repairEvidenceRun), CONFLICT_REPAIR_VERIFICATION_EVIDENCE) as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
          if (!artifact?.evidence_sha256) {
            approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted', rejection_code: 'workspace_missing' }) ?? approvalRecord;
            await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: 'conflict', workspace: ws,
              base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, remote_head: confirmedRemoteHead, pause_phase: previousApprovalPhase,
              pause_reason: 'human_decision', status: 'needs_human' });
            return await finish('needs_human', { reason: 'Approved Conflict 缺少可独立重建的 verification evidence；保留现有 workspace，不会重复调用模型或发布。' });
          }
          const { evidence_sha256: storedHash, ...evidence } = artifact;
          if (storedHash !== workspaceEvidenceSha256(evidence)) {
            approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { status: 'stale', phase: 'interrupted', rejection_code: 'workspace_changed' }) ?? approvalRecord;
            await markConflictProposalStatus(path, currentConflictProposal.proposal.proposal_revision, 'stale', ws.path);
            state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, ws.path), status: 'stale' };
            await savePaused(path, { ...(await readPaused(path) ?? retained!), status: 'stale', reason: 'verification_evidence_hash_mismatch' });
            return await finish('stale', { reason: 'Approved Conflict 的 verification evidence hash 不一致；不会把未知工作区提交或推送，请重新发送 /conflict。' });
          }
          verifiedEvidence = evidence;
        } else {
          verifiedEvidence = (await captureConflictWorkspaceEvidence(ws.path, repairEvidenceInput, trace, CONFLICT_REPAIR_VERIFICATION_EVIDENCE)).evidence;
        }
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'verification_passed', verification_at: new Date().toISOString() }) ?? approvalRecord;
        const startHead = approvalRecord.pr_head_sha;
        try {
          // Approval freshness is checked once more after the model turn and immediately before
          // the first Git mutation. A moving base or PR head therefore cannot be published by an
          // approval that was valid only when it arrived.
          if (previousApprovalPhase === 'pushing' && approvalRecord.commit_sha) {
            const currentRemote = await pr.client.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: number });
            const currentBaseBranch = await pr.client.rest.repos.getBranch({ owner: pr.owner, repo: pr.repo, branch: approvalRecord.base_ref });
            if (currentRemote.data.state !== 'open' || currentRemote.data.base.ref !== approvalRecord.base_ref
                || currentBaseBranch.data.commit.sha !== ws.mainSha
                || ![startHead, approvalRecord.commit_sha].includes(currentRemote.data.head.sha)) {
              throw new Error('PR head, base, or open state changed during run');
            }
          } else {
            await assertCurrentPR(pr, startHead, ws.mainSha, undefined, approvalRecord.base_ref, pr.pr.head.ref, repo);
          }
          const currentEvidence = (await captureConflictWorkspaceEvidence(ws.path, repairEvidenceInput, trace, 'conflict-repair-current-evidence.json')).evidence;
          const sameVerifiedWorkspace = compareConflictWorkspaceEvidence(verifiedEvidence!, currentEvidence).ok;
          const expectedCommit = approvalRecord.commit_sha;
          const committedCandidate = ['committing', 'committed', 'pushing'].includes(previousApprovalPhase)
            && committedRepairCandidate(verifiedEvidence!, currentEvidence, expectedCommit);
          if (!sameVerifiedWorkspace && !committedCandidate) throw new Error('Conflict repair workspace changed after verification');
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'committing' }) ?? approvalRecord;
          await phase('publishing');
          let sha = approvalRecord.commit_sha;
          if (!sha) {
            const workspaceHead = (await git(ws.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
            const workspaceStatus = (await git(ws.path, ['status', '--porcelain'], trace)).stdout.trim();
            const mergePending = (await git(ws.path, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true)).exitCode === 0;
            if (['committing', 'committed', 'pushing'].includes(previousApprovalPhase)
                && workspaceHead !== startHead && !workspaceStatus && !mergePending) sha = workspaceHead;
            else sha = await commitRepair(ws, 'conflict', trace, startHead);
            state.current_head_sha = sha; state.last_patchpaw_commit = sha;
            approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'committed', commit_sha: sha }) ?? approvalRecord;
            await captureConflictWorkspaceEvidence(ws.path, { ...repairEvidenceInput, runId }, trace, CONFLICT_REPAIR_COMMIT_EVIDENCE);
          } else {
            state.current_head_sha = sha; state.last_patchpaw_commit = sha;
            const commitEvidence = await readArtifact(join(patchpawPaths(config.root).runs, repairEvidenceRun), CONFLICT_REPAIR_COMMIT_EVIDENCE);
            if (!commitEvidence) await captureConflictWorkspaceEvidence(ws.path, { ...repairEvidenceInput, runId }, trace, CONFLICT_REPAIR_COMMIT_EVIDENCE);
          }
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'pushing' }) ?? approvalRecord;
          const remote = await pr.client.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: number });
          const remoteBase = await pr.client.rest.repos.getBranch({ owner: pr.owner, repo: pr.repo, branch: approvalRecord.base_ref });
          if (remote.data.state !== 'open' || remote.data.base.ref !== approvalRecord.base_ref || remoteBase.data.commit.sha !== ws.mainSha
              || remote.data.head.ref !== pr.pr.head.ref || remote.data.head.repo?.full_name !== repo) {
            throw new Error('PR head, base, or open state changed during run');
          }
          const remoteHeadBeforePush = remote.data.head.sha;
          // If the durable phase was written but the external push did not happen, retrying the
          // same recorded candidate is safe. If the remote already has that candidate, adoption
          // is also safe. Any third head is an external race and must stale the approval.
          if (remoteHeadBeforePush === startHead) await pushRepair(ws, pr.pr.head.ref, await token(), trace);
          else if (remoteHeadBeforePush !== sha) throw new Error('PR head, base, or open state changed during run');
          // Always perform the post-push freshness check, including the normal path. The pre-push
          // read is only a decision point; it is not evidence that the remote mutation settled.
          await assertCurrentPR(pr, sha, ws.mainSha, remoteHeadBeforePush === startHead ? startHead : undefined, approvalRecord.base_ref, pr.pr.head.ref, repo);
          confirmedRemoteHead = sha;
          ws.mergePending = false; ws.unmerged = [];
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'remote_confirmed', pushed_at: new Date().toISOString(), remote_head_sha: sha }) ?? approvalRecord;
          trace.emit('conflict_repair_push_confirmed', { approval_id: approvalRecord.approval_id, proposal_hash: approvalRecord.proposal_hash, sha });
        } catch (error) {
          const message = (error as Error).message;
          const stale = /PR head, base, or open state changed|Timed out confirming pushed PR head|Conflict repair workspace changed after verification/.test(message);
          if (stale) {
            approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed' }) ?? approvalRecord;
            await markConflictProposalStatus(path, currentConflictProposal.proposal.proposal_revision, 'stale', ws.path);
            await savePaused(path, { ...(await readPaused(path) ?? retained!), status: 'stale', reason: 'publication_freshness_failed' });
            state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, ws.path), status: 'stale' };
            return await finish('stale', { reason: '修复或发布前 Git freshness 检查失败（PR head/base/ref 或 PR 状态已变化）；没有继续发布，请重新发送 /conflict。' });
          }
          throw error;
        }
        const answer = JSON.parse(trace.clean(`## Conflict 修复完成\n\n${repair.summary}\n\n提交：\`${state.current_head_sha}\`\n本地验证：${repair.tests.join('；') || repair.validation_not_applicable}`)) as string;
        trace.save('delivery.json', { status: 'repair_completed', head_sha: state.current_head_sha, body: answer,
          approval_id: approvalRecord.approval_id, proposal_hash: approvalRecord.proposal_hash });
        const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'conflict_repair',
          semanticKey: approvalDeliverySemanticKey(approvalRecord), body: answer, mentions: recipients(), botLogin,
        source: { run_id: approvalRecord.repair_run_id ?? runId, approval_id: approvalRecord.approval_id, proposal_id: approvalRecord.proposal_id,
            proposal_revision: approvalRecord.proposal_revision, proposal_hash: approvalRecord.proposal_hash,
            commit_sha: state.current_head_sha, repair_execution_id: approvalRecord.repair_execution_id } });
        // The durable outbox row is the recovery marker. Enqueue it before changing the approval
        // phase so a crash cannot leave publication_pending with no row for the scheduler to find.
        const deliveryRunId = typeof stored.item.source.run_id === 'string' ? stored.item.source.run_id : runId;
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'publication_pending', claim_run_id: runId }) ?? approvalRecord;
        await savePaused(path, { ...(await readPaused(path) ?? retained!), status: 'publication_pending', run_id: deliveryRunId, pause_phase: 'publication_pending' });
        const published = await deliverImmediately(config.root, stored, { client: pr.client, botLogin });
        trace.save('conflict-repair-publication.json', published.publication);
        if (published.item.status !== 'delivered' || !published.item.receipt) {
          return await finish('publication_pending', { reason: 'Conflict 修复已独立验证并确认推送，但最终报告仍在 durable outbox 中；不会重复调用模型或重复推送。' });
        }
        const paused = await readPaused(path);
        if (paused?.workspace.path === ws.path) await savePaused(path, { ...paused, status: 'completed' });
        try { await disposeWorkspacePath(config.root, repo, ws.path, trace); }
        catch (error) {
          trace.emit('workspace_dispose_failed', { workspace: ws.path, message: (error as Error).message });
          return await finish('publication_pending', { reason: '最终报告已送达，但本地 workspace 清理尚未确认；durable outbox 将重试收敛，不会重复调用模型或推送。' });
        }
        const result = await finish('repair_completed', { answer, publication: published.publication });
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'completed', final_publication_delivery_id: published.item.delivery_id,
          final_publication_remote_id: published.item.receipt.id, final_published_at: published.item.receipt.published_at ?? new Date().toISOString() }) ?? approvalRecord;
        await finalizeDelivery(config.root, stored);
        return result;
      }
      if (!ws.mergePending && (!resumed || (resumed.local_head === pr.pr.head.sha && !(await git(ws.path, ['status', '--porcelain'])).stdout.trim()))) return await deliver('conflict_completed', '当前 PR 已包含目标分支，无需修复合并冲突；没有修改或提交代码。');
      await beginTask('conflict');
      const analysis = await runConflict({ ...taskOptions, tools: {
        read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior PR conversation comments for conflict context, paginated oldest first.',
          inputSchema: z.object({ page: z.number().int().positive().default(1) }),
          execute: async ({ page }: { page: number }) => {
            const [owner, name] = repo.split('/');
            const { data } = await pr.client.rest.issues.listComments({ owner, repo: name, issue_number: number, per_page: 20, page });
            return excerpt(JSON.stringify(data.map(c => ({ id: c.id, author: c.user?.login, body: c.body, url: c.html_url }))));
          } }),
      } }, await seed());
      trace.save('conflict-result.json', analysis);
      if (analysis.status === 'budget_exhausted' || analysis.status === 'needs_human') await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId,
        base_sha: pr.pr.base.sha, base_ref: pr.pr.base.ref, workspace: ws,
        pause_reason: analysis.status === 'needs_human' ? 'human_decision' : 'budget' });
      if (analysis.status !== 'proposal_submitted' || !conflictEvidence) {
        const reason = 'summary' in analysis ? analysis.summary : 'Conflict Agent 未能提交结构化 Proposal。';
        return await finish(analysis.status, { reason });
      }
      const proposal = createConflictProposal({
        draft: analysis.draft, proposalRevision: currentConflictProposal?.proposal.proposal_revision
          ? currentConflictProposal.proposal.proposal_revision + 1 : 1,
        proposalId: currentConflictProposal?.proposal.proposal_id,
        executionId: snapshot.execution_id, runId,
        basis: { pr_head_sha: pr.pr.head.sha, pr_head_ref: pr.pr.head.ref, pr_head_repo: repo, current_base_tip_sha: currentBase.sha, base_ref: currentBase.ref,
          workspace_evidence_sha256: conflictEvidence.evidenceSha256, command_snapshot_id: snapshot.snapshot_id,
          command_snapshot_sha256: snapshotReference.snapshot_sha256 },
      });
      if (currentConflictProposal && currentConflictProposal.proposal.proposal_revision < proposal.proposal_revision) {
        await markConflictProposalStatus(path, currentConflictProposal.proposal.proposal_revision, 'superseded', ws.path);
        await cancelConflictProposalPublication(config.root, repo, number, currentConflictProposal.proposal);
        if (currentConflictProposal.pointer.workspace_path !== ws.path) {
          try { await disposeWorkspacePath(config.root, repo, currentConflictProposal.pointer.workspace_path, trace); }
          catch (error) { trace.emit('superseded_workspace_dispose_failed', { workspace: currentConflictProposal.pointer.workspace_path, message: (error as Error).message }); }
        }
      }
      return await publishConflictProposal(proposal);
    }
    if (task === 'repair') {
      await beginTask('repair');
      const repair = await runRepair(taskOptions, await seed());
      trace.save('repair-result.json', repair);
      if (repair.status !== 'repaired') return await finish(repair.status, { reason: repair.summary });
      await publish('repair');
      return await deliver('repair_completed', `## 修复完成\n\n${repair.summary}\n\n提交：\`${state.current_head_sha}\`\n本地验证：${repair.tests.join('；') || repair.validation_not_applicable}`);
    }
    const repairs: { summary: string; sha: string; tests: string[] }[] = [];
    if (task === 'ci' && resumed && resumed.pause_phase !== 'ci') {
      await beginTask('ci-repair');
      const repair = await runCIRepair(taskOptions, { ...await seed(), instruction: 'Continue the retained CI candidate after the human pause. Recheck current code and request independent verification before publication.' });
      if (repair.status !== 'repaired') {
        return await finish(repair.status, { reason: repair.summary });
      }
      state.repair_attempts++;
      await publish('ci');
      repairs.push({ summary: repair.summary, sha: state.current_head_sha, tests: repair.tests });
    }
    for (;;) {
      await phase('ci');
      await assertCurrent();
      await stop.guard();
      const ci = await waitForCI(pr.client, repo, state.current_head_sha, trace, stop.signal);
      trace.save(`ci-${state.current_head_sha}.json`, ci);
      if (ci.state === 'pending') return await finish('needs_human', { reason: '等待 CI 的时间预算已用完，当前提交尚无完整终态，请检查是否需要批准工作流或补充外部条件。' });
      if (ci.state === 'green') return await deliver('ci_completed', `## CI 检查完成\n\n${repairs.length
        ? repairs.map((r, i) => `### 修复 ${i + 1}\n${r.summary}\n提交：\`${r.sha}\`\n本地验证：${r.tests.join('；')}`).join('\n\n')
        : '当前 CI 已通过，没有修改或提交代码。'}\n\n最终 head：\`${state.current_head_sha}\`\nGitHub CI：\n${ci.items.map(i => `- ${i.name}: ${i.conclusion} ${i.url ?? ''}`).join('\n')}`);
      if (state.repair_attempts >= budget.repairAttempts) return await finish('needs_human', {
        reason: `已完成 ${budget.repairAttempts} 轮 CI 修复提交，仍未通过，需要人工介入。\n${repairs.map(r => `${r.summary}\n提交：${r.sha}`).join('\n\n')}\n当前失败：\n${ci.items.filter(i => i.status === 'completed' && !['success', 'neutral', 'skipped'].includes(i.conclusion ?? ''))
          .map(i => `- ${i.name}: ${i.conclusion} ${i.url ?? ''}`).join('\n')}` });
      const evidence = await failureEvidence(pr.client, repo, ci, trace);
      await beginTask('ci-repair');
      state.repair_attempts++; await writeState(path, state);
      const repair = await runCIRepair({ ...taskOptions, evidence }, { ...await seed(), ci: excerpt(JSON.stringify(evidence)) });
      trace.save(`ci-repair-result-${state.repair_attempts}.json`, repair);
      if (repair.status !== 'repaired') return await finish(repair.status, { reason: repair.summary });
      await publish('ci');
      repairs.push({ summary: repair.summary, sha: state.current_head_sha, tests: repair.tests });
    }
  } catch (error) {
    if (error instanceof TaskStopped || stop?.signal.aborted) {
      if (approvalRecord?.status === 'accepted' && approvalRecord.phase !== 'completed') {
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
        trace.emit('conflict_approval_interrupted', { approval_id: approvalRecord.approval_id, reason: 'human_stop' });
      }
      if (activeWorkspace && inspected && ['conflict', 'ci', 'repair', 'review'].includes(activeTask)) {
        await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: activeTask as 'conflict' | 'ci' | 'repair' | 'review',
          base_sha: inspected.pr.base.sha, base_ref: inspected.pr.base.ref, workspace: activeWorkspace, pause_reason: 'human_stop',
          remote_head: confirmedRemoteHead, pause_phase: state.phase });
      }
      return await finish('stopped', { reason: error instanceof TaskStopped ? error.message : new TaskStopped().message });
    }
    if (approvalRecord?.status === 'accepted' && approvalRecord.phase === 'repairing') {
      approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
      trace.emit('conflict_approval_interrupted', { approval_id: approvalRecord.approval_id, reason: 'harness_or_provider_failure' });
    }
    if (error instanceof HumanHelpRequested) return await finish('needs_human', { reason: error.message });
    trace.emit('run_error', { phase: state.phase, ...providerError(error), message: (error as Error).message });
    if (await readArtifact(trace.dir, 'review.json')) {
      if (error instanceof OutboundPending) trace.save('result.json', { status: 'review_publication_pending', run_id: runId,
        repo, pr_number: number, final_head_sha: state.current_head_sha, delivery_id: error.delivery.delivery_id });
      state.active = false; await phase(await reviewCheckpoint(trace.dir));
      return { status: 'publication_interrupted', run_id: runId };
    }
    const failure = classifyRunFailure(error);
    return await finish(terminalStatusForFailure(failure), { failed_phase: state.phase,
      error: providerError(error), message: failure.message, failure });
  } finally {
    try { await stop?.close(); }
    finally { try { await disposeTerminalWorkspace(); } finally { try { if (ownsControlPlane) controlPlane?.close(); } finally { await release(); } } }
  }
}
