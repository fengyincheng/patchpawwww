import { join } from 'node:path';
import type { WorkspaceState } from '../workspace/manager.ts';
import { disposeWorkspacePath } from '../workspace/repo-store.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import { runRepair, type OpaqueRepairResult } from '../tasks/repair.ts';
import type { TaskOptions } from '../harness/runtime.ts';
import { Trace } from '../harness/trace.ts';
import { readArtifact } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readPaused, retainWorkspace, savePaused } from './resume.ts';
import { captureConflictWorkspaceEvidence, compareConflictWorkspaceEvidence, parseStoredConflictWorkspaceEvidence, workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { committedRepairCandidate } from './legacy-conflict.ts';
import { approvalDeliverySemanticKey, updateConflictApproval, type ConflictApprovalRecord } from './conflict-approval.ts';
import { markConflictProposalStatus, proposalPointerForState, type ConflictProposal } from './conflict-proposals.ts';
import { enqueueCommentDelivery, deliverImmediately, finalizeDelivery } from './outbound.ts';
import { isSameRepoWriteback } from './command-approval.ts';
import { decideWriteback, performWriteback } from './writeback.ts';
import type { RunState } from './state.ts';

type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }, persistedPhase?: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(trace: Trace, value: string) {
  const cleaned: unknown = JSON.parse(trace.clean(value));
  if (typeof cleaned !== 'string') throw new Error('Conflict repair answer did not remain a string after redaction');
  return cleaned;
}

export interface LegacyConflictRepairInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  executionId: number;
  path: string;
  trace: Trace;
  changeRequest: ChangeRequestSnapshot;
  scm: ScmAdapter;
  projectId: string;
  currentBase: { ref: string; sha: string };
  retained: NonNullable<Awaited<ReturnType<typeof readPaused>>>;
  workspace: WorkspaceState;
  state: RunState;
  approvalRecord: ConflictApprovalRecord;
  proposal: ConflictProposal;
  confirmedRemoteHead?: string;
  taskOptions: TaskOptions;
  seed: () => Promise<unknown>;
  phase: (phase: string) => Promise<void>;
  finish: Finish;
  token: () => Promise<string>;
  guard: () => Promise<void>;
  botLogin: string;
  recipients: () => string[];
  setApprovalRecord: (record: ConflictApprovalRecord) => void;
  setConfirmedRemoteHead: (sha: string) => void;
}

export interface LegacyConflictRepairOutcome {
  result: unknown;
  approvalRecord: ConflictApprovalRecord;
  confirmedRemoteHead?: string;
}

const VERIFICATION_EVIDENCE = 'conflict-repair-verification-evidence.json';
const COMMIT_EVIDENCE = 'conflict-repair-commit-evidence.json';

async function completed(input: LegacyConflictRepairInput, approvalRecord: ConflictApprovalRecord, confirmedRemoteHead: string | undefined,
  status: string, extra: { reason?: string; message?: string; [key: string]: unknown } = {}, persistedPhase = status): Promise<LegacyConflictRepairOutcome> {
  return { result: await input.finish(status, extra, persistedPhase), approvalRecord, confirmedRemoteHead };
}

