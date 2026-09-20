import { readCurrentApprovalPlan, updateApprovalPlan, type ApprovalPlanClaim } from './approval-plans.ts';
import { Trace } from '../harness/trace.ts';

export async function settleApprovalPlanClaim(input: {
  path: string;
  trace: Trace;
  claim?: ApprovalPlanClaim;
  phase: 'completed' | 'interrupted';
}): Promise<void> {
  if (!input.claim) return;
  try {
    const latest = await readCurrentApprovalPlan(input.path);
    if (!latest?.approval || latest.approval.phase !== 'running') return;
    await updateApprovalPlan(input.path, latest.plan.plan_revision, { approval: { ...latest.approval, phase: input.phase, updated_at: new Date().toISOString() } });
    input.trace.emit('approval_plan_claim_settled', { plan_id: latest.plan.plan_id, plan_revision: latest.plan.plan_revision, phase: input.phase });
  } catch (error) {
    // Settlement runs during recovery cleanup. Keep a failed sidecar update
    // observable without masking the original run outcome; the durable claim
    // remains discoverable for the next recovery pass.
    input.trace.emit('approval_plan_claim_settle_failed', { phase: input.phase, message: error instanceof Error ? error.message : String(error) });
  }
}
