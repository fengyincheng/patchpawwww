import type { PermissionPhase, TaskOptions } from '../harness/runtime.ts';
import type { Trace } from '../harness/trace.ts';
import type { ScmAdapter } from '../scm/types.ts';
import type { TaskDriver, TaskProgress, TaskTerminalStatus } from './tasks/driver.ts';

type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<unknown>;
type Deliver = (status: TaskTerminalStatus, body: string) => Promise<unknown>;

export interface TaskDriverExecutionInput {
  driver: TaskDriver;
  phase: PermissionPhase;
  writable: boolean;
  repo: string;
  scm: ScmAdapter;
  projectId: string;
  changeRequestNumber: number;
  trace: Trace;
  signal: AbortSignal;
  options: TaskOptions;
  repairAttempts: () => number;
  repairBudget: number;
  resumed: { pausePhase?: string } | null;
  progress: TaskProgress;
  guardCycle: (phaseLabel: string) => Promise<void>;
  beginTask: (name: string) => Promise<void>;
  seed: () => Promise<Record<string, unknown>>;
  finish: Finish;
  deliver: Deliver;
  hasWorkspaceChanges: () => Promise<boolean>;
  publish: (kind: string) => Promise<void>;
  headSha: () => string;
  saveRepairAttempts: () => Promise<void>;
  publishApprovalPlan: (body: string) => Promise<unknown>;
}

export async function runTaskDriver(input: TaskDriverExecutionInput): Promise<{ handled: true; result: unknown } | { handled: false }> {
  for (;;) {
    const decision = await input.driver.decide({
      phase: input.phase,
      writable: input.writable,
      headSha: input.headSha(),
      repo: input.repo,
      scm: input.scm,
      projectId: input.projectId,
      changeRequestNumber: input.changeRequestNumber,
      trace: input.trace,
      signal: input.signal,
      options: input.options,
      repairAttempts: input.repairAttempts(),
      repairBudget: input.repairBudget,
      resumed: input.resumed,
      progress: input.progress,
      guardCycle: input.guardCycle,
    });
    if (decision.kind === 'complete') return { handled: true, result: await input.deliver(decision.status, decision.body) };
    if (decision.kind === 'blocked') {
      return { handled: true, result: await input.finish('needs_human', { reason: decision.reason, ...(decision.failureCode ? { failure_code: decision.failureCode } : {}) }) };
    }
    if (decision.mode === 'repair' && decision.countsAsRepairAttempt) {
      await input.saveRepairAttempts();
    }
    await input.beginTask(decision.agent.name);
    const turn = await decision.agent.run(
      decision.evidence === undefined ? input.options : { ...input.options, evidence: decision.evidence },
      { ...await input.seed(), ...decision.seed },
    );
    if (turn.outcome === 'unfinished') {
      return { handled: true, result: await input.finish(turn.status, { reason: turn.reason }) };
    }
    if (decision.artifact) input.trace.save(decision.artifact, turn.trace ?? turn);
    if (decision.mode === 'plan') return { handled: true, result: await input.publishApprovalPlan(turn.body) };
    if (decision.mode === 'diagnose') {
      return { handled: true, result: await input.deliver(decision.status, decision.heading + '\n\n' + turn.body + '\n\n' + decision.trailer) };
    }
    const changed = await input.hasWorkspaceChanges();
    const writtenBack = changed && input.writable;
    if (writtenBack) await input.publish(decision.writebackKind);
    input.progress.turns.push({ body: turn.body, writtenBack, sha: input.headSha() });
  }
}
