import { ModelAdapterError, type ProviderAdapter } from '../types.ts';
import { applyCommonRequestOptions, optionBoolean, optionString } from '../openai-compatible.ts';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'max', 'auto']);

export const deepseekAdapter: ProviderAdapter = {
  type: 'deepseek',
  apiName: 'deepseek',
  defaultBaseUrl: 'https://api.deepseek.com',
  optionKeys: ['reasoning_effort', 'thinking'],
  transformRequestBody(body, options) {
    applyCommonRequestOptions(body, options);
    const effort = optionString(options, 'reasoning_effort');
    if (effort !== undefined && !REASONING_EFFORTS.has(effort)) throw new ModelAdapterError('invalid_configuration', `Unsupported DeepSeek reasoning_effort: ${effort}`, 'reasoning_effort');
    const thinking = optionBoolean(options, 'thinking');
    return { ...body, ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...(thinking === undefined ? {} : { thinking: { type: thinking ? 'enabled' : 'disabled' } }) };
  },
};
