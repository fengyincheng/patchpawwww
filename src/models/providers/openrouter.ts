import { ModelAdapterError, type ProviderAdapter } from '../types.ts';
import { applyCommonRequestOptions, optionString } from '../openai-compatible.ts';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'max', 'auto']);

export const openrouterAdapter: ProviderAdapter = {
  type: 'openrouter',
  apiName: 'openrouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  optionKeys: ['reasoning_effort', 'http_referer', 'x_openrouter_title'],
  requestHeaders(options) {
    const headers: Record<string, string> = {};
    const referer = optionString(options, 'http_referer');
    const title = optionString(options, 'x_openrouter_title');
    if (referer) headers['HTTP-Referer'] = referer;
    if (title) headers['X-OpenRouter-Title'] = title;
    return headers;
  },
  transformRequestBody(body, options) {
    applyCommonRequestOptions(body, options);
    const effort = optionString(options, 'reasoning_effort');
    if (effort !== undefined && !REASONING_EFFORTS.has(effort)) throw new ModelAdapterError('invalid_configuration', `Unsupported OpenRouter reasoning_effort: ${effort}`, 'reasoning_effort');
    return { ...body, ...(effort ? { reasoning_effort: effort } : {}) };
  },
};
