import { ModelAdapterError, type ProviderAdapter } from '../types.ts';
import { applyCommonRequestOptions, optionString } from '../openai-compatible.ts';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'max', 'auto']);

export const zhipuAdapter: ProviderAdapter = {
  type: 'zhipu',
  apiName: 'zhipu',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  // `reasoning_effort` is the compatibility name retained for the old ZAI
  // configuration. It is translated here and nowhere in the shared layer.
  optionKeys: ['reasoning_effort'],
  transformRequestBody(body, options) {
    applyCommonRequestOptions(body, options);
    const effort = optionString(options, 'reasoning_effort');
    if (effort !== undefined && !REASONING_EFFORTS.has(effort)) throw new ModelAdapterError('invalid_configuration', `Unsupported Zhipu reasoning_effort: ${effort}`, 'reasoning_effort');
    return { ...body, thinking: { type: effort && effort !== 'none' ? 'enabled' : 'disabled' }, ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}) };
  },
};
