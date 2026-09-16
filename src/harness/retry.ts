import { setTimeout } from 'node:timers/promises';

export class ProviderUnavailable extends Error {
  readonly code = 'provider_unavailable';
  constructor(message = 'Provider unavailable after transient retries', readonly details: ProviderFailureDetails = {}) {
    super(message); this.name = 'ProviderUnavailable';
  }
}

export type ProviderFailureCode = 'provider_upstream_unavailable' | 'provider_auth_failed'
  | 'provider_request_rejected' | 'provider_configuration_error' | 'provider_protocol_error';

export interface ProviderFailureDetails {
  failureCode?: ProviderFailureCode;
  status?: number;
  upstreamCode?: string | number;
  upstreamMessage?: string;
  retryable?: boolean;
  attempts?: number;
  retryAfterMs?: number;
}

export class ProviderResponseError extends Error {
  readonly code = 'provider_response_error';
  constructor(readonly failureCode: ProviderFailureCode, message: string, readonly details: ProviderFailureDetails = {}) {
    super(message); this.name = 'ProviderResponseError';
  }
  get status() { return this.details.status; }
  get upstreamCode() { return this.details.upstreamCode; }
  get upstreamMessage() { return this.details.upstreamMessage; }
  get retryable() { return this.details.retryable ?? false; }
}

export function providerError(error: unknown) {
  const e = error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string; cause?: { code?: string; cause?: { code?: string } };
    failureCode?: string; upstreamCode?: string | number; upstreamMessage?: string; retryable?: boolean; details?: ProviderFailureDetails };
  const details = e.details ?? {};
  return { status: e.status ?? e.statusCode ?? details.status, code: e.code ?? e.cause?.code ?? e.cause?.cause?.code,
    name: e.name, failure_code: e.failureCode ?? details.failureCode, upstream_status: e.status ?? e.statusCode ?? details.status,
    upstream_code: e.upstreamCode ?? details.upstreamCode, upstream_message: e.upstreamMessage ?? details.upstreamMessage,
    retryable: e.retryable ?? details.retryable, attempts: details.attempts };
}
export function retryAfterMs(error: unknown) {
  const e = error as { retryAfter?: string | number; response?: { headers?: Record<string, string | number | undefined> }; headers?: Record<string, string | number | undefined>; details?: ProviderFailureDetails };
  if (e.details?.retryAfterMs !== undefined) return e.details.retryAfterMs;
  const headers = e.response?.headers ?? e.headers ?? {};
  const value = e.retryAfter ?? headers['retry-after'] ?? headers['Retry-After'];
  if (value === undefined) return undefined;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) return Number(value) * 1000;
  const parsed = Date.parse(String(value)) - Date.now();
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}
export function isRateLimited(error: unknown) {
  const e = error as { status?: number; retryAfter?: string | number; response?: { headers?: Record<string, string | number | undefined> }; headers?: Record<string, string | number | undefined>; message?: string };
  if ((e.status ?? (error as { statusCode?: number }).statusCode) !== 403) return false;
  const headers = e.response?.headers ?? e.headers ?? {};
  const retryHeader = headers['retry-after'] ?? headers['Retry-After'];
  return e.retryAfter !== undefined || retryHeader !== undefined || String(headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining']) === '0'
    || /rate.?limit|secondary limit|abuse detection/i.test(e.message ?? '');
}
export function isTransient(error: unknown) {
  const e = providerError(error);
  // An HTTP status is authoritative for 4xx errors. Transport-shaped text in
  // an SDK message must not turn a permanent permission/input failure into a
  // background retry storm.
  if (e.status !== undefined && e.status >= 400 && e.status < 500
    && e.status !== 408 && e.status !== 429 && !isRateLimited(error)) return false;
  return e.status === 408 || e.status === 429 || (e.status !== undefined && e.status >= 500) || isRateLimited(error)
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(e.code ?? '')
    || e.name === 'TimeoutError' || /fetch failed|socket hang up|temporar(?:y|ily)|timed? ?out|Client network socket disconnected before secure TLS connection was established/i.test(String((error as Error).message));
}
export async function retryProvider<T>(call: () => Promise<T>, options: {
  sleep?: (ms: number) => Promise<unknown>; jitter?: () => number;
  onRetry?: (event: object) => void; signal?: AbortSignal;
} = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!isTransient(error)) throw error;
      if (attempt === 3) {
        const facts = providerError(error);
        throw new ProviderUnavailable('Provider unavailable after transient retries', {
          failureCode: error instanceof ProviderResponseError ? error.failureCode : 'provider_upstream_unavailable',
          status: facts.status, upstreamCode: facts.upstream_code, upstreamMessage: facts.upstream_message,
          retryable: true, attempts: attempt + 1,
        });
      }
      const retryAfter = retryAfterMs(error);
      const delayMs = retryAfter !== undefined ? retryAfter
        : [5000, 15000, 30000][attempt] + (options.jitter?.() ?? Math.random() * 1000);
      options.onRetry?.({ attempt: attempt + 1, delay_ms: delayMs, error: providerError(error) });
      await (options.sleep ? options.sleep(delayMs) : setTimeout(delayMs, undefined, { signal: options.signal }));
    }
  }
}
