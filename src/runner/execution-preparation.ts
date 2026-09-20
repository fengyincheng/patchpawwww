import { join } from 'node:path';
import type { ControlPlaneDb } from '../control-plane/db.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import { resolveExecution, validateCommandSnapshot, writeCommandSnapshot } from '../control-plane/index.ts';
import type { CommandSnapshot, SnapshotReference } from '../control-plane/snapshots.ts';
import type { HumanReply } from './human-reply.ts';
import type { ParsedIntent, PRTask } from './command.ts';
import type { ConflictApprovalRecord } from './conflict-approval.ts';
import { prepareConflictApproval } from './legacy-conflict.ts';
import { loadOrReconstructLegacySnapshot } from './legacy-snapshot.ts';
import { markCurrentConflictProposalStale, proposalPointerForState } from './conflict-proposals.ts';
import { captureConflictWorkspaceEvidence, captureExecutionBaseline, compareConflictWorkspaceEvidence, workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { OPERATION_PROMPT_VERSION } from '../operation/load.ts';
import { prThreadId } from '../harness/pr-memory.ts';
import type { RuntimeExecution } from '../harness/runtime.ts';
import { prepareWorkspace, type WorkspaceState } from '../workspace/manager.ts';
import { createWorktree, disposeWorkspacePath, runWorkspacePath } from '../workspace/repo-store.ts';
import { Trace } from '../harness/trace.ts';
import { readArtifact } from './review-lifecycle.ts';
import { readPaused, resumeWorkspace, savePaused } from './resume.ts';
import { applyRunPhase } from './phases.ts';
import { writeState, type RunState } from './state.ts';
import { updateConflictApproval } from './conflict-approval.ts';
import { runtimeExecutionFromSnapshot } from '../harness/runtime.ts';
import { patchpawPaths } from '../config/paths.ts';
import { watchStop } from './stop.ts';

type CurrentApprovalPlan = Awaited<ReturnType<typeof import('./approval-plans.ts').readCurrentApprovalPlan>>;
type CurrentConflictProposal = Awaited<ReturnType<typeof import('./conflict-proposals.ts').readCurrentConflictProposal>>;
type ResumedWorkspace = NonNullable<Awaited<ReturnType<typeof resumeWorkspace>>>;
type PriorConflictEvidence = ConflictWorkspaceEvidence & { evidence_sha256?: string };
type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }, persistedPhase?: string) => Promise<unknown>;
type Repository = { id: string };

export interface ExecutionManifest {
  task_chain: string[];
  [key: string]: unknown;
}

export interface ExecutionPreparationInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  trace: Trace;
  state: RunState;
  changeRequest: ChangeRequestSnapshot;
  scm: ScmAdapter;
  projectId: string;
  snapshotPath?: string;
  path: string;
  task: PRTask;
  intent: ParsedIntent;
  repository: Repository;
  currentApprovalPlan: CurrentApprovalPlan;
  approvalRequested: boolean;
  approvedConflictRepair: boolean;
  approvalRecord?: ConflictApprovalRecord;
  approvalRecovery?: ConflictApprovalRecord;
  approvalSnapshot?: CommandSnapshot;
  triggeringComment?: HumanReply;
  feedback?: { previous_run_id?: string; new_comment_ids: number[] };
  controlPlane: ControlPlaneDb;
  currentBase: { ref: string; sha: string };
  retained: Awaited<ReturnType<typeof readPaused>>;
  currentConflictProposal: CurrentConflictProposal;
  discussingPause: boolean;
  discussingConflict: boolean;
  botLogin: string;
  stop: ReturnType<typeof watchStop>;
  workspaceNotice: string;
  executionId: number;
  phase: (raw: string) => Promise<void>;
  finish: Finish;
  setCreatedWorkspace: (path: string) => void;
  setActiveWorkspace: (workspace: WorkspaceState) => void;
  setExecutionId: (executionId: number) => void;
}

