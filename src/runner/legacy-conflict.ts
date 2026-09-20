import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { captureConflictWorkspaceEvidence, compareConflictWorkspaceEvidence, parseStoredConflictWorkspaceEvidence, workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { readArtifact } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import { getCommand, snapshotSha256, validateCommandSnapshot } from '../control-plane/index.ts';
import type { CommandSnapshot } from '../control-plane/snapshots.ts';
import type { ControlPlaneDb } from '../control-plane/db.ts';
import type { HumanReply } from './human-reply.ts';
import { isSameRepoWriteback } from './command-approval.ts';
import { isManagedWorktree } from '../workspace/repo-store.ts';
import { readPaused, savePaused } from './resume.ts';
import { applyRunPhase } from './phases.ts';
import { writeState, type RunState } from './state.ts';
import { proposalDeliverySemanticKey, proposalPointerForState, readCurrentConflictProposal, type ConflictProposal } from './conflict-proposals.ts';
import {
  newConflictApproval, readConflictApprovalByIdempotency, saveConflictApproval, updateConflictApproval,
  type ConflictApprovalRecord, type ConflictApprovalRejectionCode,
} from './conflict-approval.ts';
import { listOutbound } from './outbound.ts';
import { Trace } from '../harness/trace.ts';

export class ConflictApprovalRejected extends Error {
  constructor(readonly code: ConflictApprovalRejectionCode, message: string) {
    super(message);
    this.name = 'ConflictApprovalRejected';
  }
}

function rejectApproval(code: ConflictApprovalRejectionCode, message: string): never {
  throw new ConflictApprovalRejected(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const CONFLICT_REPAIR_VERIFICATION_EVIDENCE = 'conflict-repair-verification-evidence.json';
export const CONFLICT_REPAIR_COMMIT_EVIDENCE = 'conflict-repair-commit-evidence.json';

export function committedRepairCandidate(previous: ConflictWorkspaceEvidence, current: ConflictWorkspaceEvidence, expectedHead?: string) {
  const fields: (keyof ConflictWorkspaceEvidence)[] = [
    'repository', 'pr_number', 'pr_head_sha', 'historical_base_sha', 'current_base_tip_sha', 'base_ref',
    'initial_head', 'merge_base', 'unresolved_paths', 'pr_diff_paths', 'current_base_affected_paths', 'files',
  ];
  return fields.every(field => JSON.stringify(previous[field]) === JSON.stringify(current[field]))
    && current.workspace_head !== previous.workspace_head
    && (!expectedHead || current.workspace_head === expectedHead)
    && !current.git_status_porcelain_v2.trim() && !current.git_index.trim() && !current.git_unmerged_index.trim()
    && current.merge_head === null && !current.merge_pending;
}

export async function loadConflictApprovalSnapshot(root: string, proposal: ConflictProposal): Promise<{ snapshot: CommandSnapshot; hash: string; path: string }> {
  const path = join(patchpawPaths(root).runs, proposal.repair_run_id, 'command-snapshot.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') rejectApproval('snapshot_missing', 'Conflict Proposal 绑定的 Command Snapshot 不存在；旧工作区与证据保留，请重新发送 /conflict。');
    rejectApproval('snapshot_corrupt', 'Conflict Proposal 绑定的 Command Snapshot 无法安全读取；旧工作区与证据保留，请重新发送 /conflict。');
  }
  const schemaVersion = isRecord(raw) && typeof raw.schema_version === 'string' ? raw.schema_version : undefined;
  const allowLegacy = schemaVersion?.endsWith('legacy-v1') ?? false;
  let snapshot: CommandSnapshot;
  try { snapshot = validateCommandSnapshot(raw, { allowLegacy }); }
  catch { rejectApproval('snapshot_corrupt', 'Conflict Proposal 绑定的 Command Snapshot 校验失败；不会套用当前配置，请重新发送 /conflict。'); }
  const hash = snapshotSha256(snapshot);
  if (hash !== proposal.basis.command_snapshot_sha256 || snapshot.snapshot_id !== proposal.basis.command_snapshot_id
      || snapshot.execution_id !== proposal.repair_execution_id) {
    rejectApproval('snapshot_hash_mismatch', 'Conflict Proposal 的 Command Snapshot id/hash 不一致；不会使用最新配置替代原审批快照。');
  }
  if (snapshot.template_type !== 'conflict' || snapshot.target !== 'command' || snapshot.command?.permission !== 'read_write') {
    rejectApproval('command_read_only', 'Conflict Proposal 的原始命令快照不是 Read + Write；审批不会升级权限或启动修复。');
  }
  return { snapshot, hash, path };
}

async function readConflictEvidence(root: string, proposal: ConflictProposal) {
  const artifact = parseStoredConflictWorkspaceEvidence(await readArtifact(join(patchpawPaths(root).runs, proposal.repair_run_id), 'workspace-evidence.json'));
  if (!artifact?.evidence_sha256) rejectApproval('workspace_missing', 'Conflict Proposal 的 WorkspaceEvidence 缺失；不会在未知工作区上修复，请重新发送 /conflict。');
  const { evidence_sha256, ...evidence } = artifact;
  if (evidence_sha256 !== proposal.basis.workspace_evidence_sha256 || workspaceEvidenceSha256(evidence) !== proposal.basis.workspace_evidence_sha256) {
    rejectApproval('workspace_changed', 'Conflict Proposal 的 WorkspaceEvidence hash 不一致；工作区可能被外部修改，请重新发送 /conflict。');
  }
  return evidence;
}

function qualifiedApprovalActor(reply: Pick<HumanReply, 'author' | 'author_association'>, botLogin: string) {
  // This is a legacy Conflict-only compatibility guard. Generic ApprovalPlan uses provenance
  // rather than actor-role qualification and does not call this adapter.
  if (reply.author.toLowerCase() === botLogin.toLowerCase() || reply.author.toLowerCase().endsWith('[bot]')) return false;
  return true;
}

export async function prepareConflictApproval(input: {
  root: string; statePath: string; repo: string; prNumber: number; runId: string; botLogin: string;
  trace: Trace; state: RunState; changeRequest: ChangeRequestSnapshot; scm: ScmAdapter; projectId: string; currentBase: { ref: string; sha: string };
  retained: Awaited<ReturnType<typeof readPaused>>; current: Awaited<ReturnType<typeof readCurrentConflictProposal>>;
  reply?: HumanReply; recovery?: ConflictApprovalRecord; controlPlane: ControlPlaneDb;
}): Promise<{ record: ConflictApprovalRecord; proposal: ConflictProposal; snapshot: CommandSnapshot; evidence: ConflictWorkspaceEvidence } | { rejected: ConflictApprovalRejected }> {
  const { root, statePath, repo, prNumber, runId, botLogin, trace, state, changeRequest, scm, projectId, currentBase, retained, current, reply, recovery, controlPlane } = input;
  try {
    if (!['open', 'opened'].includes(changeRequest.state)) rejectApproval('pr_closed', 'Change request 已关闭；迟到的 /approval 不会复活已退休的本地 generation。');
    if (reply && (!reply.source_event_id || (!reply.author_association && !reply.author_id))) rejectApproval('approval_event_invalid', 'Approval 必须来自已验证的 SCM webhook，并带有 source event 与 actor provenance；不会把本地缺失 provenance 的评论当作授权。');
    if (reply && !qualifiedApprovalActor(reply, botLogin)) rejectApproval('unauthorized_actor', '该 /approval 评论者没有 OWNER、MEMBER 或 COLLABORATOR 审批资格。');
    if (reply?.author_id && reply.repository_path && reply.project_id && reply.source_event_id) {
      const authorization = await scm.verifyInboundComment({ platform: scm.kind, connectionId: scm.connection.id,
        projectId, storageKey: repo,
        repositoryPath: reply.repository_path, changeRequestNumber: prNumber, remoteId: reply.comment_id,
        authorId: reply.author_id, authorLogin: reply.author, body: reply.body, url: reply.url,
        createdAt: reply.created_at, sourceEventId: reply.source_event_id });
      if (!authorization.canApprove) rejectApproval('unauthorized_actor', 'Approval 评论者当前没有有效的 SCM 审批权限。');
    }
    if (!current) rejectApproval('no_pending_proposal', '没有可审批的 Conflict Proposal；请先发送 /conflict。');
    const proposal = current.proposal;
    if (!isSameRepoWriteback(changeRequest, repo)) rejectApproval('git_facts_changed', '该 change request 来自 fork；PatchPaw 不支持向来源 fork 写回。');
    if (!proposal.basis.pr_head_ref || !proposal.basis.pr_head_repo
        || proposal.basis.pr_head_ref !== changeRequest.source.ref || proposal.basis.pr_head_repo.toLowerCase() !== changeRequest.source.pathWithNamespace.toLowerCase()) {
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

    if (proposal.basis.pr_head_sha !== changeRequest.source.sha || proposal.basis.current_base_tip_sha !== currentBase.sha || proposal.basis.base_ref !== currentBase.ref) {
      rejectApproval('git_facts_changed', 'PR head、current base tip 或 base ref 已变化；旧 Proposal 已失去审批前提，请重新发送 /conflict。');
    }
    const proposalHeadRef = proposal.basis.pr_head_ref;
    const proposalHeadRepo = proposal.basis.pr_head_repo;
    if (!proposalHeadRef || !proposalHeadRepo) {
      rejectApproval('git_facts_changed', 'Approval 绑定的 Proposal 缺少来源分支或仓库事实；请重新发送 /conflict。');
    }
    const publication = (await listOutbound(root, { repo, prNumber })).find(value => value.item.semantic_key === proposalDeliverySemanticKey(proposal));
    if (!publication || publication.item.status !== 'delivered' || !publication.item.receipt || publication.item.receipt.id !== proposal.publication.remote_id) {
      rejectApproval('proposal_publication_missing', '当前 Proposal 的远程 publication receipt 不完整；不会在未确认的人类可见提案上修复。');
    }
    const currentFacts = await scm.readChangeRequest(projectId, prNumber, { allowClosed: true });
    if (!['open', 'opened'].includes(currentFacts.state) || currentFacts.source.sha !== proposal.basis.pr_head_sha
        || currentFacts.source.ref !== proposalHeadRef
        || currentFacts.source.pathWithNamespace.toLowerCase() !== proposalHeadRepo.toLowerCase()
        || currentFacts.target.ref !== proposal.basis.base_ref || currentFacts.target.sha !== currentBase.sha) {
      rejectApproval('git_facts_changed', '审批领取前 change request head、来源分支、current base 或状态已变化；旧 Proposal 已失去审批前提，请重新发送 /conflict。');
    }
    const evidence = (await captureConflictWorkspaceEvidence(retained.workspace.path, {
      repository: repo, prNumber, prHeadSha: changeRequest.source.sha, historicalBaseSha: changeRequest.diffBaseSha ?? changeRequest.target.sha,
      currentBaseTipSha: currentBase.sha, baseRef: currentBase.ref, runId, executionId: proposal.repair_execution_id,
      commandSnapshotId: snapshotInfo.snapshot.snapshot_id, commandSnapshotSha256: snapshotInfo.hash,
    }, trace)).evidence;
    if (!recovery || ['accepted', 'claimed'].includes(recovery.phase)) {
      const originalEvidence = await readConflictEvidence(root, proposal);
      const compatibility = compareConflictWorkspaceEvidence(originalEvidence, evidence);
      if (!compatibility.ok) rejectApproval('workspace_changed', 'retained workspace 与审批前证据不一致（' + compatibility.reason + '）；请重新发送 /conflict。');
    }

    let record = recovery;
    if (!record && reply) {
      const idempotencyKey = 'approval:' + reply.comment_id + ':' + proposal.proposal_hash + ':' + proposal.repair_execution_id;
      record = await readConflictApprovalByIdempotency(statePath, idempotencyKey) ?? undefined;
      if (!record) {
        const sourceEventId = reply.source_event_id;
        if (!sourceEventId) rejectApproval('approval_event_invalid', 'Approval 缺少已验证的 source event；不会把本地评论当作授权。');
        record = newConflictApproval({
          source_event_id: sourceEventId, source_comment_id: reply.comment_id,
          source_comment_url: reply.url, source_comment_created_at: reply.created_at, author: reply.author, author_association: reply.author_association ?? 'OWNER',
          received_at: new Date().toISOString(), verified_at: new Date().toISOString(), repair_execution_id: proposal.repair_execution_id,
          proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
          proposal_publication_delivery_id: proposal.publication.delivery_id, proposal_publication_remote_id: proposal.publication.remote_id,
          pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: proposalHeadRef, pr_head_repo: proposalHeadRepo,
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
      claim_run_id: runId, repair_run_id: record.repair_run_id ?? runId, claimed_at: claimedAt,
    }) ?? record;
    state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), record.source_comment_id])];
    await writeState(statePath, applyRunPhase({ ...state, run_id: runId, pid: process.pid, active: true,
          current_head_sha: changeRequest.source.sha, conflict_proposal: { ...proposalPointerForState(proposal, retained.workspace.path), status: 'published' } }, 'claimed'));
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
          pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: changeRequest.source.ref, pr_head_repo: changeRequest.source.pathWithNamespace,
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
