import type { ProviderAdapter } from '../types.ts';
import { applyCommonRequestOptions, optionBoolean } from '../openai-compatible.ts';

export const kimiAdapter: ProviderAdapter = {
  type: 'kimi',
  apiName: 'kimi',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',
  // Kimi's OpenAI-compatible API exposes this nested field; the control-plane
  // scalar option keeps the editable P0 request-options contract simple.
  optionKeys: ['thinking'],
  transformRequestBody(body, options) {
    applyCommonRequestOptions(body, options);
    const thinking = optionBoolean(options, 'thinking');
    return { ...body, ...(thinking === undefined ? {} : { thinking: { type: thinking ? 'enabled' : 'disabled' } }) };
  },
};
