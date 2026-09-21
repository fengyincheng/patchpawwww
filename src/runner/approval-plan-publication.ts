import type { WorkspaceState } from '../workspace/manager.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import type { CommandSnapshot } from '../control-plane/snapshots.ts';
import { createApprovalPlan, approvalPlanDeliverySemanticKey, approvalPlanStatePointer, readCurrentApprovalPlan, saveApprovalPlan, updateApprovalPlan, type ApprovalPlan, type ApprovalPlanFinishStatus } from './approval-plans.ts';
import { enqueueCommentDelivery, deliverImmediately, finalizeDelivery } from './outbound.ts';
import { retainWorkspace } from './resume.ts';
import { Trace } from '../harness/trace.ts';
import type { ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import type { RunState } from './state.ts';

type Finish = (status: ApprovalPlanFinishStatus, extra?: { reason?: string; message?: string; [key: string]: unknown }, persistedPhase?: ApprovalPlanFinishStatus) => Promise<unknown>;
type CurrentPlan = Awaited<ReturnType<typeof import('./approval-plans.ts').readCurrentApprovalPlan>>;

export interface ApprovalPlanPublicationInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  executionId: number;
  path: string;
  task: ApprovalPlan['execution_type'];
  body: string;
  snapshot: CommandSnapshot;
  snapshotSha256: string;
  currentApprovalPlan: CurrentPlan;
  setCurrentApprovalPlan: (value: CurrentPlan) => void;
  conflictEvidence: { evidence: ConflictWorkspaceEvidence; evidenceSha256: string };
  currentBase: { ref: string; sha: string };
  source: ChangeRequestSnapshot;
  adapter: ScmAdapter;
  projectId: string;
  workspace: WorkspaceState;
  state: RunState;
  trace: Trace;
  mentions: string[];
  botLogin: string;
  finish: Finish;
}

export async function publishApprovalPlan(input: ApprovalPlanPublicationInput): Promise<unknown> {
  const { root, repo, prNumber, projectId, runId, executionId, path, task, body, snapshot, snapshotSha256, currentApprovalPlan,
    setCurrentApprovalPlan, conflictEvidence, currentBase, source, adapter, workspace, state, trace, mentions, botLogin, finish } = input;
  if (!snapshot.command || snapshot.command.permission !== 'read_write_approval' || !conflictEvidence) throw new Error('Approval Plan requires an approval command snapshot and workspace evidence.');
  const current = await adapter.readChangeRequest(projectId, prNumber, { allowClosed: true });
  const sameFacts = (value: ChangeRequestSnapshot) => value.state === 'open' || value.state === 'opened'
    ? value.source.sha === source.source.sha && value.source.ref === source.source.ref
      && value.source.pathWithNamespace.toLowerCase() === source.source.pathWithNamespace.toLowerCase()
      && value.target.ref === currentBase.ref && value.target.sha === currentBase.sha
    : false;
  if (!sameFacts(current)) throw new Error('Change request head, source, target, or open state changed before Approval Plan publication.');
  const plan = createApprovalPlan({
    plan_revision: (currentApprovalPlan?.plan.plan_revision ?? 0) + 1, body,
    command_id: snapshot.command.id, command_name: snapshot.command.slash_name, execution_type: task,
    permission: 'read_write_approval', run_id: runId, execution_id: executionId,
    pr_head_sha: source.source.sha, pr_head_ref: source.source.ref, pr_head_repo: source.source.pathWithNamespace,
    current_base_tip_sha: currentBase.sha, base_ref: currentBase.ref, workspace_path: workspace.path,
    workspace_evidence_sha256: conflictEvidence.evidenceSha256, command_snapshot_id: snapshot.snapshot_id,
    command_snapshot_sha256: snapshotSha256,
  });
  if (currentApprovalPlan) await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { status: 'superseded' });
  await saveApprovalPlan(path, plan);
  const saved = await readCurrentApprovalPlan(path);
  setCurrentApprovalPlan(saved);
  state.approval_plan = approvalPlanStatePointer(plan);
  trace.save('approval-plan.json', plan);
  const tick = String.fromCharCode(96);
  const publicationBody = body + '\n\n---\n此计划为只读阶段产物。确认当前计划后，请在此 PR 单独发送：' + tick + '/approval' + tick;
  const stored = await enqueueCommentDelivery({ root, repo, prNumber, purpose: 'approval_plan',
    semanticKey: approvalPlanDeliverySemanticKey(plan), body: publicationBody, mentions, botLogin,
    source: { project_id: projectId, run_id: runId, execution_id: executionId, plan_id: plan.plan_id, plan_revision: plan.plan_revision,
      body_sha256: plan.body_sha256, command_snapshot_id: plan.command_snapshot_id, command_snapshot_sha256: plan.command_snapshot_sha256 } });
  await updateApprovalPlan(path, plan.plan_revision, { status: 'publication_pending' });
  await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task, workspace,
    base_sha: source.diffBaseSha ?? source.target.sha, base_ref: currentBase.ref, remote_head: source.source.sha, pause_phase: 'awaiting_approval',
    pause_reason: 'human_decision', status: 'publication_pending' });
  const result = await deliverImmediately(root, stored, { adapter, botLogin });
  if (result.item.status !== 'delivered' || !result.item.receipt) {
    await updateApprovalPlan(path, plan.plan_revision, { status: 'publication_pending' });
    const pending: ApprovalPlan = { ...plan, status: 'publication_pending' };
    setCurrentApprovalPlan(await readCurrentApprovalPlan(path));
    state.approval_plan = approvalPlanStatePointer(pending);
    return finish('publication_pending', { reason: 'Approval Plan 已保存并进入 durable outbox，但远程发布尚未确认；不会重新运行 Agent。', plan_id: plan.plan_id, body_sha256: plan.body_sha256 });
  }
  const published = await updateApprovalPlan(path, plan.plan_revision, { status: 'published', publication: {
    delivery_id: result.item.delivery_id, remote_id: result.item.receipt.id, remote_url: result.item.receipt.html_url,
    published_at: result.item.receipt.published_at,
  } });
  setCurrentApprovalPlan(published);
  state.approval_plan = approvalPlanStatePointer(published.plan);
  await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task, workspace,
    base_sha: source.diffBaseSha ?? source.target.sha, base_ref: currentBase.ref, remote_head: source.source.sha, pause_phase: 'awaiting_approval',
    pause_reason: 'human_decision', status: 'awaiting_approval' });
  await finalizeDelivery(root, stored);
  trace.save('approval-plan-publication.json', published.plan.publication);
  return finish('awaiting_approval', { plan_id: plan.plan_id, plan_revision: plan.plan_revision, body_sha256: plan.body_sha256, publication: published.plan.publication, body });
}
