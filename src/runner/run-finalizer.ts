import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import { disposeWorkspacePath } from '../workspace/repo-store.ts';
import { publishRunNotice } from './publication.ts';
import type { GenericApprovalBinding } from './approval-plan-execution.ts';
import { readArtifact } from './review-lifecycle.ts';
import { readPaused, retainWorkspace } from './resume.ts';
import { stopEvidence } from './stop-evidence.ts';
import type { RunFailure } from './failures.ts';
import { type RunState } from './state.ts';
import { Trace } from '../harness/trace.ts';
import { watchStop } from './stop.ts';

type FinishExtra = { reason?: string; message?: string; [key: string]: unknown };
type Phase = (raw: string) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunFailure(value: unknown): value is RunFailure {
  if (!isRecord(value)) return false;
  const record = value;
  return typeof record.code === 'string' && typeof record.category === 'string'
    && typeof record.retryable === 'boolean' && typeof record.user_action === 'string'
    && typeof record.message === 'string';
}

export interface RunFinalizerInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  executionId: number;
  statePath: string;
  state: RunState;
  trace: Trace;
  scm: ScmAdapter;
  botLogin: string;
  activeTask: string;
  approvedConflictRepair: boolean;
  activeWorkspace?: WorkspaceState;
  createdWorkspace?: string;
  changeRequest?: ChangeRequestSnapshot;
  confirmedRemoteHead?: string;
  stop?: ReturnType<typeof watchStop>;
  workspaceNotice: string;
  recipients: () => string[];
  genericApprovalClaim?: GenericApprovalBinding;
  phase: Phase;
  settleGenericApprovalClaim: (phase: 'completed' | 'interrupted') => Promise<void>;
}

export async function finishRun(input: RunFinalizerInput, status: string, extra: FinishExtra = {}, persistedPhase = status): Promise<Record<string, unknown>> {
  const { state, trace, activeTask, activeWorkspace, changeRequest, confirmedRemoteHead, stop, genericApprovalClaim } = input;
  const stoppedPhase = state.phase;
  if (['ci', 'repair'].includes(activeTask) && activeWorkspace && changeRequest && ['needs_human', 'budget_exhausted'].includes(status)) {
    await retainWorkspace(input.statePath, trace, { run_id: input.runId, execution_id: input.executionId, task: activeTask as 'ci' | 'repair', workspace: activeWorkspace,
      base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, remote_head: confirmedRemoteHead, pause_phase: stoppedPhase,
      pause_reason: status === 'needs_human' ? 'human_decision' : 'budget' });
  }
  if (input.approvedConflictRepair && activeWorkspace && changeRequest
      && ['needs_human', 'budget_exhausted', 'stopped', 'harness_failed', 'provider_unavailable'].includes(status)) {
    const pauseStatus = status === 'stopped' ? 'stopped' : status === 'budget_exhausted' ? 'budget_exhausted' : 'needs_human';
    const retainedPause = await readPaused(input.statePath);
    await retainWorkspace(input.statePath, trace, { run_id: retainedPause?.run_id ?? input.runId, execution_id: retainedPause?.execution_id ?? input.executionId, task: 'conflict', workspace: activeWorkspace,
      base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, remote_head: confirmedRemoteHead, pause_phase: stoppedPhase,
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
  state.active = false; await input.phase(persistedPhase);
  const result: Record<string, unknown> = { status, run_id: input.runId, execution_id: input.executionId, repo: input.repo, pr_number: input.prNumber, final_head_sha: state.current_head_sha,
    ...(status === 'budget_exhausted' ? { closeout: 'closeout.json' } : {}),
    ...(genericApprovalClaim ? { approval_plan: genericApprovalClaim } : {}),
    duration_ms: Date.now() - trace.started, ...extra, ...(stopped ? { evidence } : {}) };
  trace.save('result.json', result);
  trace.emit((status === 'stopped' || status === 'budget_exhausted' || (status === 'needs_human' && stoppedPhase === 'conflict')) ? 'execution_paused' : 'execution_completed', { execution_id: input.executionId, status });
  if (stopped) {
    const failure = isRunFailure(extra.failure) ? extra.failure : undefined;
    const notice = JSON.parse(trace.clean({ run_id: input.runId, head: state.current_head_sha, status, phase: stoppedPhase,
      ...(failure ? { failure } : {}),
      reason: `${status === 'harness_failed' && !failure ? 'Harness 执行／验证过程出错，不等同于代码测试失败。\n' : ''}${status === 'model_output_truncated' && !failure ? '模型连接正常，但单次输出上限已耗尽，未生成完整评审结果；这不是 Provider 不可用，也没有生成可发布的代码验收记录。\n' : ''}${input.workspaceNotice}${extra.reason ?? extra.message ?? '本次任务尚未完成。'}\n${state.last_patchpaw_commit ? `本次记录的 PatchPaw 提交：\`${state.last_patchpaw_commit}\`。\n` : '本次没有记录 PatchPaw 提交或推送；失败不代表代码已交付。\n'}\n${evidence}`,
      mentions: input.recipients(), bot_login: input.botLogin }));
    trace.save('run-notice.json', notice);
    await publishRunNotice({ root: input.root, repo: input.repo, prNumber: input.prNumber, trace, notice,
      botLogin: input.botLogin || undefined, adapter: input.scm });
  }
  if (genericApprovalClaim) await input.settleGenericApprovalClaim(status.endsWith('_completed') ? 'completed' : 'interrupted');
  return result;
}

export interface DisposeWorkspaceInput {
  root: string;
  repo: string;
  path: string;
  trace: Trace;
  activeWorkspace?: WorkspaceState;
  createdWorkspace?: string;
}

export async function disposeTerminalWorkspace(input: DisposeWorkspaceInput): Promise<void> {
  try {
    const target = input.activeWorkspace?.path ?? input.createdWorkspace;
    if (!target) return;
    const result = await readArtifact(input.trace.dir, 'result.json');
    if (!result) return;
    const paused = await readPaused(input.path);
    if (input.activeWorkspace && paused && paused.workspace.path === input.activeWorkspace.path
      && ['budget_exhausted', 'needs_human', 'stopped', 'publication_pending', 'awaiting_approval'].includes(paused.status)) return;
    await disposeWorkspacePath(input.root, input.repo, target, input.trace);
    input.trace.emit('workspace_disposed', { workspace: target, status: result.status });
  } catch (error) {
    input.trace.emit('workspace_dispose_failed', { workspace: input.activeWorkspace?.path ?? input.createdWorkspace, message: (error as Error).message });
  }
}
