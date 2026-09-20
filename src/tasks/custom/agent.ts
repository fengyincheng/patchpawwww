import { createTaskSession, ModelOutputTruncated, templateValuesFromSeed, type TaskOptions, type TaskAgentResult } from '../../harness/runtime.ts';
import { runNaturalLanguageTask } from '../agent-outcome.ts';

/**
 * Execute a user-defined command as one independent natural-language task.
 * The immutable command snapshot is the complete instruction source: no built-in
 * review, repair, CI, or conflict result protocol is added here.
 */
type CustomOptions = Omit<TaskOptions, 'task' | 'prompt'>;
export function runCustom(options: CustomOptions & { opaqueOutcome: true }, seed: unknown): Promise<TaskAgentResult>;
export function runCustom(options: CustomOptions & { opaqueOutcome?: false | undefined }, seed: unknown): Promise<string>;
export function runCustom(options: CustomOptions, seed: unknown): Promise<string>;
export async function runCustom(options: CustomOptions, seed: unknown): Promise<TaskAgentResult | string> {
  if (options.opaqueOutcome) return await runOpaqueCustom(options, seed);
  const session = createTaskSession({ ...options, task: 'custom', prompt: '', templateValues: templateValuesFromSeed(seed) });
  try {
    const result = await session.turnResult(JSON.stringify(seed));
    if (result.finishReason === 'length') throw new ModelOutputTruncated({
      task: 'custom', finishReason: result.finishReason, maxOutputTokens: result.maxOutputTokens,
      usage: result.usage, evidencePath: result.evidencePath,
      provider: options.execution?.modelSelection.provider.type,
      model: options.execution?.modelSelection.model.identifier,
    });
    const answer = result.text.trim();
    if (!answer) throw new Error('Custom command returned an empty answer');
    return answer;
  } finally { await session.close(); }
}

/** New runs keep a custom command's natural-language answer opaque. */
export function runOpaqueCustom(options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown): Promise<TaskAgentResult> {
  return runNaturalLanguageTask({ ...options, task: 'custom', prompt: '' }, seed);
}
