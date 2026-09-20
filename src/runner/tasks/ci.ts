import { setTimeout as delay } from 'node:timers/promises';
import { budget } from '../../harness/budget.ts';
import type { ScmCiState } from '../../scm/types.ts';
import { excerpt } from '../../harness/context/policy.ts';
import { runCIRepair } from '../../tasks/ci-repair/agent.ts';
import { taskAgentResultFromRepair } from '../../tasks/repair.ts';
import type { TaskAgent, TaskDecision, TaskDecisionContext, TaskDriver } from './driver.ts';

export type CiFailureEvidence = unknown;

/**
 * The CI state a `/CI` execution reads before it can decide anything, with failure evidence for a
 * failed run. A CI run that has not inspected the current head's CI state has no task semantics
 * yet, which is why every turn this driver asks for comes from here.
 *
 * `red-evidence-unavailable` is deliberately not collapsed into `red`: "CI failed and we have the
 * evidence" and "CI failed and we could not read the evidence" are different durable facts, and
 * only the first one justifies an Agent turn.
 */
export type PreparedCi =
  | { state: 'pending'; ci: ScmCiState }
  | { state: 'green'; ci: ScmCiState }
  | { state: 'red'; ci: ScmCiState; evidence: CiFailureEvidence }
  | { state: 'red-evidence-unavailable'; ci: ScmCiState; error: string }
  | { state: 'unknown'; ci: ScmCiState; error: string };

async function waitForCI(input: Pick<TaskDecisionContext, 'scm' | 'projectId' | 'changeRequestNumber' | 'headSha' | 'trace' | 'signal'>) {
  const started = Date.now();
  let last: ScmCiState | undefined;
  let terminalSignature = '';
  do {
    input.signal?.throwIfAborted();
    last = await input.scm.readCI(input.projectId, input.changeRequestNumber, input.headSha);
    input.trace.emit('ci_poll', last);
    const signature = JSON.stringify(last);
    if (last.state !== 'pending' && last.state !== 'unknown' && signature === terminalSignature) return last;
    terminalSignature = last.state === 'pending' || last.state === 'unknown' ? '' : signature;
    if (Date.now() - started >= budget.ciWaitMs) return last;
    await delay(budget.ciPollMs, undefined, { signal: input.signal });
  } while (Date.now() - started < budget.ciWaitMs);
  if (!last) throw new Error('SCM CI did not return a state');
  return last;
}

/**
 * Read the real CI state for the current head, and for a failed run collect the actual failure
 * evidence. Evidence-fetch failure fails closed: the run keeps its red CI state and the fetch
 * error instead of degrading into repository-file guesswork.
 */
export async function prepareCiTask(input: Pick<TaskDecisionContext, 'scm' | 'projectId' | 'changeRequestNumber' | 'headSha' | 'trace' | 'signal'>): Promise<PreparedCi> {
  const ci = await waitForCI(input);
  if (ci.state === 'pending') return { state: 'pending', ci };
  if (ci.state === 'green') return { state: 'green', ci };
  if (ci.state === 'unknown') return { state: 'unknown', ci, error: 'SCM did not expose a terminal CI result' };
  try { return { state: 'red', ci, evidence: await input.scm.failureEvidence(input.projectId, ci) }; }
  catch (error) { return { state: 'red-evidence-unavailable', ci, error: error instanceof Error ? error.message : String(error) }; }
}

const PENDING_REASON = '等待 CI 的时间预算已用完，当前提交尚无完整终态，请检查是否需要批准工作流或补充外部条件。';
const RESUME_INSTRUCTION = 'Continue the retained CI candidate after the human pause. Recheck the current code and finish with a natural-language summary.';

/** The mechanical CI summary every CI outcome ends with; never an interpretation of the Agent. */
function ciSummary(ci: ScmCiState) {
  return ci.items.map(item => `- ${item.name}: ${item.conclusion} ${item.url ?? ''}`).join('\n');
}

function failedItems(ci: ScmCiState) {
  return ci.items.filter(item => !['success', 'neutral', 'skipped'].includes(item.conclusion ?? '')
    && ['completed', 'failed', 'failure'].includes(item.status.toLowerCase()))
    .map(item => `- ${item.name}: ${item.conclusion} ${item.url ?? ''}`).join('\n');
}

/** The turns that actually produced a confirmed commit; a no-op turn is not a repair. */
function repairs(context: TaskDecisionContext) {
  return context.progress.turns.filter(turn => turn.writtenBack);
}

