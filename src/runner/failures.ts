import { ModelOutputTruncated } from '../harness/runtime.ts';
import { ProviderResponseError, ProviderUnavailable, providerError, type ProviderFailureCode } from '../harness/retry.ts';
import { ModelAdapterError } from '../models/types.ts';

export type FailureCategory = 'provider' | 'model' | 'github' | 'workspace' | 'internal';
export type FailureAction = 'retry' | 'check_configuration' | 'human_review' | 'inspect_logs';

export interface RunFailure {
  code: string;
  category: FailureCategory;
  retryable: boolean;
  user_action: FailureAction;
  message: string;
  upstream_status?: number;
  upstream_code?: string | number;
  attempts?: number;
}

function clip(value: string, max = 1000) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function providerFailure(code: ProviderFailureCode | 'provider_unavailable', details: {
  message: string; retryable?: boolean; status?: number; upstreamCode?: string | number; attempts?: number;
}): RunFailure {
  const retryable = details.retryable ?? code === 'provider_upstream_unavailable';
  return { code, category: 'provider', retryable,
    user_action: retryable ? 'retry' : code === 'provider_auth_failed' || code === 'provider_configuration_error' ? 'check_configuration' : 'inspect_logs',
    message: clip(details.message), ...(details.status === undefined ? {} : { upstream_status: details.status }),
    ...(details.upstreamCode === undefined ? {} : { upstream_code: details.upstreamCode }),
    ...(details.attempts === undefined ? {} : { attempts: details.attempts }) };
}

export function classifyRunFailure(error: unknown): RunFailure {
  if (error instanceof ModelOutputTruncated) {
    return { code: 'model_output_truncated', category: 'model', retryable: true, user_action: 'retry',
      message: '模型输出达到上限，未生成完整结果。' };
  }
  if (error instanceof ProviderResponseError) {
    return providerFailure(error.failureCode, { message: error.upstreamMessage ?? error.message, retryable: error.retryable,
      status: error.status, upstreamCode: error.upstreamCode });
  }
  if (error instanceof ProviderUnavailable) {
    const details = error.details;
    return providerFailure(details.failureCode ?? 'provider_unavailable', { message: details.upstreamMessage ?? error.message,
      retryable: details.retryable, status: details.status, upstreamCode: details.upstreamCode, attempts: details.attempts });
  }
  if (error instanceof ModelAdapterError) {
    return providerFailure(error.code === 'provider_unavailable' ? 'provider_configuration_error' : 'provider_protocol_error', {
      message: error.message, retryable: false,
    });
  }

  const facts = providerError(error);
  if (error instanceof Error && (error.name === 'HttpError' || error.name === 'RequestError')) {
    const retryable = facts.status === undefined || facts.status === 408 || facts.status === 429 || facts.status >= 500;
    return { code: 'github_unavailable', category: 'github', retryable, user_action: retryable ? 'retry' : 'human_review',
      message: clip(error.message), ...(facts.status === undefined ? {} : { upstream_status: facts.status }) };
  }
  return { code: 'internal_error', category: 'internal', retryable: false, user_action: 'inspect_logs',
    message: clip(error instanceof Error ? error.message : String(error)) };
}

export function terminalStatusForFailure(failure: RunFailure) {
  if (failure.code === 'model_output_truncated') return 'model_output_truncated' as const;
  if (failure.category === 'provider') return 'provider_unavailable' as const;
  return 'harness_failed' as const;
}