export type ExecutionPreparationResult =
  | { handled: true; result: unknown }
  | {
      handled: false;
      approvedConflictRepair: boolean;
      approvalRecord?: ConflictApprovalRecord;
      approvalSnapshot?: CommandSnapshot;
      genericApprovalWrite: boolean;
      resumed: ResumedWorkspace | null;
      ws: WorkspaceState;
      executionId: number;
      snapshot: CommandSnapshot;
      snapshotReference: SnapshotReference;
      runtimeExecution: RuntimeExecution;
      manifest: ExecutionManifest;
      conflictEvidence?: { evidence: ConflictWorkspaceEvidence; evidenceSha256: string };
      workspaceNotice: string;
    };

/** Legacy Conflict discussion reads immutable evidence from the runtime run store. */
export async function readPriorConflictEvidence(root: string, repairRunId: string): Promise<PriorConflictEvidence | null> {
  return readArtifact(join(patchpawPaths(root).runs, repairRunId), 'workspace-evidence.json');
}

export async function prepareExecution(input: ExecutionPreparationInput): Promise<ExecutionPreparationResult> {
  const { root, repo, prNumber, runId, trace, state, changeRequest, scm, projectId, snapshotPath, path, task, intent, repository, approvalRequested,
    approvalRecovery, triggeringComment, feedback, controlPlane, currentBase, retained, currentConflictProposal,
    discussingPause, discussingConflict, botLogin, stop, phase, finish } = input;
  let approvedConflictRepair = input.approvedConflictRepair;
  let approvalRecord = input.approvalRecord;
  let approvalSnapshot = input.approvalSnapshot;
  let currentApprovalPlan = input.currentApprovalPlan;
  let workspaceNotice = input.workspaceNotice;
  let conflictEvidence: { evidence: ConflictWorkspaceEvidence; evidenceSha256: string } | undefined;
  let conflictWorkspaceStaleReason: string | undefined;
  if (approvalRequested && !currentApprovalPlan) {
    const prepared = await prepareConflictApproval({ root, statePath: path, repo, prNumber, runId, botLogin,
      trace, state, changeRequest, scm, projectId, currentBase,
      retained, current: currentConflictProposal, reply: triggeringComment, recovery: approvalRecovery, controlPlane });
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
        try { await disposeWorkspacePath(root, repo, retained.workspace.path, trace); }
        catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained.workspace.path, reason: rejected.code, message: (error as Error).message }); }
        return { handled: true, result: await finish('stale', { reason: rejected.message }) };
      }
      return { handled: true, result: await finish('needs_human', { reason: rejected.message, approval_rejection_code: rejected.code }, 'awaiting_approval') };
    }
    approvedConflictRepair = true;
    approvalRecord = prepared.record;
    approvalSnapshot = prepared.snapshot;
    conflictEvidence = { evidence: prepared.evidence, evidenceSha256: workspaceEvidenceSha256(prepared.evidence) };
  }
  const genericApprovalWrite = approvalRequested && !!currentApprovalPlan;
  const resumableTask = !approvedConflictRepair && !genericApprovalWrite && ['conflict', 'ci', 'repair', 'review'].includes(task);
  const resumableStatuses = ['budget_exhausted', 'needs_human', 'stopped', 'awaiting_approval'];
  const candidateSnapshot = resumableTask && !discussingPause && retained && resumableStatuses.includes(retained.status)
    ? await loadOrReconstructLegacySnapshot(root, retained.run_id, repo, prNumber, retained).catch(error => ({ error }))
    : null;
  if (candidateSnapshot && 'error' in candidateSnapshot) {
    const error = candidateSnapshot.error;
    trace.emit('legacy_snapshot_required', { previous_run_id: retained?.run_id, code: error?.code ?? 'snapshot_unavailable' });
    return { handled: true, result: await finish('needs_human', { reason: '该暂停任务没有可验证的 Command Snapshot，不能安全套用当前最新配置继续。请发起新的明确任务；旧工作区与证据已保留。' }) };
  }
  const resumed = resumableTask ? await resumeWorkspace(path, { head: changeRequest.source.sha, base: changeRequest.diffBaseSha ?? changeRequest.target.sha,
    main: currentBase.sha, baseRef: changeRequest.target.ref, ownerRunId: runId, task: task as 'conflict' | 'ci' | 'repair' | 'review' }, trace,
    workspace => disposeWorkspacePath(root, repo, workspace, trace)) : null;
  if (!resumed && !discussingPause && retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status)) {
    const rejected = await readPaused(path);
    if (rejected?.status === 'stale') workspaceNotice = `原暂停工作区无法继续（${rejected.reason}）；旧证据已保留，本次按最新 Git 状态重新准备工作区，对话线程保持不变。\n\n`;
  }
  const freshWorkspace = async () => {
    const wsPath = runWorkspacePath(root, runId);
    input.setCreatedWorkspace(wsPath);
    await createWorktree(root, repo, wsPath, changeRequest.source.sha, trace);
    return prepareWorkspace({ path: wsPath, headSha: changeRequest.source.sha, baseRef: changeRequest.target.ref, mergeBase: task === 'conflict' }, trace);
  };
  if ((approvedConflictRepair || genericApprovalWrite || discussingPause) && !retained) {
    throw new Error('A retained workspace is required for this execution path');
  }
  if (genericApprovalWrite && !currentApprovalPlan) {
    throw new Error('An Approval Plan is required for approved write execution');
  }
  const retainedWorkspace = approvedConflictRepair || genericApprovalWrite || discussingPause ? retained?.workspace : undefined;
  const ws = retainedWorkspace ?? resumed?.workspace ?? await freshWorkspace();
  input.setActiveWorkspace(ws);
  await stop.guard();
  const executionId = approvedConflictRepair ? retained?.execution_id ?? input.executionId
    : genericApprovalWrite ? currentApprovalPlan?.plan.execution_id ?? input.executionId
      : resumed?.execution_id ?? input.executionId;
  input.setExecutionId(executionId);
  trace.executionId = executionId;
  state.execution_id = executionId;
  const boundApprovalSnapshot = currentApprovalPlan && approvalRequested
    ? validateCommandSnapshot(await readArtifact(join(patchpawPaths(root).runs, currentApprovalPlan.plan.run_id), 'command-snapshot.json'), { allowLegacy: true })
    : undefined;
  const snapshot = approvedConflictRepair
    ? approvalSnapshot ?? (() => { throw new Error('Approved Conflict repair is missing its Command Snapshot.'); })()
    : boundApprovalSnapshot
    ? boundApprovalSnapshot
    : resumed
    ? candidateSnapshot?.snapshot ?? (() => { throw new Error('Resumed execution is missing its Command Snapshot.'); })()
    : (await resolveExecution(controlPlane, task === 'conversation' || task === 'stop' ? { kind: 'conversation', repositoryId: repository.id, executionId: `${runId}:${executionId}` } : (() => {
      if (intent.kind !== 'command') throw new Error('Command execution is missing its command intent');
      return { kind: 'command', repositoryId: repository.id, commandId: intent.commandId, executionId: `${runId}:${executionId}` };
    })())).snapshot;
  if (snapshot.template_type !== (task === 'stop' ? 'conversation' : task)) throw new Error('Resolved command snapshot template does not match the selected task.');
  const runtimeExecution = runtimeExecutionFromSnapshot(snapshot, root);
  const snapshotReference = await writeCommandSnapshot(root, runId, snapshot, { allowLegacy: snapshot.schema_version.endsWith('legacy-v1') });
  const manifest: ExecutionManifest = { run_id: runId, repo, pr_number: prNumber, initial_head_sha: changeRequest.source.sha,
    base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, current_main_sha: null, current_base_ref: changeRequest.target.ref, current_base_tip_sha: null,
    workspace_base_tip_sha: null, pr_diff_basis: null, pr_thread_id: prThreadId(repo, prNumber), execution_id: executionId,
    workspace_path: runWorkspacePath(root, runId), previous_execution_run_id: null,
    command: intent.kind === 'command' ? intent.slashName : task, command_id: snapshot.command?.id ?? null,
    command_revision: snapshot.command?.revision ?? snapshot.conversation_profile?.revision ?? null,
    provider_id: snapshot.provider.id, model_id: snapshot.provider.model.id, model: snapshot.provider.model.identifier,
    provider: snapshot.provider.base_url, reasoning_effort: snapshot.provider.request_options.reasoning_effort ?? null,
    task_chain: [], prompt_version: OPERATION_PROMPT_VERSION, toolset_version: snapshot.toolset_version,
    started_at: new Date(trace.started).toISOString(), entry: feedback ? 'scm_comment' : 'scm_api', scm_snapshot_path: snapshotPath ?? null,
    snapshot_path: snapshotReference.snapshot_path, snapshot_id: snapshotReference.snapshot_id, snapshot_sha256: snapshotReference.snapshot_sha256,
    snapshot_schema_version: snapshotReference.snapshot_schema_version, snapshot_execution_id: snapshot.execution_id,
    reply_to_run_id: feedback?.previous_run_id, human_comment_ids: feedback?.new_comment_ids, request_author: triggeringComment?.author };
  manifest.execution_id = executionId; manifest.workspace_path = ws.path; manifest.previous_execution_run_id = resumed?.run_id ?? null;
  if (resumed) {
    const previous = join(patchpawPaths(root).runs, resumed.run_id);
    const lastValidation = await readArtifact(previous, 'last-validation.json');
    if (lastValidation) trace.save('last-validation.json', lastValidation);
    const closeout = await readArtifact(previous, 'closeout.json');
    const stopReport = await readArtifact(previous, 'stop-report.json');
    if (stopReport) trace.save('resume-stop-report.json', stopReport);
    if (closeout) trace.save('resume-closeout.json', closeout);
    new Trace(previous).emit('execution_resumed', { next_run_id: runId, execution_id: executionId });
  }
  trace.emit(resumed ? 'execution_resumed' : 'execution_started', { execution_id: executionId, previous_run_id: resumed?.run_id, workspace: ws.path });
  manifest.current_main_sha = ws.mainSha; manifest.current_base_tip_sha = currentBase.sha; manifest.workspace_base_tip_sha = ws.mainSha;
  manifest.pr_diff_basis = `merge-base(${currentBase.sha}, ${changeRequest.source.sha}) -> ${changeRequest.source.sha}`;
  trace.save('manifest.json', manifest);
  if (!genericApprovalWrite && ((task === 'conflict' && !approvedConflictRepair) || snapshot.command?.permission === 'read_write_approval')) {
    conflictEvidence = await captureExecutionBaseline(ws.path, trace, { repository: repo, prNumber, prHeadSha: changeRequest.source.sha,
      historicalBaseSha: changeRequest.diffBaseSha ?? changeRequest.target.sha, currentBaseTipSha: currentBase.sha, baseRef: changeRequest.target.ref, runId, executionId: snapshot.execution_id,
      commandSnapshotId: snapshot.snapshot_id, commandSnapshotSha256: snapshotReference.snapshot_sha256 });
  } else if (discussingConflict && currentConflictProposal) {
    conflictEvidence = await captureConflictWorkspaceEvidence(ws.path, { repository: repo, prNumber, prHeadSha: changeRequest.source.sha,
      historicalBaseSha: changeRequest.diffBaseSha ?? changeRequest.target.sha, currentBaseTipSha: currentBase.sha, baseRef: changeRequest.target.ref, runId, executionId: snapshot.execution_id,
      commandSnapshotId: currentConflictProposal.proposal.basis.command_snapshot_id, commandSnapshotSha256: currentConflictProposal.proposal.basis.command_snapshot_sha256 }, trace);
    const priorEvidence = await readPriorConflictEvidence(root, currentConflictProposal.proposal.repair_run_id);
    if (!priorEvidence) conflictWorkspaceStaleReason = 'workspace_evidence_missing';
    else {
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
    if (!retained) throw new Error('Conflict discussion is missing its retained workspace');
    await markCurrentConflictProposalStale(path, retained.workspace.path, conflictWorkspaceStaleReason);
    await savePaused(path, { ...retained, status: 'stale', reason: conflictWorkspaceStaleReason });
    state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained.workspace.path), status: 'stale' };
    await writeState(path, applyRunPhase({ ...state, active: false }, 'stale'));
    return { handled: true, result: await finish('stale', { reason: `保留的 Conflict workspace 证据已变化（${conflictWorkspaceStaleReason}）；不会基于外部修改继续讨论或发布修订。请重新发送 /conflict。` }) };
  }
  return { handled: false, approvedConflictRepair, approvalRecord, approvalSnapshot, genericApprovalWrite, resumed, ws, executionId, snapshot,
    snapshotReference, runtimeExecution, manifest, conflictEvidence, workspaceNotice };
}
