import { createTaskSession, ModelOutputTruncated, parseResult, renderRuntimePrompt, templateValuesFromSeed, type TaskOptions } from '../../harness/runtime.ts';
import { reviewResultSchema } from './result.ts';
export async function runReview(options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown) {
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