export async function runLegacyConflictRepair(input: LegacyConflictRepairInput): Promise<LegacyConflictRepairOutcome> {
  const { root, repo, prNumber, runId, executionId, path, trace, changeRequest, scm, projectId, currentBase, retained, workspace, state,
    taskOptions, seed, phase, finish, token, guard, botLogin, recipients, proposal, setApprovalRecord, setConfirmedRemoteHead } = input;
  let approvalRecord = input.approvalRecord;
  let confirmedRemoteHead: string | undefined = input.confirmedRemoteHead;
  const persistApproval = async (patch: Parameters<typeof updateConflictApproval>[2]) => {
    approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, patch) ?? approvalRecord;
    setApprovalRecord(approvalRecord);
    return approvalRecord;
  };
  const previousApprovalPhase = approvalRecord.phase;
  type StoredRepairResult = OpaqueRepairResult | { status: 'repaired'; summary: string; tests?: string[]; validation_not_applicable?: string | null; warnings?: string[] };
  const parseStoredRepairResult = (value: unknown): StoredRepairResult | null => {
    if (!isRecord(value)) return null;
    const record = value;
    if (record.status === 'repaired' && typeof record.body === 'string') return { status: 'repaired', body: record.body };
    if (record.status === 'repaired' && typeof record.summary === 'string') {
      return { status: 'repaired', summary: record.summary,
        ...(Array.isArray(record.tests) && record.tests.every(test => typeof test === 'string') ? { tests: record.tests } : {}),
        ...(typeof record.validation_not_applicable === 'string' || record.validation_not_applicable === null ? { validation_not_applicable: record.validation_not_applicable } : {}),
        ...(Array.isArray(record.warnings) && record.warnings.every(warning => typeof warning === 'string') ? { warnings: record.warnings } : {}) };
    }
    if ((record.status === 'needs_human' || record.status === 'budget_exhausted') && typeof record.summary === 'string') {
      return { status: record.status, summary: record.summary, ...(typeof record.closeout === 'string' ? { closeout: record.closeout } : {}) };
    }
    return null;
  };
  let repair: StoredRepairResult | undefined;
  const priorRepairRun = approvalRecord.repair_run_id && approvalRecord.repair_run_id !== runId
    ? approvalRecord.repair_run_id : undefined;
  const priorRepairResult = priorRepairRun
    ? parseStoredRepairResult(await readArtifact(join(patchpawPaths(root).runs, priorRepairRun), 'repair-result.json'))
    : null;

  if (previousApprovalPhase === 'repairing' && !priorRepairResult) {
    approvalRecord = await persistApproval( { phase: 'interrupted' }) ?? approvalRecord;
    await retainWorkspace(path, trace, { run_id: retained.run_id, execution_id: retained.execution_id, task: 'conflict', workspace,
      base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, remote_head: confirmedRemoteHead, pause_phase: 'repairing',
      pause_reason: 'human_decision', status: 'needs_human' });
    return completed(input, approvalRecord, confirmedRemoteHead, 'needs_human',
      { reason: '上一次 Conflict repair 在模型/验收结果落盘前中断；为避免重复调用模型，现有工作区与证据已保留，请人工检查后重新发送 /conflict。' });
  }
  if (priorRepairResult) {
    repair = priorRepairResult;
    trace.save('resumed-repair-result.json', repair);
    trace.emit('conflict_repair_result_reused', { approval_id: approvalRecord.approval_id, previous_run_id: priorRepairRun });
  } else if (['verification_passed', 'committing', 'committed', 'pushing', 'remote_confirmed', 'publication_pending'].includes(previousApprovalPhase)) {
    repair = parseStoredRepairResult(await readArtifact(join(patchpawPaths(root).runs, approvalRecord.repair_run_id ?? runId), 'repair-result.json')) ?? undefined;
  } else {
    approvalRecord = await persistApproval( {
      phase: 'repairing', repair_started_at: approvalRecord.repair_started_at ?? new Date().toISOString(), repair_run_id: runId,
    }) ?? approvalRecord;
    await phase('repairing');
    repair = await runRepair({ ...taskOptions, opaqueOutcome: true }, await seed());
    trace.save('repair-result.json', repair);
  }
  if (!repair || repair.status !== 'repaired') {
    approvalRecord = await persistApproval( { phase: 'interrupted' }) ?? approvalRecord;
    await retainWorkspace(path, trace, { run_id: retained.run_id, execution_id: executionId, task: 'conflict', workspace,
      base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, remote_head: confirmedRemoteHead, pause_phase: 'repairing',
      pause_reason: repair?.status === 'budget_exhausted' ? 'budget' : 'human_decision',
      status: repair?.status === 'budget_exhausted' ? 'budget_exhausted' : 'needs_human' });
    return completed(input, approvalRecord, confirmedRemoteHead, repair?.status ?? 'needs_human',
      { reason: repair?.summary ?? 'Approved Conflict repair did not produce an independently verified result.' });
  }

  const repairEvidenceInput = {
    repository: repo, prNumber, prHeadSha: approvalRecord.pr_head_sha, historicalBaseSha: retained.base_sha,
    currentBaseTipSha: currentBase.sha, baseRef: approvalRecord.base_ref, runId, executionId: approvalRecord.repair_execution_id,
    commandSnapshotId: approvalRecord.command_snapshot_id, commandSnapshotSha256: approvalRecord.command_snapshot_sha256,
  };
  const verificationPhases = ['verification_passed', 'committing', 'committed', 'pushing'];
  const repairEvidenceRun = approvalRecord.repair_run_id ?? runId;
  let verifiedEvidence: ConflictWorkspaceEvidence | null = null;
  if (priorRepairResult || verificationPhases.includes(previousApprovalPhase)) {
    const committedArtifact = ['committed', 'pushing'].includes(previousApprovalPhase)
      ? parseStoredConflictWorkspaceEvidence(await readArtifact(join(patchpawPaths(root).runs, repairEvidenceRun), COMMIT_EVIDENCE))
      : null;
    const artifact = committedArtifact ?? parseStoredConflictWorkspaceEvidence(await readArtifact(join(patchpawPaths(root).runs, repairEvidenceRun), VERIFICATION_EVIDENCE));
    if (!artifact?.evidence_sha256) {
      approvalRecord = await persistApproval( { phase: 'interrupted', rejection_code: 'workspace_missing' }) ?? approvalRecord;
      await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: 'conflict', workspace,
        base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, remote_head: confirmedRemoteHead, pause_phase: previousApprovalPhase,
        pause_reason: 'human_decision', status: 'needs_human' });
      return completed(input, approvalRecord, confirmedRemoteHead, 'needs_human',
        { reason: 'Approved Conflict 缺少可独立重建的 verification evidence；保留现有 workspace，不会重复调用模型或发布。' });
    }
    const { evidence_sha256: storedHash, ...evidence } = artifact;
    if (storedHash !== workspaceEvidenceSha256(evidence)) {
      approvalRecord = await persistApproval( { status: 'stale', phase: 'interrupted', rejection_code: 'workspace_changed' }) ?? approvalRecord;
      await markConflictProposalStatus(path, proposal.proposal_revision, 'stale', workspace.path);
      state.conflict_proposal = { ...proposalPointerForState(proposal, workspace.path), status: 'stale' };
      await savePaused(path, { ...(await readPaused(path) ?? retained), status: 'stale', reason: 'verification_evidence_hash_mismatch' });
      return completed(input, approvalRecord, confirmedRemoteHead, 'stale',
        { reason: 'Approved Conflict 的 verification evidence hash 不一致；不会把未知工作区提交或推送，请重新发送 /conflict。' });
    }
    verifiedEvidence = evidence;
  } else {
    verifiedEvidence = (await captureConflictWorkspaceEvidence(workspace.path, repairEvidenceInput, trace, VERIFICATION_EVIDENCE)).evidence;
  }
  approvalRecord = await persistApproval( {
    phase: 'verification_passed', verification_at: new Date().toISOString(),
  }) ?? approvalRecord;
  const startHead = approvalRecord.pr_head_sha;
  try {
    if (!isSameRepoWriteback(changeRequest, repo)) throw new Error('Refusing to push a fork change request through the base repository origin');
    const current = await scm.readChangeRequest(projectId, prNumber, { allowClosed: true });
    const factsMatch = ['open', 'opened'].includes(current.state)
      && current.source.ref === approvalRecord.pr_head_ref
      && current.source.pathWithNamespace.toLowerCase() === approvalRecord.pr_head_repo.toLowerCase()
      && current.target.ref === approvalRecord.base_ref && current.target.sha === currentBase.sha;
    if (!factsMatch) throw new Error('Change request head, base, or open state changed during run');
    const currentEvidence = (await captureConflictWorkspaceEvidence(workspace.path, repairEvidenceInput, trace, 'conflict-repair-current-evidence.json')).evidence;
    const sameVerifiedWorkspace = verifiedEvidence ? compareConflictWorkspaceEvidence(verifiedEvidence, currentEvidence).ok : false;
    const expectedCommit = approvalRecord.commit_sha;
    const committedCandidate = verifiedEvidence !== null && ['committing', 'committed', 'pushing'].includes(previousApprovalPhase)
      && committedRepairCandidate(verifiedEvidence, currentEvidence, expectedCommit);
    if (!sameVerifiedWorkspace && !committedCandidate) throw new Error('Conflict repair workspace changed after verification');
    if (approvalRecord.commit_sha && current.source.sha === approvalRecord.commit_sha) {
      state.current_head_sha = approvalRecord.commit_sha;
      state.last_patchpaw_commit = approvalRecord.commit_sha;
      confirmedRemoteHead = approvalRecord.commit_sha;
      setConfirmedRemoteHead(approvalRecord.commit_sha);
    } else if (current.source.sha === startHead) {
      const decision = decideWriteback({ permission: 'read_write', approvedWrite: true, sameRepo: true });
      if (decision.kind !== 'allowed') throw new Error('Conflict repair writeback capability was not issued');
      approvalRecord = await persistApproval({ phase: 'committing' }) ?? approvalRecord;
      const outcome = await performWriteback({ workspace, trace, scm, projectId, changeRequestNumber: prNumber,
        expectedBaseSha: currentBase.sha, sameRepo: true, permit: decision.permit, kind: 'conflict', previousHead: startHead,
        baseRef: approvalRecord.base_ref, headRef: approvalRecord.pr_head_ref, headRepo: approvalRecord.pr_head_repo,
        remoteUrl: changeRequest.repository.cloneUrl, credentialScopeUrl: scm.connection.instanceUrl,
        token, guard, beforePush: async sha => {
          state.current_head_sha = sha;
          state.last_patchpaw_commit = sha;
          await phase('publishing');
          approvalRecord = await persistApproval({ phase: 'committed', commit_sha: sha }) ?? approvalRecord;
          await captureConflictWorkspaceEvidence(workspace.path, { ...repairEvidenceInput, runId }, trace, COMMIT_EVIDENCE);
        } });
      state.current_head_sha = outcome.confirmedRemoteHead;
      state.last_patchpaw_commit = outcome.commitSha;
      confirmedRemoteHead = outcome.confirmedRemoteHead;
      setConfirmedRemoteHead(outcome.confirmedRemoteHead);
    } else {
      throw new Error('Change request head changed before conflict repair writeback');
    }
    workspace.mergePending = false;
    workspace.unmerged = [];
    const confirmedSha = state.current_head_sha;
    approvalRecord = await persistApproval( {
      phase: 'remote_confirmed', pushed_at: new Date().toISOString(), remote_head_sha: confirmedSha,
    }) ?? approvalRecord;
    trace.emit('conflict_repair_push_confirmed', { approval_id: approvalRecord.approval_id, proposal_hash: approvalRecord.proposal_hash, sha: confirmedSha });
  } catch (error) {
    const message = (error as Error).message;
    const stale = /Change request head, base, or open state changed|Change request head changed before conflict repair writeback|Timed out confirming pushed PR head|Conflict repair workspace changed after verification/.test(message);
    if (stale) {
      approvalRecord = await persistApproval( {
        status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed',
      }) ?? approvalRecord;
      await markConflictProposalStatus(path, proposal.proposal_revision, 'stale', workspace.path);
      await savePaused(path, { ...(await readPaused(path) ?? retained), status: 'stale', reason: 'publication_freshness_failed' });
      state.conflict_proposal = { ...proposalPointerForState(proposal, workspace.path), status: 'stale' };
      return completed(input, approvalRecord, confirmedRemoteHead, 'stale',
        { reason: '修复或发布前 Git freshness 检查失败（PR head/base/ref 或 PR 状态已变化）；没有继续发布，请重新发送 /conflict。' });
    }
    throw error;
  }
  const tick = String.fromCharCode(96);
  const repairBody = 'body' in repair ? repair.body : repair.summary;
  const answer = cleanString(trace, '## Conflict 修复完成\n\n' + repairBody + '\n\n提交：' + tick + state.current_head_sha + tick);
  trace.save('delivery.json', { status: 'repair_completed', head_sha: state.current_head_sha, body: answer,
    approval_id: approvalRecord.approval_id, proposal_hash: approvalRecord.proposal_hash });
  const stored = await enqueueCommentDelivery({ root, repo, prNumber, purpose: 'conflict_repair',
    semanticKey: approvalDeliverySemanticKey(approvalRecord), body: answer, mentions: recipients(), botLogin,
    source: { run_id: approvalRecord.repair_run_id ?? runId, approval_id: approvalRecord.approval_id, proposal_id: approvalRecord.proposal_id,
      proposal_revision: approvalRecord.proposal_revision, proposal_hash: approvalRecord.proposal_hash,
      commit_sha: state.current_head_sha, repair_execution_id: approvalRecord.repair_execution_id } });
  const deliveryRunId = typeof stored.item.source.run_id === 'string' ? stored.item.source.run_id : runId;
  approvalRecord = await persistApproval( { phase: 'publication_pending', claim_run_id: runId }) ?? approvalRecord;
  await savePaused(path, { ...(await readPaused(path) ?? retained), status: 'publication_pending', run_id: deliveryRunId, pause_phase: 'publication_pending' });
  const published = await deliverImmediately(root, stored, { adapter: scm, botLogin });
  trace.save('conflict-repair-publication.json', published.publication);
  if (published.item.status !== 'delivered' || !published.item.receipt) {
    return completed(input, approvalRecord, confirmedRemoteHead, 'publication_pending',
      { reason: 'Conflict 修复已独立验证并确认推送，但最终报告仍在 durable outbox 中；不会重复调用模型或重复推送。' });
  }
  const paused = await readPaused(path);
  if (paused?.workspace.path === workspace.path) await savePaused(path, { ...paused, status: 'completed' });
  try { await disposeWorkspacePath(root, repo, workspace.path, trace); }
  catch (error) {
    trace.emit('workspace_dispose_failed', { workspace: workspace.path, message: (error as Error).message });
    return completed(input, approvalRecord, confirmedRemoteHead, 'publication_pending',
      { reason: '最终报告已送达，但本地 workspace 清理尚未确认；durable outbox 将重试收敛，不会重复调用模型或推送。' });
  }
  const result = await finish('repair_completed', { answer, publication: published.publication });
  approvalRecord = await persistApproval( {
    phase: 'completed', final_publication_delivery_id: published.item.delivery_id,
    final_publication_remote_id: published.item.receipt.id, final_published_at: published.item.receipt.published_at ?? new Date().toISOString(),
  }) ?? approvalRecord;
  await finalizeDelivery(root, stored);
  return { result, approvalRecord, confirmedRemoteHead };
}
