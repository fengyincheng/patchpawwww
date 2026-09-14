import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { configuredRuntimeHome } from '../config/env.ts';
import { SecretStore } from '../control-plane/secrets.ts';
import { ProviderResponseError, ProviderUnavailable, providerError, retryProvider, type ProviderFailureCode } from '../harness/retry.ts';
import { budget } from '../harness/budget.ts';
import { bounded, type Trace } from '../harness/trace.ts';
import type { ModelRequestOptions, ProviderAdapter, ResolvedModelSelection } from './types.ts';
import { ModelAdapterError } from './types.ts';
import { applyOutputBudget, resolveOutputBudget } from './output-budget.ts';

const PROVIDER_SPECIFIC_KEYS = ['thinking', 'reasoning_effort', 'reasoning', 'enable_thinking', 'thinking_budget'];

/** Options that are safe and have the same meaning across the five transports. */
export const COMMON_REQUEST_OPTIONS = [
  'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'seed',
] as const;

function assertOptionKeys(adapter: ProviderAdapter, options: ModelRequestOptions) {
  const allowed = new Set([...COMMON_REQUEST_OPTIONS, ...adapter.optionKeys]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new ModelAdapterError('unsupported_request_option', `Request option is not supported by ${adapter.type}: ${key}`, key);
  }
}

function sanitizedBody(body: Record<string, unknown>) {
  const copy = { ...body };
  for (const key of PROVIDER_SPECIFIC_KEYS) delete copy[key];
  return copy;
}

export function applyCommonRequestOptions(body: Record<string, unknown>, options: ModelRequestOptions) {
  for (const key of COMMON_REQUEST_OPTIONS) {
    if (options[key] !== undefined) body[key] = options[key];
  }
  return body;
}

export function optionString(options: ModelRequestOptions, key: string) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new ModelAdapterError('invalid_configuration', `${key} must be a non-empty string.`, key);
  return value.trim();
}

export function optionBoolean(options: ModelRequestOptions, key: string) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ModelAdapterError('invalid_configuration', `${key} must be a boolean.`, key);
  return value;
}

export function optionNumber(options: ModelRequestOptions, key: string) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ModelAdapterError('invalid_configuration', `${key} must be a finite number.`, key);
  return value;
}

function hasSseDoneMarker(raw: string) {
  return /^data:\s*\[DONE\]\s*$/m.test(raw);
}

