import { deepseekAdapter } from './providers/deepseek.ts';
import { kimiAdapter } from './providers/kimi.ts';
import { openrouterAdapter } from './providers/openrouter.ts';
import { qwenAdapter } from './providers/qwen.ts';
import { zhipuAdapter } from './providers/zhipu.ts';
import type { ProviderAdapter } from './types.ts';
import type { ProviderType } from '../control-plane/types.ts';
import { ModelAdapterError } from './types.ts';

const adapters = new Map<ProviderType, ProviderAdapter>([
  ['zhipu', zhipuAdapter], ['deepseek', deepseekAdapter], ['openrouter', openrouterAdapter], ['kimi', kimiAdapter], ['qwen', qwenAdapter],
]);

export function getProviderAdapter(type: ProviderType) {
  const adapter = adapters.get(type);
  if (!adapter) throw new ModelAdapterError('invalid_configuration', `Unsupported provider type: ${type}`, 'provider_type');
  return adapter;
}

export function providerAdapters() {
  return [...adapters.values()];
}
