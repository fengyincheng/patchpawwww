import type { ChangeRequestSnapshot } from '../scm/types.ts';
import type { HumanReply } from './human-reply.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import type { ApprovalPlan, ApprovalPlanStatus } from './approval-plans.ts';

export class CommandApprovalRejected extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CommandApprovalRejected'; }
}

export function rejectCommandApproval(code: string, message: string): never {
  throw new CommandApprovalRejected(code, message);
}

/**
 * Fork writeback is not supported: the workspace `origin` is the base repository, so pushing a
 * same-named branch would write into the wrong repository. This is a capability check on the real
 * GitHub head repository, never on the execution type.
 */
export function isSameRepoWriteback(changeRequest: ChangeRequestSnapshot, repo: string) {
  void repo;
  return changeRequest.source.projectId === changeRequest.target.projectId
    && changeRequest.source.projectId === changeRequest.repository.remoteProjectId;
}

/**
 * Event provenance, not actor RBAC. A generic `/approval` is only honoured when it entered through
 * a verified, durable GitHub webhook event (a delivery id and a real comment id). The author
 * association is recorded as an event fact but never used to grant or deny approval.
 */
export function assertApprovalProvenance(input: {
  reply?: Pick<HumanReply, 'comment_id' | 'source_event_id' | 'created_at' | 'author'>;
  botLogin: string;
  plan: ApprovalPlan;
}) {
  const { reply, botLogin, plan } = input;
  if (!reply || !reply.source_event_id || !Number.isSafeInteger(reply.comment_id) || reply.comment_id < 1) {
    rejectCommandApproval('approval_event_invalid', 'Approval 必须来自已验证并 durable 化的 SCM webhook 评论（缺少 source event 或有效 comment id）；不会把本地缺失 provenance 的评论当作授权。');
  }
  // Bot exclusion is mechanical, never role qualification: any human author association approves.
  if (reply.author.toLowerCase() === botLogin.toLowerCase() || reply.author.toLowerCase().endsWith('[bot]')) {
    rejectCommandApproval('unauthorized_actor', 'Bot 不能审批自己的 Plan；这不是角色资格检查。');
  }
  const publication = plan.publication;
  if (publication?.remote_id !== undefined && reply.comment_id <= publication.remote_id) {
    rejectCommandApproval('plan_not_current', '该 /approval 早于当前 Plan 的发布；旧审批不能批准新 Plan，请对当前 Plan 重新发送 /approval。');
  }
  if (reply.created_at !== undefined) {
    const createdAt = Date.parse(reply.created_at);
    if (!Number.isFinite(createdAt)) rejectCommandApproval('approval_event_invalid', 'Approval 评论的 created_at 不是有效 RFC 3339 时间；不会猜测它对应的 Plan 版本。');
    const publishedAt = publication?.published_at ? Date.parse(publication.published_at) : NaN;
    if (Number.isFinite(publishedAt) && createdAt <= publishedAt) {
      rejectCommandApproval('plan_not_current', '该 /approval 早于当前 Plan 的发布；旧审批不能批准新 Plan，请对当前 Plan 重新发送 /approval。');
    }
  }
}

/** Mechanical identity checks only; Agent plan prose is never inspected. */
export function assertCurrentApprovalPlanFacts(input: {
  plan: ApprovalPlan;
  changeRequest: ChangeRequestSnapshot;
  repo: string;
  currentBase: { ref: string; sha: string };
  workspace: WorkspaceState;
  status?: ApprovalPlanStatus;
}) {
  const { plan, changeRequest, repo, currentBase, workspace } = input;
  const expectedStatus = input.status ?? 'published';
  if (plan.status !== expectedStatus) rejectCommandApproval(expectedStatus === 'approved' ? 'approval_not_claimed' : 'plan_not_published',
    expectedStatus === 'approved' ? '当前 Plan 没有处于已领取的 approved write 状态。' : 'The current Approval Plan has not been published yet.');
  // A write can only ever be approved against a same-repository PR. This runs before the approved
  // Agent turn, so a fork PR never gains write capability even for a no-op write.
  if (!isSameRepoWriteback(changeRequest, repo) || plan.pr_head_repo.toLowerCase() !== changeRequest.source.pathWithNamespace.toLowerCase()) {
    rejectCommandApproval('fork_writeback_unsupported', '该 PR 来自 fork，PatchPaw 不支持向来源 fork 写回；不会进入写阶段。');
  }
  if (!['open', 'opened'].includes(changeRequest.state)) rejectCommandApproval('pr_closed', 'Change request 已关闭；不会为已关闭的对象启动 approved write。');
  if (plan.pr_head_sha !== changeRequest.source.sha || plan.pr_head_ref !== changeRequest.source.ref
      || plan.pr_head_repo.toLowerCase() !== changeRequest.source.pathWithNamespace.toLowerCase()
      || plan.current_base_tip_sha !== currentBase.sha || plan.base_ref !== currentBase.ref
      || changeRequest.target.sha !== currentBase.sha || changeRequest.target.ref !== currentBase.ref) {
    rejectCommandApproval('git_facts_changed', 'Change request head, source ref/repository, target ref, or current target tip changed after the Plan was published.');
  }
  if (plan.workspace_path !== workspace.path || workspace.initialHead !== plan.pr_head_sha || workspace.mainSha !== plan.current_base_tip_sha) {
    rejectCommandApproval('workspace_changed', 'The retained workspace no longer matches the published Approval Plan.');
  }
  if (!plan.command_snapshot_id || !plan.command_snapshot_sha256) rejectCommandApproval('snapshot_missing', 'The published Approval Plan is missing its Command Snapshot identity.');
}
