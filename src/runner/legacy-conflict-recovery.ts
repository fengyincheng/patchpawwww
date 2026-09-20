import { join } from 'node:path';
import type { ControlPlaneDb } from '../control-plane/db.ts';
import { getCommand } from '../control-plane/index.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import { disposeWorkspacePath, isManagedWorktree } from '../workspace/repo-store.ts';
import { Trace } from '../harness/trace.ts';
import { patchpawPaths } from '../config/paths.ts';
import { captureConflictWorkspaceEvidence, compareConflictWorkspaceEvidence, parseStoredConflictWorkspaceEvidence, workspaceEvidenceSha256 } from './workspace-evidence.ts';
import { approvalDeliverySemanticKey, updateConflictApproval, type ConflictApprovalRecord } from './conflict-approval.ts';
import { markConflictProposalStatus, proposalPointerForState } from './conflict-proposals.ts';
import { enqueueCommentDelivery, deliverImmediately, finalizeDelivery } from './outbound.ts';
import { readArtifact } from './review-lifecycle.ts';
import { readPaused, savePaused, type PausedWorkspace } from './resume.ts';
import { loadConflictApprovalSnapshot, CONFLICT_REPAIR_COMMIT_EVIDENCE } from './legacy-conflict.ts';
import type { RunState } from './state.ts';

type CurrentConflictProposal = NonNullable<Awaited<ReturnType<typeof import('./conflict-proposals.ts').readCurrentConflictProposal>>>;
type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }, persistedPhase?: string) => Promise<unknown>;

