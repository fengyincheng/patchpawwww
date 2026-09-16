import { ModelOutputTruncated } from '../harness/runtime.ts';
import { ProviderResponseError, ProviderUnavailable, providerError, type ProviderFailureCode } from '../harness/retry.ts';
import { ModelAdapterError } from '../models/types.ts';
import { ControlPlaneError } from '../control-plane/errors.ts';
import { GitLabHttpError } from '../scm/gitlab/client.ts';

export type FailureCategory = 'provider' | 'model' | 'scm' | 'workspace' | 'internal';
export type FailureAction = 'retry' | 'check_configuration' | 'human_review' | 'inspect_logs';
export type ScmPlatform = 'github' | 'gitlab';

export interface RunFailure {
  code: string;
  category: FailureCategory;
  retryable: boolean;
  user_action: FailureAction;
  message: string;
  upstream_status?: number;
  upstream_code?: string | number;
  attempts?: number;
  scm_platform?: ScmPlatform;
}

function sanitize(value: string) {
  return value
    .replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(?:PRIVATE-TOKEN|GITLAB_TOKEN|Authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]');
}

function clip(value: string, max = 1000) {
  const safe = sanitize(value);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
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
  const providerCode = facts.failure_code;
  if (providerCode && ['provider_upstream_unavailable', 'provider_auth_failed', 'provider_request_rejected',
    'provider_configuration_error', 'provider_protocol_error'].includes(providerCode)) {
    return providerFailure(providerCode as ProviderFailureCode, { message: facts.upstream_message ?? (error as Error)?.message ?? String(error),
      retryable: facts.retryable, status: facts.upstream_status, upstreamCode: facts.upstream_code, attempts: facts.attempts });
  }
  if (error instanceof ControlPlaneError && (error.code === 'provider_unavailable'
      || error.code === 'invalid_configuration' && (/provider|model|credential|request option/i.test(error.message)))) {
    return providerFailure('provider_configuration_error', { message: error.message, retryable: false });
  }
  const errorStatus = facts.status;
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (error instanceof GitLabHttpError || error instanceof Error && error.name === 'GitLabHttpError') {
    const status = error instanceof GitLabHttpError ? error.status : errorStatus;
    const message = clip(errorMessage);
    if (/invalid json|protocol|returned invalid/i.test(errorMessage)) {
      return { code: 'gitlab_protocol_error', category: 'scm', scm_platform: 'gitlab', retryable: false,
        user_action: 'inspect_logs', message, ...(status === undefined ? {} : { upstream_status: status }),
        ...(facts.upstream_code === undefined ? {} : { upstream_code: facts.upstream_code }) };
    }
    if (status === 401 || status === 403) {
      return { code: 'gitlab_auth_failed', category: 'scm', scm_platform: 'gitlab', retryable: false,
        user_action: 'check_configuration', message, upstream_status: status,
        ...(facts.upstream_code === undefined ? {} : { upstream_code: facts.upstream_code }) };
    }
    if (status === undefined || status === 408 || status === 429 || status >= 500) {
      return { code: 'gitlab_unavailable', category: 'scm', scm_platform: 'gitlab', retryable: true,
        user_action: 'retry', message, ...(status === undefined ? {} : { upstream_status: status }),
        ...(facts.upstream_code === undefined ? {} : { upstream_code: facts.upstream_code }) };
    }
    return { code: 'gitlab_request_rejected', category: 'scm', scm_platform: 'gitlab', retryable: false,
      user_action: 'check_configuration', message, upstream_status: status,
      ...(facts.upstream_code === undefined ? {} : { upstream_code: facts.upstream_code }) };
  }
  if (facts.code === 'GITLAB_CONFIGURATION_ERROR') {
    return { code: 'gitlab_auth_failed', category: 'scm', scm_platform: 'gitlab', retryable: false,
      user_action: 'check_configuration', message: clip(errorMessage) };
  }
  if (facts.code === 'GITLAB_NETWORK_ERROR' || /GitLab request failed/i.test(errorMessage) && facts.code) {
    return { code: 'gitlab_unavailable', category: 'scm', scm_platform: 'gitlab', retryable: true,
      user_action: 'retry', message: clip(errorMessage), ...(facts.upstream_status === undefined ? {} : { upstream_status: facts.upstream_status }),
      ...(facts.upstream_code === undefined ? {} : { upstream_code: facts.upstream_code }) };
  }
  if (error instanceof Error && (error.name === 'HttpError' || error.name === 'RequestError')) {
    const retryable = facts.status === undefined || facts.status === 408 || facts.status === 429 || facts.status >= 500;
    return { code: 'github_unavailable', category: 'scm', scm_platform: 'github', retryable, user_action: retryable ? 'retry' : 'human_review',
      message: clip(error.message), ...(facts.status === undefined ? {} : { upstream_status: facts.status }) };
  }
  return { code: 'internal_error', category: 'internal', retryable: false, user_action: 'inspect_logs',
    message: clip(errorMessage) };
}

export function terminalStatusForFailure(failure: RunFailure) {
  if (failure.code === 'model_output_truncated') return 'model_output_truncated' as const;
  if (failure.category === 'provider') return 'provider_unavailable' as const;
  return 'harness_failed' as const;
}
