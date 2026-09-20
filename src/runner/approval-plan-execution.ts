import { join } from 'node:path';
import type { HumanReply } from './human-reply.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import { assertApprovalProvenance, assertCurrentApprovalPlanFacts, CommandApprovalRejected } from './command-approval.ts';
import { approvalPlanDeliverySemanticKey, approvalPlanStatePointer, isApprovalPlanCompletionStatus, readCurrentApprovalPlan, updateApprovalPlan, type ApprovalPlanClaim, type ApprovalPlanFinishStatus, readUnfinishedApprovalPlanClaim } from './approval-plans.ts';
import { readArtifact } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { captureConflictWorkspaceEvidence, compareConflictWorkspaceEvidence, parseStoredConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { listOutbound } from './outbound.ts';
import type { CommandSnapshot } from '../control-plane/snapshots.ts';
import { writeState, type RunState } from './state.ts';
import { Trace } from '../harness/trace.ts';

export interface GenericApprovalBinding {
  plan_id: string;
  plan_revision: number;
  body_sha256: string;
  source_comment_id: number;
}

export function approvalPlanBinding(claim: ApprovalPlanClaim): GenericApprovalBinding {
  return { plan_id: claim.plan_id, plan_revision: claim.plan_revision, body_sha256: claim.body_sha256, source_comment_id: claim.source_comment_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameApprovalBinding(value: unknown, expected: GenericApprovalBinding) {
  return isRecord(value) && value.plan_id === expected.plan_id && value.plan_revision === expected.plan_revision
    && value.body_sha256 === expected.body_sha256 && value.source_comment_id === expected.source_comment_id;
}

export async function readGenericApprovalCompletion(root: string, claim: ApprovalPlanClaim): Promise<ApprovalPlanFinishStatus | null> {
  if (!claim.claim_run_id) return null;
  const expected = approvalPlanBinding(claim);
  const dir = join(patchpawPaths(root).runs, claim.claim_run_id);
  for (const artifact of ['result.json', 'delivery.json']) {
    const value: unknown = await readArtifact(dir, artifact);
    if (isRecord(value) && typeof value.status === 'string' && isApprovalPlanCompletionStatus(value.status)
        && sameApprovalBinding(value.approval_plan, expected)) return value.status;
  }
  return null;
}

type CurrentPlan = NonNullable<Awaited<ReturnType<typeof readCurrentApprovalPlan>>>;
type RecoveryClaim = Awaited<ReturnType<typeof readUnfinishedApprovalPlanClaim>>;
type Finish = (status: ApprovalPlanFinishStatus, extra?: { reason?: string; message?: string; [key: string]: unknown }, persistedPhase?: ApprovalPlanFinishStatus) => Promise<unknown>;

export interface ApprovalPlanExecutionInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  executionId: number;
  path: string;
  trace: Trace;
  state: RunState;
  source: ChangeRequestSnapshot;
  adapter: ScmAdapter;
  projectId: string;
  currentBase: { ref: string; sha: string };
  workspace: WorkspaceState;
  snapshot: CommandSnapshot;
  snapshotSha256: string;
  currentApprovalPlan: CurrentPlan;
  recovery: RecoveryClaim;
  claim: ApprovalPlanClaim | undefined;
  setClaim: (claim: ApprovalPlanClaim | undefined) => void;
  triggeringComment?: HumanReply;
  botLogin: string;
  priorLastPatchpawCommit: string | null;
  finish: Finish;
}

export async function claimApprovalPlan(input: ApprovalPlanExecutionInput): Promise<{ handled: true; result: unknown; claim?: ApprovalPlanClaim } | { handled: false; claim?: ApprovalPlanClaim }> {
  const { root, repo, prNumber, projectId, adapter, runId, executionId, path, trace, state, source, currentBase, workspace, snapshot, snapshotSha256,
    currentApprovalPlan, recovery, triggeringComment, botLogin, priorLastPatchpawCommit, finish } = input;
  let claim = input.claim;
  const recovering = !!recovery;
  try {
    if (!currentApprovalPlan.plan.publication?.delivery_id || !currentApprovalPlan.plan.publication.remote_id) {
      throw new CommandApprovalRejected('plan_not_published', '当前 Plan 尚未有已确认的 publication receipt。');
    }
    const published = (await listOutbound(root, { repo, prNumber }))
      .find(item => item.item.semantic_key === approvalPlanDeliverySemanticKey(currentApprovalPlan.plan));
    if (!published || published.item.status !== 'delivered' || published.item.receipt?.id !== currentApprovalPlan.plan.publication.remote_id) {
      throw new CommandApprovalRejected('publication_missing', '当前 Plan 的远端 publication receipt 未确认；不会进入写阶段。');
    }
    if (recovering) {
      const recovered = recovery?.approval;
      if (!recovered) throw new CommandApprovalRejected('approval_not_claimed', '恢复的 Approval claim 缺失；不会启动写阶段。');
      if (currentApprovalPlan.plan.status !== 'approved') throw new CommandApprovalRejected('approval_not_claimed', '恢复的 Plan 不再处于已领取的 approved write 状态。');
      if (recovered.plan_id !== currentApprovalPlan.plan.plan_id || recovered.plan_revision !== currentApprovalPlan.plan.plan_revision
          || recovered.body_sha256 !== currentApprovalPlan.plan.body_sha256) {
        throw new CommandApprovalRejected('approval_not_claimed', 'durable approval claim 与当前 Plan revision 不一致；不会套用到其他版本。');
      }
      claim = recovered;
      input.setClaim(claim);
      if (claim.phase === 'running') {
        const completion = await readGenericApprovalCompletion(root, claim);
        if (completion) {
          await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { approval: { ...claim, phase: 'completed', updated_at: new Date().toISOString() } });
          trace.emit('approval_plan_claim_reconciled', { plan_id: currentApprovalPlan.plan.plan_id, plan_revision: currentApprovalPlan.plan.plan_revision,
            reconciled_from_run_id: claim.claim_run_id, status: completion });
          return { handled: true, result: await finish(completion,
            { reason: 'approved write 已在之前的 run 中 durable 完成；本次只做机械收敛，没有再次调用模型或重复发布。', reconciled_from_run_id: claim.claim_run_id }, completion), claim };
        }
        if (source.source.sha !== currentApprovalPlan.plan.pr_head_sha || !!priorLastPatchpawCommit) {
          await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { approval: { ...claim, phase: 'interrupted', updated_at: new Date().toISOString() } });
          return { handled: true, result: await finish('needs_human',
            { reason: '上次 approved write 在提交/推送前后中断，且已检测到工作区或远端 head 变化；不会重复 Agent、commit 或 push，请人工检查当前 PR head。' }, 'awaiting_approval'), claim };
        }
      }
      assertCurrentApprovalPlanFacts({ plan: currentApprovalPlan.plan, changeRequest: source, repo, currentBase, workspace, status: 'approved' });
    } else {
      if (currentApprovalPlan.plan.status !== 'published') throw new CommandApprovalRejected('plan_not_published', '当前 Plan 不是等待审批的已发布状态。');
      assertApprovalProvenance({ reply: triggeringComment, botLogin, plan: currentApprovalPlan.plan });
      if (triggeringComment?.platform && triggeringComment.platform !== adapter.kind) {
        throw new CommandApprovalRejected('approval_event_invalid', 'Approval 的 SCM provenance 与当前 change request 不匹配。');
      }
      if (triggeringComment?.author_id && triggeringComment.repository_path && triggeringComment.project_id) {
        const sourceEventId = triggeringComment.source_event_id;
        if (!sourceEventId) throw new CommandApprovalRejected('approval_event_invalid', 'Approval 缺少 source event provenance。');
        const authorization = await adapter.verifyInboundComment({ platform: adapter.kind, connectionId: adapter.connection.id,
          projectId, storageKey: repo, repositoryPath: triggeringComment.repository_path,
          changeRequestNumber: prNumber, remoteId: triggeringComment.comment_id, authorId: triggeringComment.author_id,
          authorLogin: triggeringComment.author, body: triggeringComment.body, url: triggeringComment.url,
          createdAt: triggeringComment.created_at, sourceEventId });
        if (!authorization.canApprove) throw new CommandApprovalRejected('unauthorized_actor', 'Approval 评论者当前没有有效的 SCM 审批权限。');
      }
      assertCurrentApprovalPlanFacts({ plan: currentApprovalPlan.plan, changeRequest: source, repo, currentBase, workspace, status: 'published' });
    }
    if (snapshot.snapshot_id !== currentApprovalPlan.plan.command_snapshot_id
        || snapshotSha256 !== currentApprovalPlan.plan.command_snapshot_sha256) {
      throw new CommandApprovalRejected('snapshot_hash_mismatch', '恢复的 Command Snapshot 与 Plan 绑定的 id/hash 不一致；不会用其他配置替代已批准的快照。');
    }
    const original = parseStoredConflictWorkspaceEvidence(await readArtifact(join(patchpawPaths(root).runs, currentApprovalPlan.plan.run_id), 'workspace-evidence.json'));
    const current = (await captureConflictWorkspaceEvidence(workspace.path, {
      repository: repo, prNumber, prHeadSha: source.source.sha, historicalBaseSha: source.diffBaseSha ?? source.target.sha,
      currentBaseTipSha: currentBase.sha, baseRef: currentBase.ref, runId, executionId: snapshot.execution_id,
      commandSnapshotId: snapshot.snapshot_id, commandSnapshotSha256: snapshotSha256,
    }, trace, 'approval-plan-current-evidence.json')).evidence;
    if (!original?.evidence_sha256 || original.evidence_sha256 !== currentApprovalPlan.plan.workspace_evidence_sha256
        || !compareConflictWorkspaceEvidence(original, current).ok) {
      throw new CommandApprovalRejected('workspace_changed', 'retained workspace 与 Plan 发布时的机械证据不一致；不会进入写阶段。');
    }
    if (!claim) {
      const acceptedAt = new Date().toISOString();
      const reply = triggeringComment;
      if (!reply || !reply.source_event_id) throw new CommandApprovalRejected('approval_event_invalid', 'Approval comment provenance is missing.');
      claim = {
        plan_id: currentApprovalPlan.plan.plan_id, plan_revision: currentApprovalPlan.plan.plan_revision, body_sha256: currentApprovalPlan.plan.body_sha256,
        source_event_id: reply.source_event_id, source_comment_id: reply.comment_id,
        source_comment_url: reply.url, source_comment_created_at: reply.created_at,
        author: reply.author, author_association: reply.author_association,
        accepted_at: acceptedAt, claim_run_id: runId, phase: 'accepted', updated_at: acceptedAt,
      };
      await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { status: 'approved', approval: claim });
      state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), reply.comment_id])];
    } else {
      state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), claim.source_comment_id])];
    }
    claim = { ...claim, phase: 'running', claim_run_id: runId, updated_at: new Date().toISOString() };
    input.setClaim(claim);
    const approved = await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { approval: claim });
    state.approval_plan = approvalPlanStatePointer(approved.plan);
    await writeState(path, state);
    trace.emit('approval_plan_claim_claimed', { plan_id: currentApprovalPlan.plan.plan_id, plan_revision: currentApprovalPlan.plan.plan_revision,
      source_comment_id: claim.source_comment_id, recovered: recovering });
    return { handled: false, claim };
  } catch (error) {
    const rejection = error instanceof CommandApprovalRejected ? error : new CommandApprovalRejected('approval_invalid', error instanceof Error ? error.message : String(error));
    const retired = ['git_facts_changed', 'workspace_changed', 'fork_writeback_unsupported', 'pr_closed'].includes(rejection.code);
    await updateApprovalPlan(path, currentApprovalPlan.plan.plan_revision, { status: retired ? 'stale' : 'published' });
    return { handled: true, result: await finish(retired ? 'stale' : 'needs_human',
      { reason: rejection.message, approval_rejection_code: rejection.code }, 'awaiting_approval'), claim };
  }
}
