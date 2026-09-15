export type ProviderType = 'zhipu' | 'deepseek' | 'openrouter' | 'kimi' | 'qwen';
export type ExecutionType = 'custom' | 'review' | 'repair' | 'ci' | 'conflict';
export type Permission = 'read_only' | 'read_write';
export type BindingKind = 'main' | 'common' | 'auxiliary';

export interface Repository {
  id: string;
  full_name: string;
  display_name: string;
  revision: number;
  created_at: string;
  updated_at: string;
  scm_kind?: 'github' | 'gitlab';
  connection_id?: string | null;
  remote_project_id?: string | null;
  path_with_namespace?: string | null;
  web_url?: string | null;
  clone_url?: string | null;
  storage_key?: string;
}

export interface ScmConnection {
  id: string;
  kind: 'github' | 'gitlab';
  instance_url: string;
  credential_ref: string | null;
  credential_configured: boolean;
  webhook_mode: 'secret' | 'signing';
  webhook_secret_ref: string | null;
  webhook_secret_configured: boolean;
  bot_user_id: string | null;
  bot_login: string | null;
  project_ids: string[];
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface PromptAsset {
  id: string;
  scope: 'public' | 'repository';
  repository_id: string | null;
  slug: string;
  title: string;
  role: string | null;
  content: string;
  enabled: boolean;
  revision: number;
  source_public_id: string | null;
  source_public_revision: number | null;
  source_status: 'active' | 'deleted' | null;
  created_at: string;
  updated_at: string;
}

export interface SkillAsset {
  id: string;
  scope: 'public' | 'repository';
  repository_id: string | null;
  slug: string;
  title: string;
  description: string;
  content: string;
  enabled: boolean;
  revision: number;
  source_public_id: string | null;
  source_public_revision: number | null;
  source_status: 'active' | 'deleted' | null;
  created_at: string;
  updated_at: string;
}

export interface Model {
  id: string;
  provider_id: string;
  model_identifier: string;
  display_name: string;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface Provider {
  id: string;
  type: ProviderType;
  display_name: string;
  base_url: string;
  credential_ref: string | null;
  credential_configured: boolean;
  request_options: Record<string, string | number | boolean>;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  models?: Model[];
}

export interface PromptBinding {
  asset_id: string;
  position: number;
  enabled: boolean;
  binding_kind: BindingKind;
}

export interface SkillBinding {
  asset_id: string;
  position: number;
  enabled: boolean;
}

export interface Command {
  id: string;
  repository_id: string;
  slash_name: string;
  display_name: string;
  description: string;
  execution_type: ExecutionType;
  permission: Permission;
  provider_model_id: string;
  enabled: boolean;
  revision: number;
  prompt_bindings: PromptBinding[];
  skill_bindings: SkillBinding[];
  created_at: string;
  updated_at: string;
}

export interface ConversationProfile {
  id: string;
  repository_id: string;
  display_name: string;
  provider_model_id: string;
  permission: 'read_only';
  enabled: boolean;
  revision: number;
  prompt_bindings: PromptBinding[];
  skill_bindings: SkillBinding[];
  created_at: string;
  updated_at: string;
}

export interface EffectivePart {
  kind: 'prompt' | 'skill';
  position: number;
  asset_id: string;
  slug: string;
  role: string | null;
  scope: 'repository';
  revision: number;
  sha256: string;
  content: string;
  source_public_id: string | null;
  source_public_revision: number | null;
  source_status: 'active' | 'deleted' | null;
}

export interface EffectiveConfiguration {
  target: 'command' | 'conversation';
  execution_id: string;
  command?: { id: string; slash_name: string; revision: number };
  conversation_profile?: { id: string; revision: number; permission: 'read_only' };
  execution_type: string;
  permission: Permission;
  output_contract: { kind: string; schema_id?: string };
  provider: { id: string; type: string; display_name: string; base_url: string; revision: number; credential_ref: string; request_options: Record<string, string | number | boolean> };
  model: Model;
  parts: EffectivePart[];
  snapshot_id: string;
  snapshot_sha256: string;
}

export interface Session {
  authenticated: boolean;
  expires_at: string;
}

export interface PublicSetupInfo {
  public_origin: string | null;
  webhook_url: string | null;
  https_enabled: boolean;
  admin_auth_configured: boolean;
}

export interface BootstrapResult {
  repository: Repository;
  bootstrap_version: number;
  migration_version: number;
  repository_result: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly details?: Record<string, string | number | boolean | null>;
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, status: number, payload: { code?: string; field?: string; details?: Record<string, string | number | boolean | null> } = {}, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = payload.code ?? 'request_failed';
    this.field = payload.field;
    this.details = payload.details;
    this.status = status;
    this.requestId = requestId;
  }
}

type Envelope<T> = { data: T } | { error: { code: string; message: string; field?: string; details?: Record<string, string | number | boolean | null> }; request_id?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  let payload: Envelope<T> | undefined;
  try { payload = await response.json() as Envelope<T>; } catch { payload = undefined; }
  if (!response.ok || !payload || !('data' in payload)) {
    const error = payload && 'error' in payload ? payload.error : undefined;
    throw new ApiError(error?.message ?? `Request failed (${response.status}).`, response.status,
      { code: error?.code, field: error?.field, details: error?.details }, payload && 'request_id' in payload ? payload.request_id : undefined);
  }
  return payload.data;
}

const encodedRepo = (fullName: string) => encodeURIComponent(fullName);
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const revisionQuery = (path: string, revision: number) => `${path}?expected_revision=${encodeURIComponent(revision)}`;

export const adminApi = {
  setup: () => request<PublicSetupInfo>('/api/setup'),
  session: () => request<Session>('/api/admin/auth/session'),
  login: (token: string) => request<Session>('/api/admin/auth/login', json({ token })),
  logout: () => request<Session>('/api/admin/auth/logout', json({})),
  repositories: () => request<Repository[]>('/api/admin/repositories'),
  scmConnections: () => request<ScmConnection[]>('/api/admin/scm-connections'),
  createScmConnection: (body: ScmConnectionPayload) => request<ScmConnection>('/api/admin/scm-connections', json(body)),
  setScmCredential: (connection: ScmConnection, credential: string) => request<ScmConnection>(`/api/admin/scm-connections/${encodeURIComponent(connection.id)}/credential`, { method: 'PUT', body: JSON.stringify({ secret: credential }) }),
  setScmWebhookSecret: (connection: ScmConnection, secret: string) => request<ScmConnection>(`/api/admin/scm-connections/${encodeURIComponent(connection.id)}/webhook-secret`, { method: 'PUT', body: JSON.stringify({ secret }) }),
  verifyScmConnection: (connection: ScmConnection) => request<{ status: string; bot?: { id: string; login: string }; projects?: Array<{ id: string; path_with_namespace?: string }> }>(`/api/admin/scm-connections/${encodeURIComponent(connection.id)}/verify`, json({})),
  repository: (repo: string) => request<Repository>(`/api/admin/repositories/${encodedRepo(repo)}`),
  bootstrap: (repo: string, displayName?: string) => request<BootstrapResult>(`/api/admin/repositories/${encodedRepo(repo)}/bootstrap`, json(displayName ? { display_name: displayName } : {})),
  updateRepository: (repo: Repository, displayName: string) => request<Repository>(`/api/admin/repositories/${encodedRepo(repo.id)}`, patch({ display_name: displayName, expected_revision: repo.revision })),
  publicPrompts: () => request<PromptAsset[]>('/api/admin/prompts/public'),
  createPublicPrompt: (body: PromptPayload) => request<PromptAsset>('/api/admin/prompts/public', json(body)),
  updatePublicPrompt: (asset: PromptAsset, body: PromptPayload) => request<PromptAsset>(`/api/admin/prompts/public/${asset.id}`, patch({ ...body, expected_revision: asset.revision })),
  deletePublicPrompt: (asset: PromptAsset) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/prompts/public/${asset.id}`, asset.revision), { method: 'DELETE' }),
  repositoryPrompts: (repo: string) => request<PromptAsset[]>(`/api/admin/repositories/${encodedRepo(repo)}/prompts`),
  createRepositoryPrompt: (repo: string, body: PromptPayload) => request<PromptAsset>(`/api/admin/repositories/${encodedRepo(repo)}/prompts`, json(body)),
  updateRepositoryPrompt: (repo: string, asset: PromptAsset, body: PromptPayload) => request<PromptAsset>(`/api/admin/repositories/${encodedRepo(repo)}/prompts/${asset.id}`, patch({ ...body, expected_revision: asset.revision })),
  deleteRepositoryPrompt: (repo: string, asset: PromptAsset) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/repositories/${encodedRepo(repo)}/prompts/${asset.id}`, asset.revision), { method: 'DELETE' }),
  copyPublicPrompt: (repo: string, publicId: string, replace = false, expectedRepositoryRevision?: number) => request<PromptAsset>(`/api/admin/repositories/${encodedRepo(repo)}/prompts/copy-public/${publicId}`, json({ replace, ...(expectedRepositoryRevision ? { expected_repository_revision: expectedRepositoryRevision } : {}) })),
  publicSkills: () => request<SkillAsset[]>('/api/admin/skills/public'),
  createPublicSkill: (body: SkillPayload) => request<SkillAsset>('/api/admin/skills/public', json(body)),
  updatePublicSkill: (asset: SkillAsset, body: SkillPayload) => request<SkillAsset>(`/api/admin/skills/public/${asset.id}`, patch({ ...body, expected_revision: asset.revision })),
  deletePublicSkill: (asset: SkillAsset) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/skills/public/${asset.id}`, asset.revision), { method: 'DELETE' }),
  repositorySkills: (repo: string) => request<SkillAsset[]>(`/api/admin/repositories/${encodedRepo(repo)}/skills`),
  createRepositorySkill: (repo: string, body: SkillPayload) => request<SkillAsset>(`/api/admin/repositories/${encodedRepo(repo)}/skills`, json(body)),
  updateRepositorySkill: (repo: string, asset: SkillAsset, body: SkillPayload) => request<SkillAsset>(`/api/admin/repositories/${encodedRepo(repo)}/skills/${asset.id}`, patch({ ...body, expected_revision: asset.revision })),
  deleteRepositorySkill: (repo: string, asset: SkillAsset) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/repositories/${encodedRepo(repo)}/skills/${asset.id}`, asset.revision), { method: 'DELETE' }),
  copyPublicSkill: (repo: string, publicId: string, replace = false, expectedRepositoryRevision?: number) => request<SkillAsset>(`/api/admin/repositories/${encodedRepo(repo)}/skills/copy-public/${publicId}`, json({ replace, ...(expectedRepositoryRevision ? { expected_repository_revision: expectedRepositoryRevision } : {}) })),
  providers: () => request<Provider[]>('/api/admin/providers'),
  createProvider: (body: ProviderPayload) => request<Provider>('/api/admin/providers', json(body)),
  updateProvider: (provider: Provider, body: Partial<ProviderPayload>) => request<Provider>(`/api/admin/providers/${provider.id}`, patch({ ...body, expected_revision: provider.revision })),
  deleteProvider: (provider: Provider) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/providers/${provider.id}`, provider.revision), { method: 'DELETE' }),
  setCredential: (provider: Provider, credential: string) => request<{ configured: boolean; credential_ref: string | null }>(`/api/admin/providers/${provider.id}/credential`, { method: 'PUT', body: JSON.stringify({ credential, expected_revision: provider.revision }) }),
  clearCredential: (provider: Provider) => request<{ configured: boolean; credential_ref: string | null }>(revisionQuery(`/api/admin/providers/${provider.id}/credential`, provider.revision), { method: 'DELETE' }),
  createModel: (provider: Provider, body: ModelPayload) => request<Model>(`/api/admin/providers/${provider.id}/models`, json(body)),
  updateModel: (model: Model, body: ModelPayload) => request<Model>(`/api/admin/providers/${model.provider_id}/models/${model.id}`, patch({ ...body, expected_revision: model.revision })),
  deleteModel: (model: Model) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/providers/${model.provider_id}/models/${model.id}`, model.revision), { method: 'DELETE' }),
  commands: (repo: string) => request<Command[]>(`/api/admin/repositories/${encodedRepo(repo)}/commands`),
  createCommand: (repo: string, body: CommandPayload) => request<Command>(`/api/admin/repositories/${encodedRepo(repo)}/commands`, json(body)),
  updateCommand: (repo: string, command: Command, body: CommandPayload) => request<Command>(`/api/admin/repositories/${encodedRepo(repo)}/commands/${command.id}`, patch({ ...body, expected_revision: command.revision })),
  deleteCommand: (repo: string, command: Command) => request<{ deleted: boolean }>(revisionQuery(`/api/admin/repositories/${encodedRepo(repo)}/commands/${command.id}`, command.revision), { method: 'DELETE' }),
  effectiveCommand: (repo: string, command: Command) => request<EffectiveConfiguration>(`/api/admin/repositories/${encodedRepo(repo)}/commands/${command.id}/effective`),
  profile: (repo: string) => request<ConversationProfile>(`/api/admin/repositories/${encodedRepo(repo)}/conversation-profile`),
  saveProfile: (repo: string, profile: ConversationProfile, body: ProfilePayload) => request<ConversationProfile>(`/api/admin/repositories/${encodedRepo(repo)}/conversation-profile`, { method: 'PUT', body: JSON.stringify({ ...body, expected_revision: profile.revision }) }),
  effectiveProfile: (repo: string) => request<EffectiveConfiguration>(`/api/admin/repositories/${encodedRepo(repo)}/conversation-profile/effective`),
};

export interface PromptPayload { slug: string; title: string; role?: string | null; content: string; enabled?: boolean }
export interface SkillPayload { slug: string; title: string; description?: string; content: string; enabled?: boolean }
export interface ProviderPayload { type: ProviderType; display_name: string; base_url: string; credential_ref?: string | null; request_options?: Record<string, string | number | boolean>; enabled?: boolean }
export interface ScmConnectionPayload { id?: string; kind: 'gitlab'; instance_url: string; webhook_mode?: 'secret' | 'signing'; bot_user_id?: string | null; bot_login?: string | null; project_ids: string[]; enabled?: boolean }
export interface ModelPayload { model_identifier: string; display_name?: string; enabled?: boolean }
export interface CommandPayload {
  slash_name: string;
  display_name: string;
  description: string;
  execution_type: ExecutionType;
  permission: Permission;
  provider_model_id: string;
  enabled: boolean;
  prompt_bindings: PromptBinding[];
  skill_bindings: SkillBinding[];
}
export interface ProfilePayload {
  display_name: string;
  provider_model_id: string;
  enabled: boolean;
  prompt_bindings: PromptBinding[];
  skill_bindings: SkillBinding[];
}
