import { ModelAdapterError, type ModelRequestOptions } from './types.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../harness/budget.ts';

export const OUTPUT_BUDGET_KEYS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const;
export type OutputBudgetKey = typeof OUTPUT_BUDGET_KEYS[number];
export type OutputBudgetSource = 'default' | OutputBudgetKey;

export interface OutputBudget {
  requested: number;
  effective: number;
  source: OutputBudgetSource;
  wireKey: 'max_tokens' | 'max_completion_tokens';
  capability?: number;
}

function validPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Resolve one output cap before the request reaches an adapter. The control
 * plane may store one explicit output option, but multiple aliases are
 * rejected rather than silently choosing one and changing operator intent.
 */
export function resolveOutputBudget(options: ModelRequestOptions, capability?: number): OutputBudget {
  const explicit = OUTPUT_BUDGET_KEYS.filter(key => options[key] !== undefined);
  if (explicit.length > 1) {
    throw new ModelAdapterError('invalid_configuration', 'Provider request options may contain only one output token limit.', 'request_options');
  }
  if (capability !== undefined && !validPositiveInteger(capability)) {
    throw new ModelAdapterError('invalid_configuration', 'Model maximum output tokens must be a positive integer.', 'model.max_output_tokens');
  }
  const explicitKey = explicit[0];
  const source: OutputBudgetSource = explicitKey ?? 'default';
  const requested = explicitKey === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : options[explicitKey];
  if (!validPositiveInteger(requested)) {
    throw new ModelAdapterError('invalid_configuration', 'Output token limit must be a positive integer.', explicitKey ?? 'max_output_tokens');
  }
  const effective = capability === undefined ? Number(requested) : Math.min(Number(requested), capability);
  return { requested: Number(requested), effective, source, ...(capability === undefined ? {} : { capability }),
    // OpenAI-compatible providers all accept max_tokens. Preserve the one
    // explicit max_completion_tokens spelling only when the operator chose it.
    wireKey: source === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens' };
}

export function applyOutputBudget(body: Record<string, unknown>, budget: OutputBudget) {
  for (const key of OUTPUT_BUDGET_KEYS) delete body[key];
  body[budget.wireKey] = budget.effective;
  return body;
}
