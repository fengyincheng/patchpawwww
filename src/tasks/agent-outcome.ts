import { TaskStopped } from '../runner/stop.ts';
import {
  AgentFinalResponseMissing,
  createTaskSession,
  ExecutionBudgetExhausted,
  type TaskAgentResult,
  type TaskOptions,
  templateValuesFromSeed,
} from '../harness/runtime.ts';
import { HumanHelpRequested } from './human-help.ts';

/**
 * Run one ordinary natural-language Agent turn and map only shared runtime facts to the
 * shared outcome contract. Task wrappers may still map a finished result to their business
 * vocabulary, but they do not interpret budgets, truncation, empty answers, or human help.
 */
export async function runNaturalLanguageTask(options: TaskOptions, seed: unknown): Promise<TaskAgentResult> {
  const session = createTaskSession({
    ...options,
    // This path publishes finalText, so the runtime must use last-step completion semantics too.
    opaqueOutcome: true,
    templateValues: options.templateValues ?? templateValuesFromSeed(seed),
  });
  try {
    try {
      const result = await session.turnResult(JSON.stringify(seed));
      // Earlier rounds of the same turn are tool-call narration; only the last step is the review.
      const body = result.finalText.trim();
      if (!body) {
        throw new AgentFinalResponseMissing({
          task: options.task, phase: 'execution', finishReason: result.finishReason,
          maxOutputTokens: result.maxOutputTokens, evidencePath: result.evidencePath,
          stepCount: result.stepCount, maxSteps: result.maxSteps,
        });
      }
      return { outcome: 'finished', body };
    } catch (error) {
      if (error instanceof ExecutionBudgetExhausted) {
        return { outcome: 'unfinished', status: 'budget_exhausted', reason: error.message };
      }
      if (error instanceof HumanHelpRequested) {
        return { outcome: 'unfinished', status: 'needs_human', reason: error.message };
      }
      if (error instanceof TaskStopped || options.stopSignal?.aborted) return await session.stop();
      throw error;
    }
  } finally {
    await session.close();
  }
}
