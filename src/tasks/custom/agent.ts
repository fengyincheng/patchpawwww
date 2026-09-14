import { createTaskSession, ModelOutputTruncated, type TaskOptions, templateValuesFromSeed } from '../../harness/runtime.ts';

/**
 * Execute a user-defined command as one independent natural-language task.
 * The immutable command snapshot is the complete instruction source: no built-in
 * review, repair, CI, or conflict result protocol is added here.
 */
export async function runCustom(options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown) {
  const session = createTaskSession({
    ...options,
    task: 'custom',
    prompt: '',
    templateValues: templateValuesFromSeed(seed),
  });
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
  } finally {
    await session.close();
  }
}
