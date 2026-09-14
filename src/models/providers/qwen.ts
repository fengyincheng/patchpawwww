import { ModelAdapterError, type ProviderAdapter } from '../types.ts';
import { applyCommonRequestOptions, optionBoolean, optionNumber, optionString } from '../openai-compatible.ts';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'max', 'auto']);

export const qwenAdapter: ProviderAdapter = {
  type: 'qwen',
  apiName: 'qwen',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  optionKeys: ['enable_thinking', 'thinking_budget', 'reasoning_effort'],
  transformRequestBody(body, options) {
    applyCommonRequestOptions(body, options);
    const enableThinking = optionBoolean(options, 'enable_thinking');
    const thinkingBudget = optionNumber(options, 'thinking_budget');
    const effort = optionString(options, 'reasoning_effort');
    if (thinkingBudget !== undefined && (!Number.isInteger(thinkingBudget) || thinkingBudget < 1)) throw new ModelAdapterError('invalid_configuration', 'Qwen thinking_budget must be a positive integer', 'thinking_budget');
    if (effort !== undefined && !REASONING_EFFORTS.has(effort)) throw new ModelAdapterError('invalid_configuration', `Unsupported Qwen reasoning_effort: ${effort}`, 'reasoning_effort');
    return { ...body, ...(enableThinking === undefined ? {} : { enable_thinking: enableThinking }),
      ...(thinkingBudget === undefined ? {} : { thinking_budget: thinkingBudget }), ...(effort ? { reasoning_effort: effort } : {}) };
  },
};
