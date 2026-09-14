import { createOpenAICompatibleModel } from '../models/openai-compatible.ts';
import { getProviderAdapter } from '../models/registry.ts';
import type { ResolvedModelSelection } from '../models/types.ts';
import type { Trace } from './trace.ts';

export function modelConfig() {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error('ZAI_API_KEY is required');
  return { apiKey, baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
    model: process.env.ZAI_MODEL || 'glm-4.5-flash', reasoningEffort: process.env.ZAI_REASONING_EFFORT };
}

/**
 * Legacy Zhipu-only entry point. Stage 05 will remove its callers after the
 * runtime passes the resolver's ResolvedModelSelection into createModel.
 */
function legacySelection(): ResolvedModelSelection {
  const config = modelConfig();
  return { provider: { id: 'legacy-zai', type: 'zhipu' as const, baseUrl: config.baseURL, credentialRef: 'env:ZAI_API_KEY',
    requestOptions: config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}, enabled: true },
    model: { id: 'legacy-zai-model', identifier: config.model, enabled: true }, env: process.env };
}

// The optional selection is the stage-04 seam. When present, model identity is
// entirely resolved data; no ZAI_MODEL or other process-global model is used.
export function createModel(trace: Trace, task: string, selection?: ResolvedModelSelection) {
  const resolved = selection ?? legacySelection();
  return createOpenAICompatibleModel(trace, task, resolved, getProviderAdapter(resolved.provider.type));
}