function cleanString(trace: Trace, value: string) {
  const cleaned: unknown = JSON.parse(trace.clean(value));
  if (typeof cleaned !== 'string') throw new Error('Recovered conflict answer did not remain a string after redaction');
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepairedResult(value: unknown): value is { status: 'repaired'; body?: string; summary?: string } {
  return isRecord(value) && value.status === 'repaired'
    && (typeof value.body === 'string' || typeof value.summary === 'string');
}

function bodyFromArtifact(value: unknown) {
  return isRecord(value) && typeof value.body === 'string' ? value.body : undefined;
}

export interface LegacyConflictRecoveryInput {
  root: string;
  statePath: string;
  repo: string;
  prNumber: number;
  runId: string;
  executionId: number;
  botLogin: string;
  trace: Trace;
  state: RunState;
  changeRequest: ChangeRequestSnapshot;
  scm: ScmAdapter;
  projectId: string;
  currentBase: { ref: string; sha: string };
  retained?: PausedWorkspace;
  currentConflictProposal?: CurrentConflictProposal;
  approvalRequested: boolean;
  approvalRecovery?: ConflictApprovalRecord;
  controlPlane?: ControlPlaneDb;
  recipients: () => string[];
  finish: Finish;
  confirmedRemoteHead?: string;
  setApprovalRecord: (record: ConflictApprovalRecord | undefined) => void;
  setConfirmedRemoteHead: (sha: string | undefined) => void;
}

type RecoveryResult = { handled: true; result: unknown; approvalRecord?: ConflictApprovalRecord; confirmedRemoteHead?: string } | { handled: false; approvalRecord?: ConflictApprovalRecord; confirmedRemoteHead?: string };

export async function recoverLegacyConflictApproval(input: LegacyConflictRecoveryInput): Promise<RecoveryResult> {
  const { root, statePath, repo, prNumber, runId, executionId, botLogin, trace, state, changeRequest, scm, projectId, currentBase,
    retained, currentConflictProposal, approvalRequested, approvalRecovery, controlPlane, recipients, finish } = input;
  let approvalRecord = approvalRecovery;
  let confirmedRemoteHead = input.confirmedRemoteHead;
  const saveApproval = async (patch: Parameters<typeof updateConflictApproval>[2]) => {
    if (!approvalRecord) return undefined;
    approvalRecord = await updateConflictApproval(statePath, approvalRecord.approval_id, patch) ?? approvalRecord;
    input.setApprovalRecord(approvalRecord);
    return approvalRecord;
  };
  const staleApprovedRepair = async (reason: string): Promise<RecoveryResult> => {
    if (approvalRecord && currentConflictProposal && retained) {
      await saveApproval({ status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed' });
      await markConflictProposalStatus(statePath, currentConflictProposal.proposal.proposal_revision, 'stale', retained.workspace.path);
      await savePaused(statePath, { ...retained, status: 'stale', reason });
      state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained.workspace.path), status: 'stale' };
      try { await disposeWorkspacePath(root, repo, retained.workspace.path, trace); }
      catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained.workspace.path, reason, message: (error as Error).message }); }
    }
    return { handled: true, result: await finish('stale', { reason }), approvalRecord, confirmedRemoteHead };
  };
  const retireSupersededApproval = async (reason: string): Promise<RecoveryResult> => {
    await saveApproval({ status: 'stale', phase: 'interrupted', rejection_code: 'proposal_stale' });
    return { handled: true, result: await finish('needs_human', { reason, approval_rejection_code: 'proposal_stale' },
      currentConflictProposal?.proposal.status === 'published' ? 'awaiting_approval' : 'needs_human'), approvalRecord, confirmedRemoteHead };
  };

  if (approvalRequested && approvalRecovery) {
    const current = currentConflictProposal?.proposal;
    if (!current || current.proposal_id !== approvalRecovery.proposal_id
        || current.proposal_revision !== approvalRecovery.proposal_revision
        || current.proposal_hash !== approvalRecovery.proposal_hash) {
      return retireSupersededApproval('已有更新的 Conflict Proposal；旧 Approval 已标记 stale，不会发布旧修复报告。请对当前版本重新发送 /approval。');
    }
    if (current.status !== 'published'
        || approvalRecovery.base_ref !== currentBase.ref
        || current.basis.base_ref !== currentBase.ref
        || approvalRecovery.pr_head_sha !== current.basis.pr_head_sha
        || approvalRecovery.pr_head_ref !== current.basis.pr_head_ref
        || !current.basis.pr_head_repo || approvalRecovery.pr_head_repo.toLowerCase() !== current.basis.pr_head_repo.toLowerCase()
        || approvalRecovery.current_base_tip_sha !== current.basis.current_base_tip_sha
        || approvalRecovery.command_snapshot_id !== current.basis.command_snapshot_id
        || approvalRecovery.command_snapshot_sha256 !== current.basis.command_snapshot_sha256) {
      return staleApprovedRepair('Approval 绑定的 Proposal、base ref、Git 事实或 Command Snapshot 已变化；旧修复不会继续发布，请重新发送 /conflict。');
    }
  }

  if (approvalRequested && approvalRecovery && currentConflictProposal
      && ['remote_confirmed', 'publication_pending'].includes(approvalRecovery.phase)) {
    const remoteHead = approvalRecovery.remote_head_sha;
    if (!remoteHead || !retained) {
      await saveApproval({ phase: 'interrupted', rejection_code: 'workspace_missing' });
      return { handled: true, result: await finish('needs_human', { reason: '已确认远程修复提交，但 retained workspace 证据已丢失；没有重复调用模型或推送，请人工检查后重新发送 /conflict。' }, 'needs_human'), approvalRecord, confirmedRemoteHead };
    }
    const currentFacts = await scm.readChangeRequest(projectId, prNumber, { allowClosed: true });
    if (!['open', 'opened'].includes(currentFacts.state) || currentFacts.source.sha !== remoteHead
        || currentFacts.source.ref !== approvalRecovery.pr_head_ref
        || currentFacts.source.pathWithNamespace.toLowerCase() !== approvalRecovery.pr_head_repo.toLowerCase()
        || currentFacts.target.ref !== approvalRecovery.base_ref || currentFacts.target.sha !== currentBase.sha) {
      return staleApprovedRepair('最终发布前 change request freshness 检查失败；已确认的修复不会重复推送，请重新发送 /conflict。');
    }
    const repairRun = approvalRecovery.repair_run_id ?? state.run_id;
    try {
      const recoveredSnapshot = await loadConflictApprovalSnapshot(root, currentConflictProposal.proposal);
      const recoveredCommand = recoveredSnapshot.snapshot.command && controlPlane
        ? await getCommand(controlPlane, recoveredSnapshot.snapshot.command.id) : undefined;
      if (!recoveredCommand || !recoveredCommand.enabled || recoveredCommand.executionType !== 'conflict' || recoveredCommand.permission !== 'read_write') {
        throw new Error('the bound Conflict Command is missing, disabled, or no longer read_write');
      }
      if (!await isManagedWorktree(root, repo, retained.workspace.path, undefined, trace)) throw new Error('retained workspace is not a managed worktree');
      const commitArtifact = parseStoredConflictWorkspaceEvidence(await readArtifact(join(patchpawPaths(root).runs, repairRun), CONFLICT_REPAIR_COMMIT_EVIDENCE));
      if (!commitArtifact?.evidence_sha256) throw new Error('commit evidence is missing');
      const { evidence_sha256: storedHash, ...commitEvidence } = commitArtifact;
      if (storedHash !== workspaceEvidenceSha256(commitEvidence) || commitEvidence.workspace_head !== remoteHead) throw new Error('commit evidence is invalid');
      const currentEvidence = (await captureConflictWorkspaceEvidence(retained.workspace.path, {
        repository: repo, prNumber, prHeadSha: approvalRecovery.pr_head_sha, historicalBaseSha: retained.base_sha,
        currentBaseTipSha: currentBase.sha, baseRef: approvalRecovery.base_ref, runId, executionId: approvalRecovery.repair_execution_id,
        commandSnapshotId: approvalRecovery.command_snapshot_id, commandSnapshotSha256: approvalRecovery.command_snapshot_sha256,
      }, trace, 'conflict-repair-recovery-evidence.json')).evidence;
      if (!compareConflictWorkspaceEvidence(commitEvidence, currentEvidence).ok) throw new Error('retained workspace differs from committed evidence');
    } catch (error) {
      await saveApproval({ phase: 'interrupted', rejection_code: 'workspace_changed' });
      return { handled: true, result: await finish('needs_human', { reason: `已确认远程修复提交，但本地恢复证据校验失败（${(error as Error).message}）；不会重复调用模型或推送，请人工检查后重新发送 /conflict。` }, 'needs_human'), approvalRecord, confirmedRemoteHead };
    }
    const repairValue: unknown = await readArtifact(join(patchpawPaths(root).runs, repairRun), 'repair-result.json');
    if (!isRepairedResult(repairValue)) {
      await saveApproval({ phase: 'interrupted' });
      return { handled: true, result: await finish('needs_human', { reason: '已确认远程修复提交，但缺少可独立重建的 repair-result 证据；没有重复调用模型或推送，请人工检查后重新发送 /conflict。' }, 'needs_human'), approvalRecord, confirmedRemoteHead };
    }
    state.current_head_sha = remoteHead; confirmedRemoteHead = remoteHead; input.setConfirmedRemoteHead(remoteHead);
    const oldDelivery = bodyFromArtifact(await readArtifact(join(patchpawPaths(root).runs, repairRun), 'delivery.json'));
    const repairBody = repairValue.body ?? repairValue.summary;
    const answer = oldDelivery ?? cleanString(trace, `## Conflict 修复完成\n\n${repairBody}\n\n提交：\`${remoteHead}\``);
    trace.save('delivery.json', { status: 'repair_completed', head_sha: remoteHead, body: answer,
      approval_id: approvalRecovery.approval_id, proposal_hash: approvalRecovery.proposal_hash, recovered_from_run_id: repairRun });
    const stored = await enqueueCommentDelivery({ root, repo, prNumber, purpose: 'conflict_repair',
      semanticKey: approvalDeliverySemanticKey(approvalRecovery), body: answer, mentions: recipients(), botLogin,
      source: { run_id: approvalRecovery.repair_run_id ?? runId, approval_id: approvalRecovery.approval_id, proposal_id: approvalRecovery.proposal_id,
        proposal_revision: approvalRecovery.proposal_revision, proposal_hash: approvalRecovery.proposal_hash,
        commit_sha: remoteHead, repair_execution_id: approvalRecovery.repair_execution_id } });
    const deliveryRunId = typeof stored.item.source.run_id === 'string' ? stored.item.source.run_id : runId;
    await saveApproval({ phase: 'publication_pending', claim_run_id: runId });
    await savePaused(statePath, { ...retained, status: 'publication_pending', run_id: deliveryRunId, pause_phase: 'publication_pending' });
    const published = await deliverImmediately(root, stored, { adapter: scm, botLogin });
    trace.save('conflict-repair-publication.json', published.publication);
    if (published.item.status !== 'delivered' || !published.item.receipt) {
      return { handled: true, result: await finish('publication_pending', { reason: '已确认远程修复提交，最终报告仍在 durable outbox 中；恢复不会重复调用模型或推送。' }), approvalRecord, confirmedRemoteHead };
    }
    const paused = await readPaused(statePath);
    if (paused?.workspace.path === retained.workspace.path) await savePaused(statePath, { ...paused, status: 'completed' });
    try { await disposeWorkspacePath(root, repo, retained.workspace.path, trace); }
    catch (error) {
      trace.emit('workspace_dispose_failed', { workspace: retained.workspace.path, message: (error as Error).message });
      return { handled: true, result: await finish('publication_pending', { reason: '最终报告已送达，但本地 workspace 清理尚未确认；durable outbox 将重试收敛，不会重复调用模型或推送。' }), approvalRecord, confirmedRemoteHead };
    }
    const result = await finish('repair_completed', { answer, publication: published.publication });
    await saveApproval({ phase: 'completed', final_publication_delivery_id: published.item.delivery_id, final_publication_remote_id: published.item.receipt.id,
      final_published_at: published.item.receipt.published_at ?? new Date().toISOString() });
    await finalizeDelivery(root, stored);
    return { handled: true, result, approvalRecord, confirmedRemoteHead };
  }
  return { handled: false, approvalRecord, confirmedRemoteHead };
}
