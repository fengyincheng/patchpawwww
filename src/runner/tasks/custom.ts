import { runCustom } from '../../tasks/custom/agent.ts';
import type { TaskAgent, TaskDriver } from './driver.ts';

const customAgent: TaskAgent = {
  name: 'custom',
  run: (options, seed) => runCustom({ ...options, opaqueOutcome: true }, seed),
};

/**
 * A custom command answers and, when its permission allows writing, may leave a change behind.
 *
 * A turn that changed nothing is an ordinary completed answer here — unlike CI, where it means the
 * task is unresolved. That difference is why a no-op turn is the driver's decision and not the
 * runner's rule.
 */
export const customTaskDriver: TaskDriver = {
  executionType: 'custom',

  async decide(context) {
    const lastTurn = context.progress.turns.at(-1);
    if (lastTurn) {
      return { kind: 'complete', status: 'custom_completed',
        body: lastTurn.writtenBack ? `${lastTurn.body}\n\n---\nPatchPaw 提交：\`${lastTurn.sha}\`` : lastTurn.body };
    }
    return context.phase === 'planning'
      ? { kind: 'agent', mode: 'plan', agent: customAgent }
      : { kind: 'agent', mode: 'repair', countsAsRepairAttempt: false, agent: customAgent, writebackKind: 'custom' };
  },
};
