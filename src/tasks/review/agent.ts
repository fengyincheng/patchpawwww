import { createTaskSession, ModelOutputTruncated, parseResult, renderRuntimePrompt, templateValuesFromSeed, type TaskOptions, type TaskAgentResult } from '../../harness/runtime.ts';
import { runNaturalLanguageTask } from '../agent-outcome.ts';
import { reviewResultSchema } from './result.ts';

type ReviewOptions = Omit<TaskOptions, 'task' | 'prompt'>;
export function runReview(options: ReviewOptions & { opaqueOutcome: true }, seed: unknown): Promise<TaskAgentResult>;
export function runReview(options: ReviewOptions & { opaqueOutcome?: false | undefined }, seed: unknown): Promise<ReturnType<typeof reviewResultSchema.parse>>;
export function runReview(options: ReviewOptions, seed: unknown): Promise<ReturnType<typeof reviewResultSchema.parse>>;
export async function runReview(options: ReviewOptions, seed: unknown): Promise<TaskAgentResult | ReturnType<typeof reviewResultSchema.parse>> {
  if (options.opaqueOutcome) return await runOpaqueReview(options, seed);
  const session = createTaskSession({ ...options, task: 'review', prompt: '', readOnly: true, templateValues: templateValuesFromSeed(seed) });
  try {
    const first = await session.turnResult(JSON.stringify(seed));
    if (first.finishReason === 'length') throw new ModelOutputTruncated({
      task: 'review', finishReason: first.finishReason, maxOutputTokens: first.maxOutputTokens, usage: first.usage,
      evidencePath: first.evidencePath, provider: options.execution?.modelSelection.provider.type,
      model: options.execution?.modelSelection.model.identifier,
    });
    let parsed = parseResult(first.text, reviewResultSchema);
    if (!parsed.success) {
      const retry = await session.turnResult(renderRuntimePrompt(options, 'review-json-retry', templateValuesFromSeed(seed)));
      if (retry.finishReason === 'length') throw new ModelOutputTruncated({
        task: 'review', finishReason: retry.finishReason, maxOutputTokens: retry.maxOutputTokens, usage: retry.usage,
        evidencePath: retry.evidencePath, provider: options.execution?.modelSelection.provider.type,
        model: options.execution?.modelSelection.model.identifier,
      });
      parsed = parseResult(retry.text, reviewResultSchema);
    }
    if (!parsed.success) throw new Error('Review result schema invalid');
    return parsed.data;
  } finally { await session.close(); }
}

/** New runs keep the Agent's natural-language review opaque. */
export function runOpaqueReview(options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown): Promise<TaskAgentResult> {
  return runNaturalLanguageTask({ ...options, task: 'review', prompt: '' }, seed);
}