function numericStatus(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function failureCodeForStatus(status: number | undefined): ProviderFailureCode {
  if (status === 401 || status === 403) return 'provider_auth_failed';
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return 'provider_upstream_unavailable';
  if (status !== undefined && status >= 400) return 'provider_request_rejected';
  return 'provider_protocol_error';
}

function retryableStatus(status: number | undefined) {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function providerResponseError(raw: string, responseStatus: number) {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { payload = undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const envelope = (payload as { error?: unknown }).error;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return undefined;
  const error = envelope as { code?: unknown; status?: unknown; message?: unknown; type?: unknown };
  const upstreamStatus = numericStatus(error.status) ?? numericStatus(error.code) ?? numericStatus(responseStatus);
  const failureCode = failureCodeForStatus(upstreamStatus);
  const upstreamMessage = typeof error.message === 'string' ? error.message.slice(0, 1000) : undefined;
  const upstreamCode = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
  return new ProviderResponseError(failureCode, upstreamMessage ?? 'Provider returned an error envelope', {
    status: upstreamStatus ?? (responseStatus >= 400 ? responseStatus : undefined), upstreamCode, upstreamMessage,
    retryable: retryableStatus(upstreamStatus),
  });
}

function providerCredentialError() {
  // Deliberately omit the original error: provider errors and traces must not
  // become an accidental secret/configuration oracle.
  return new ProviderUnavailable('Provider credential is unavailable', { failureCode: 'provider_auth_failed', retryable: false });
}

function assertUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new ModelAdapterError('invalid_configuration', 'Provider base URL must be an absolute HTTP(S) URL.', 'base_url');
  }
}

/**
 * Shared OpenAI-compatible HTTP transport. It buffers one response before the
 * SDK sees it, so a broken stream retries the same HTTP exchange rather than
 * replaying the surrounding tool loop.
 */
export function createOpenAICompatibleModel(trace: Trace, task: string, selection: ResolvedModelSelection, adapter: ProviderAdapter) {
  const providerOptions = selection.provider.requestOptions ?? {};
  const outputBudget = resolveOutputBudget(providerOptions, selection.model.maxOutputTokens);
  assertOptionKeys(adapter, providerOptions);
  assertUrl(selection.provider.baseUrl);
  if (!selection.model.identifier.trim()) throw new ModelAdapterError('invalid_configuration', 'Provider model identifier cannot be empty.', 'model_identifier');
  if (selection.provider.enabled === false || selection.model.enabled === false) {
    throw new ProviderUnavailable('Configured provider or model is unavailable', { failureCode: 'provider_configuration_error', retryable: false });
  }

  const runtimeHome = selection.runtimeHome ?? configuredRuntimeHome();
  const secrets = new SecretStore(runtimeHome);
  let requestIndex = 0;
  let unavailable = false;

  const transport: typeof fetch = async (input, init) => {
    const request = ++requestIndex;
    const body = applyOutputBudget(adapter.transformRequestBody(sanitizedBody(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>), providerOptions), outputBudget);
    const bodyText = JSON.stringify(body);
    const wire = bounded(body);
    trace.emit('model_request', { task, provider: selection.provider.type, provider_id: selection.provider.id,
      model: selection.model.identifier, request, body_chars: wire.chars, body_sha256: wire.sha256,
      output_budget: outputBudget.effective, output_budget_source: outputBudget.source, output_budget_wire_key: outputBudget.wireKey,
      body_truncated: wire.truncated, body_excerpt: wire.excerpt });

    let apiKey: string;
    try {
      if (!selection.provider.credentialRef) throw new Error('missing credential reference');
      // Read at model-call time, not while resolving or creating the model. A
      // stable slot can therefore be rotated without changing a snapshot.
      apiKey = await secrets.read(selection.provider.credentialRef, selection.env ?? process.env);
      trace.secret(apiKey);
    } catch {
      unavailable = true;
      throw providerCredentialError();
    }

    let attempt = 0;
    try {
      return await retryProvider(async () => {
        const started = Date.now();
        attempt++;
        trace.emit('provider_attempt', { task, provider: selection.provider.type, provider_id: selection.provider.id,
          model: selection.model.identifier, request, attempt });
        try {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${apiKey}`);
          for (const [name, value] of Object.entries(adapter.requestHeaders?.(providerOptions) ?? {})) headers.set(name, value);
          const response = await fetch(input, { ...init, headers, body: bodyText,
            signal: AbortSignal.any([AbortSignal.timeout(budget.providerMs), ...(init?.signal ? [init.signal] : [])]) });
          const raw = await response.text();
          const responseWire = bounded(raw);
          trace.emit('model_response', { task, provider: selection.provider.type, provider_id: selection.provider.id,
            model: selection.model.identifier, request, attempt, status: response.status, duration_ms: Date.now() - started,
            raw_chars: responseWire.chars, raw_sha256: responseWire.sha256, raw_truncated: responseWire.truncated,
            raw_excerpt: responseWire.excerpt });
          const envelopeError = providerResponseError(raw, response.status);
          if (envelopeError) throw envelopeError;
          if (!response.ok) throw new ProviderResponseError(failureCodeForStatus(response.status), 'Provider HTTP error', {
            status: response.status, retryable: retryableStatus(response.status),
          });
          if (body.stream && !hasSseDoneMarker(raw)) throw Object.assign(new Error('Incomplete provider stream'), {
            code: 'ECONNRESET', retryAfter: response.headers.get('retry-after') ?? undefined,
          });
          return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (error) {
          trace.emit('provider_error', { task, provider: selection.provider.type, provider_id: selection.provider.id,
            model: selection.model.identifier, request, attempt, duration_ms: Date.now() - started, ...providerError(error) });
          throw error;
        }
      }, { signal: init?.signal ?? undefined, onRetry: event => trace.emit('provider_retry', { task,
        provider: selection.provider.type, provider_id: selection.provider.id, model: selection.model.identifier, request, ...event }) });
    } catch (error) {
      if (error instanceof ProviderUnavailable) unavailable = true;
      throw error;
    }
  };

  const headers = adapter.requestHeaders?.(providerOptions);
  const provider = createOpenAICompatible({
    name: adapter.apiName,
    baseURL: selection.provider.baseUrl,
    headers,
    fetch: transport,
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
  return { model: provider.chatModel(selection.model.identifier), isUnavailable: () => unavailable, adapter: adapter.type };
}