function completedBody(ci: ScmCiState, context: TaskDecisionContext) {
  const written = repairs(context);
  const detail = written.length
    ? written.map((repair, index) => `### 修复 ${index + 1}\n${repair.body}\n提交：\`${repair.sha}\``).join('\n\n')
    : '当前 CI 已通过，没有修改或提交代码。';
  return `## CI 检查完成\n\n${detail}\n\n最终 head：\`${context.headSha}\`\nGitHub CI：\n${ciSummary(ci)}`;
}

function exhaustedReason(ci: ScmCiState, context: TaskDecisionContext) {
  return `已完成 ${context.repairBudget} 轮 CI 修复提交，仍未通过，需要人工介入。\n`
    + repairs(context).map(repair => `${repair.body}\n提交：${repair.sha}`).join('\n\n')
    + `\n当前失败：\n${failedItems(ci)}`;
}

function repairArtifact(context: TaskDecisionContext) {
  return `ci-repair-result-${context.repairAttempts + 1}.json`;
}

const ciRepairAgent: TaskAgent = {
  name: 'ci-repair',
  async run(options, seed) {
    return taskAgentResultFromRepair(await runCIRepair({ ...options, opaqueOutcome: true }, seed));
  },
};

/**
 * CI task semantics, expressed once for every permission and every phase.
 *
 * The order is the contract: a retained candidate is finished first (that is what the pause
 * promised the human), then the current head's real CI state is read, and only then does the
 * permission decide what may follow. A pending or green CI reaches a mechanical outcome under
 * every permission, because capability may allow a repair but must never invent repair work that
 * does not exist.
 */
export const ciTaskDriver: TaskDriver = {
  executionType: 'ci',

  async decide(context): Promise<TaskDecision> {
    // A repair turn that changed nothing has not moved CI: the task is unresolved, and asking the
    // Agent again would only repeat it. This is CI's meaning for a no-op turn, not a general rule.
    const lastTurn = context.progress.turns.at(-1);
    if (lastTurn && !lastTurn.writtenBack) return { kind: 'blocked', reason: lastTurn.body };

    // A workspace retained from a previous CI cycle is continued before CI is re-read, because the
    // human's pause was about finishing that candidate. It is not a new repair attempt.
    if (context.writable && context.resumed && context.resumed.pausePhase !== 'ci' && !context.progress.turns.length) {
      return { kind: 'agent', mode: 'repair', agent: ciRepairAgent, artifact: repairArtifact(context), writebackKind: 'ci',
        countsAsRepairAttempt: true, seed: { instruction: RESUME_INSTRUCTION } };
    }

    await context.guardCycle('ci');
    const prepared = await prepareCiTask(context);
    if (prepared.state !== 'pending') context.trace.save(`ci-${context.headSha}.json`, prepared.ci);

    if (prepared.state === 'pending') return { kind: 'blocked', reason: PENDING_REASON };
    if (prepared.state === 'green') {
      return { kind: 'complete', status: 'ci_completed', body: completedBody(prepared.ci, context) };
    }
    if (prepared.state === 'red-evidence-unavailable') {
      return { kind: 'blocked', failureCode: 'ci_evidence_unavailable',
        reason: `CI 已确认失败，但无法获取失败证据（${prepared.error}）；保留红色 CI 状态，不会基于仓库文件猜测修复。` };
    }
    if (prepared.state === 'unknown') {
      return { kind: 'blocked', failureCode: 'ci_state_unavailable', reason: `SCM 未提供当前 head 的可确认 CI 终态（${prepared.error}）；不会基于未知状态推测修复。` };
    }

    const evidence = prepared.evidence;
    const seed = { ci: excerpt(JSON.stringify(evidence)) };
    if (context.phase === 'planning') {
      // Planning plans from the failure evidence, so the Plan describes this CI failure.
      return { kind: 'agent', mode: 'plan', agent: ciRepairAgent, artifact: 'ci-plan-turn.json', evidence, seed };
    }
    if (!context.writable) {
      return { kind: 'agent', mode: 'diagnose', agent: ciRepairAgent, artifact: 'ci-diagnosis.json', status: 'ci_completed',
        heading: '## CI 诊断', trailer: `最终 head：\`${context.headSha}\`\nGitHub CI：\n${ciSummary(prepared.ci)}`, evidence, seed };
    }
    if (context.repairAttempts >= context.repairBudget) {
      return { kind: 'blocked', reason: exhaustedReason(prepared.ci, context) };
    }
    return { kind: 'agent', mode: 'repair', agent: ciRepairAgent, artifact: repairArtifact(context), writebackKind: 'ci',
      countsAsRepairAttempt: true, evidence, seed };
  },
};
