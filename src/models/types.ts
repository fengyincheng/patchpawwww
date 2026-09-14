import type { ProviderType } from '../control-plane/types.ts';

export type ModelRequestOptionValue = string | number | boolean;
export type ModelRequestOptions = Record<string, ModelRequestOptionValue>;

/**
 * The model selection produced by the control-plane resolver.
 *
 * `model.identifier` is the exact provider model id entered by the operator.
 * No environment model name is consulted when this shape is supplied.
 */
export interface ResolvedModelSelection {
  provider: {
    id: string;
    type: ProviderType;
    baseUrl: string;
    credentialRef: string | null;
    requestOptions?: ModelRequestOptions;
    enabled?: boolean;
  };
  model: {
    id: string;
    identifier: string;
    enabled?: boolean;
    /** Optional explicitly sourced provider maximum; absent means unknown. */
    maxOutputTokens?: number;
  };
  /** Runtime home is needed only for provider slot credentials. */
  runtimeHome?: string;
  /** Injectable for deterministic fixtures; production uses process.env. */
  env?: NodeJS.ProcessEnv;
}

export type ModelAdapterErrorCode = 'invalid_configuration' | 'unsupported_request_option' | 'provider_unavailable';

export class ModelAdapterError extends Error {
  constructor(
    readonly code: ModelAdapterErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  readonly apiName: string;
  readonly defaultBaseUrl: string;
  readonly optionKeys: readonly string[];
  readonly requestHeaders?: (options: ModelRequestOptions) => Record<string, string>;
  transformRequestBody(body: Record<string, unknown>, options: ModelRequestOptions): Record<string, unknown>;
}
