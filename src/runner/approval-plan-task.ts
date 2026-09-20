import type { TaskOptions } from '../harness/runtime.ts';
import { runConflict } from '../tasks/conflict/agent.ts';
import { runCIRepair } from '../tasks/ci-repair/agent.ts';
import { runCustom } from '../tasks/custom/agent.ts';
import { runRepair } from '../tasks/repair.ts';
import { runReview } from '../tasks/review/agent.ts';
import type { PRTask } from './command.ts';
import type { ApprovalPlan, ApprovalPlanFinishStatus } from './approval-plans.ts';

type Finish<TResult> = (status: ApprovalPlanFinishStatus, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<TResult>;

export interface ApprovalPlanTaskInput<TResult = unknown> {
  task: PRTask;
  taskOptions: TaskOptions;
  seed: () => Promise<unknown>;
  beginTask: (task: PRTask) => Promise<void>;
  publishApprovalPlan: (body: string) => Promise<TResult>;
  finish: Finish<TResult>;
}

export function isApprovalPlanTask(task: PRTask): task is ApprovalPlan['execution_type'] {
  return task === 'custom' || task === 'review' || task === 'repair' || task === 'ci' || task === 'conflict';
}

/** Review and Conflict planning semantics live here; the top-level runner only coordinates them. */
export async function runApprovalPlanTask<TResult = unknown>(input: ApprovalPlanTaskInput<TResult>): Promise<{ handled: true; result: TResult } | { handled: false }> {
  if (!isApprovalPlanTask(input.task)) return { handled: false };
  await input.beginTask(input.task);
  if (input.task === 'custom') {
    const custom = await runCustom({ ...input.taskOptions, opaqueOutcome: true as const }, await input.seed());
    if (custom.outcome === 'unfinished') return { handled: true, result: await input.finish(custom.status, { reason: custom.reason }) };
    return { handled: true, result: await input.publishApprovalPlan(custom.body) };
  }
  if (input.task === 'review') {
    const review = await runReview({ ...input.taskOptions, opaqueOutcome: true as const }, await input.seed());
    if (review.outcome === 'unfinished') return { handled: true, result: await input.finish(review.status, { reason: review.reason }) };
    return { handled: true, result: await input.publishApprovalPlan(review.body) };
  }
  if (input.task === 'repair') {
    const repair = await runRepair({ ...input.taskOptions, opaqueOutcome: true as const }, await input.seed());
    if (repair.status !== 'repaired') return { handled: true, result: await input.finish(repair.status, { reason: repair.summary }) };
    return { handled: true, result: await input.publishApprovalPlan(repair.body) };
  }
  if (input.task === 'ci') {
    const repair = await runCIRepair({ ...input.taskOptions, opaqueOutcome: true as const }, await input.seed());
    if (repair.status !== 'repaired') return { handled: true, result: await input.finish(repair.status, { reason: repair.summary }) };
    return { handled: true, result: await input.publishApprovalPlan(repair.body) };
  }
  const analysis = await runConflict({ ...input.taskOptions, opaqueOutcome: true as const }, await input.seed());
  if (analysis.status !== 'completed') {
    return { handled: true, result: await input.finish(analysis.status, { reason: analysis.summary }) };
  }
  return { handled: true, result: await input.publishApprovalPlan(analysis.body) };
}
