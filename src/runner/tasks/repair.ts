import { runRepair, taskAgentResultFromRepair } from '../../tasks/repair.ts';
import type { TaskAgent, TaskDriver } from './driver.ts';

const repairAgent: TaskAgent = {
  name: 'repair',
  async run(options, seed) {
    return taskAgentResultFromRepair(await runRepair({ ...options, opaqueOutcome: true }, seed));
  },
};

/**
 * Generic repair fixes what the PR needs fixed, without a remote CI signal.
 *
 * There is no CI to wait for, so the run is one turn plus whichever writeback its permission
 * allows; the Agent's own natural-language report is the deliverable.
 */
export const repairTaskDriver: TaskDriver = {
  executionType: 'repair',

  async decide(context) {
    const lastTurn = context.progress.turns.at(-1);
    if (lastTurn) {
      return { kind: 'complete', status: 'repair_completed',
        body: lastTurn.writtenBack ? `## 修复完成\n\n${lastTurn.body}\n\n提交：\`${lastTurn.sha}\`` : lastTurn.body };
    }
    return context.phase === 'planning'
      ? { kind: 'agent', mode: 'plan', agent: repairAgent }
      : { kind: 'agent', mode: 'repair', countsAsRepairAttempt: false, agent: repairAgent, writebackKind: 'repair', artifact: 'repair-result.json' };
  },
};
