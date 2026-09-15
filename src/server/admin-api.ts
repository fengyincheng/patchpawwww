import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ControlPlaneError,
  bootstrapControlPlane,
  copyPublicPrompt,
  copyPublicSkill,
  createCommand,
  createProvider,
  createProviderModel,
  createPrompt,
  createSkill,
  deleteCommand,
  deleteProvider,
  deleteProviderCredential,
  deleteProviderModel,
  deletePrompt,
  deleteRepository,
  deleteSkill,
  getCommand,
  getConversationProfile,
  getPrompt,
  getProvider,
  getProviderModel,
  getRepositoryByName,
  getRepository,
  getSkill,
  listCommands,
  listProviderModels,
  listPrompts,
  listProviders,
  listRepositories,
  listSkills,
  openControlPlaneDb,
  resolveEffectiveConfiguration,
  saveConversationProfile,
  setProviderCredential,
  snapshotSha256,
  updateCommand,
  updateProvider,
  updateProviderModel,
  updatePrompt,
  updateRepository,
  updateSkill,
  type Command,
  type CommandInput,
  type ControlPlaneDb,
  type ConversationProfile,
  type PromptAsset,
  type Provider,
  type ProviderInput,
  type ProviderModel,
  type SkillAsset,
  createScmConnection,
  deleteScmConnection,
  getScmConnection,
  listScmConnections,
  updateScmConnection,
  type ScmConnectionInput,
} from '../control-plane/index.ts';
import { normalizeRepositoryName } from '../control-plane/common.ts';
import type { GitHubReader } from '../github/client.ts';
import { normalizeOrigin } from './public-setup.ts';
import { SecretStore } from '../control-plane/secrets.ts';
import type { ScmConnection } from '../scm/types.ts';
import { GitLabClient } from '../scm/gitlab/client.ts';

const ADMIN_COOKIE = 'patchpaw_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ADMIN_BODY_BYTES = 1024 * 1024;
const MAX_ASSET_CONTENT_BYTES = 512 * 1024;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_ATTEMPTS = 5;

export interface AdminApiConfig {
  root: string;
  adminToken?: string;
  publicOrigin?: string;
  bootstrapEnv?: NodeJS.ProcessEnv;
}

export interface AdminRepositoryDto {
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

export interface AdminScmConnectionDto {
  id: string;
  kind: ScmConnection['kind'];
  instance_url: string;
  credential_ref: string | null;
  credential_configured: boolean;
  webhook_mode: ScmConnection['webhookMode'];
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

export interface AdminPromptDto {
  id: string;
  scope: PromptAsset['scope'];
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

export interface AdminSkillDto {
  id: string;
  scope: SkillAsset['scope'];
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

export interface AdminModelDto {
  id: string;
  provider_id: string;
  model_identifier: string;
  display_name: string;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AdminProviderDto {
  id: string;
  type: Provider['type'];
  display_name: string;
  base_url: string;
  credential_ref: string | null;
  credential_configured: boolean;
  request_options: Record<string, string | number | boolean>;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  models?: AdminModelDto[];
}

export interface AdminCommandDto {
  id: string;
  repository_id: string;
  slash_name: string;
  display_name: string;
  description: string;
  execution_type: Command['executionType'];
  permission: Command['permission'];
  provider_model_id: string;
  enabled: boolean;
  revision: number;
  prompt_bindings: Array<{ asset_id: string; position: number; enabled: boolean; binding_kind: 'main' | 'common' | 'auxiliary' }>;
  skill_bindings: Array<{ asset_id: string; position: number; enabled: boolean }>;
  created_at: string;
  updated_at: string;
}

export interface AdminConversationProfileDto {
  id: string;
  repository_id: string;
  display_name: string;
  provider_model_id: string;
  permission: 'read_only';
  enabled: boolean;
  revision: number;
  prompt_bindings: Array<{ asset_id: string; position: number; enabled: boolean; binding_kind: 'main' | 'common' | 'auxiliary' }>;
  skill_bindings: Array<{ asset_id: string; position: number; enabled: boolean }>;
  created_at: string;
  updated_at: string;
}

export interface AdminEffectivePartDto {
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

export interface AdminEffectiveDto {
  target: 'command' | 'conversation';
  execution_id: string;
  command?: { id: string; slash_name: string; revision: number };
  conversation_profile?: { id: string; revision: number; permission: 'read_only' };
  execution_type: string;
  permission: 'read_only' | 'read_write';
  output_contract: { kind: string; schema_id?: string };
  provider: {
    id: string;
    type: string;
    display_name: string;
    base_url: string;
    revision: number;
    credential_ref: string;
    request_options: Record<string, string | number | boolean>;
  };
  model: AdminModelDto;
  parts: AdminEffectivePartDto[];
  snapshot_id: string;
  snapshot_sha256: string;
}

type AdminErrorCode =
  | 'authentication_required'
  | 'invalid_credentials'
  | 'admin_auth_unavailable'
  | 'csrf_origin'
  | 'rate_limited'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'internal_error'
  | ControlPlaneError['code'];

class AdminApiError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
    readonly status: number,
    readonly field?: string,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface SessionRecord { expiresAt: number }
interface LoginAttemptRecord { startedAt: number; count: number }

const scalarSchema = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);
const requestOptionsSchema = z.record(z.string().max(64), scalarSchema).default({});
const revisionSchema = z.number().int().positive();
const promptBindingSchema = z.object({
  asset_id: z.string().min(1).max(128), position: revisionSchema, enabled: z.boolean(),
  binding_kind: z.enum(['main', 'common', 'auxiliary']),
}).strict();
const skillBindingSchema = z.object({ asset_id: z.string().min(1).max(128), position: revisionSchema, enabled: z.boolean() }).strict();
const promptFields = {
  slug: z.string().min(1).max(64), title: z.string().max(200), role: z.string().max(64).nullable().optional(),
  content: z.string().min(1).max(MAX_ASSET_CONTENT_BYTES), enabled: z.boolean().optional(),
};
const skillFields = {
  slug: z.string().min(1).max(64), title: z.string().max(200), description: z.string().max(1000).optional(),
  content: z.string().min(1).max(MAX_ASSET_CONTENT_BYTES), enabled: z.boolean().optional(),
};
const publicPromptCreateSchema = z.object(promptFields).strict();
const publicPromptPatchSchema = z.object({ ...promptFields, expected_revision: revisionSchema.optional() }).partial().strict();
const publicSkillCreateSchema = z.object(skillFields).strict();
const publicSkillPatchSchema = z.object({ ...skillFields, expected_revision: revisionSchema.optional() }).partial().strict();
const repositoryCreateSchema = z.object({ display_name: z.string().max(200).optional() }).strict();
const copySchema = z.object({ replace: z.boolean().optional(), expected_repository_revision: revisionSchema.optional() }).strict();
const providerCreateSchema = z.object({
  type: z.enum(['zhipu', 'deepseek', 'openrouter', 'kimi', 'qwen']), display_name: z.string().max(200),
  base_url: z.string().min(1).max(2048), credential_ref: z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/).nullable().optional(),
  request_options: requestOptionsSchema.optional(), enabled: z.boolean().optional(),
}).strict();
const providerPatchSchema = providerCreateSchema.partial().extend({ expected_revision: revisionSchema.optional() }).strict();
const modelCreateSchema = z.object({ model_identifier: z.string().min(1).max(512), display_name: z.string().max(200).optional(), enabled: z.boolean().optional() }).strict();
const modelPatchSchema = modelCreateSchema.partial().extend({ expected_revision: revisionSchema.optional() }).strict();
const credentialSchema = z.object({ credential: z.string().min(1).max(16 * 1024), expected_revision: revisionSchema.optional() }).strict();
const commandFields = {
  slash_name: z.string().min(1).max(64), display_name: z.string().max(200), description: z.string().max(2000).optional(),
  execution_type: z.enum(['custom', 'review', 'repair', 'ci', 'conflict']), permission: z.enum(['read_only', 'read_write']),
  provider_model_id: z.string().min(1).max(128), enabled: z.boolean().optional(),
  prompt_bindings: z.array(promptBindingSchema).max(64).optional(), skill_bindings: z.array(skillBindingSchema).max(64).optional(),
};
const commandCreateSchema = z.object(commandFields).strict();
const commandPatchSchema = z.object({ ...commandFields, expected_revision: revisionSchema.optional() }).partial().strict();
const profileFields = {
  display_name: z.string().max(200), provider_model_id: z.string().min(1).max(128), enabled: z.boolean().optional(),
  prompt_bindings: z.array(promptBindingSchema).max(64), skill_bindings: z.array(skillBindingSchema).max(64),
};
const profileSchema = z.object({ ...profileFields, expected_revision: revisionSchema.optional() }).strict();
const loginSchema = z.object({ token: z.string().min(1).max(4096) }).strict();
const scmConnectionFields = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  kind: z.literal('gitlab'), instance_url: z.string().min(1).max(2048),
  credential_ref: z.string().regex(/^(?:env:[A-Z_][A-Z0-9_]*|slot:scm\/[A-Za-z0-9_.:-]+)$/).nullable().optional(),
  webhook_mode: z.enum(['secret', 'signing']).optional(), webhook_secret_ref: z.string().regex(/^(?:env:[A-Z_][A-Z0-9_]*|slot:scm(?:-webhook)?\/[A-Za-z0-9_.:-]+)$/).nullable().optional(),
  bot_user_id: z.string().max(128).nullable().optional(), bot_login: z.string().max(256).nullable().optional(), project_ids: z.array(z.string().min(1).max(256)).max(1000).optional(), enabled: z.boolean().optional(),
};
const scmConnectionCreateSchema = z.object(scmConnectionFields).strict().required({ kind: true, instance_url: true });
const scmConnectionPatchSchema = z.object({ ...scmConnectionFields, expected_revision: revisionSchema.optional() }).partial().strict();
const scmSecretSchema = z.object({ secret: z.string().min(1).max(64 * 1024) }).strict();

function requestId() { return randomUUID(); }

function sendError(reply: FastifyReply, error: unknown, id: string) {
  let status = 500;
  let code: AdminErrorCode = 'internal_error';
  let message = 'Internal server error.';
  let field: string | undefined;
  let details: Record<string, string | number | boolean | null> | undefined;
  if (error instanceof AdminApiError) ({ status, code, message, field, details } = error);
  else if (error instanceof ControlPlaneError) {
    code = error.code;
    message = error.message;
    field = error.field;
    details = error.details;
    if (['not_found'].includes(error.code)) status = 404;
    else if (['revision_conflict', 'referenced_resource', 'required_binding', 'slug_conflict', 'binding_conflict'].includes(error.code)) status = 409;
    else if (['unsupported_migration'].includes(error.code)) status = 500;
    else status = 422;
  }
  return reply.code(status).header('x-request-id', id).send({
    error: { code, message, ...(field ? { field } : {}), ...(details ? { details } : {}) }, request_id: id,
  });
}

function success(reply: FastifyReply, data: unknown, id: string, status = 200) {
  return reply.code(status).header('x-request-id', id).send({ data });
}

function safeTokenEqual(left: string, right: string) {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function cookieValue(request: FastifyRequest, name: string) {
  const cookies = header(request, 'cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    const value = cookie.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return undefined; }
  }
  return undefined;
}

function cookieHeader(value: string, secure: boolean, maxAge: number) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/api/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function jsonBody(request: FastifyRequest) {
  if (request.body === undefined || request.body === null) return {};
  if (Buffer.isBuffer(request.body)) {
    if (request.body.byteLength > MAX_ADMIN_BODY_BYTES) throw new AdminApiError('payload_too_large', 'Request payload is too large.', 413);
    if (request.body.byteLength === 0) return {};
    try { return JSON.parse(request.body.toString('utf8')) as unknown; }
    catch { throw new AdminApiError('invalid_payload', 'Request body must be valid JSON.', 422); }
  }
  const serialized = JSON.stringify(request.body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ADMIN_BODY_BYTES) throw new AdminApiError('payload_too_large', 'Request payload is too large.', 413);
  return request.body;
}

function parseBody<T>(request: FastifyRequest, schema: z.ZodType<T>) {
  const result = schema.safeParse(jsonBody(request));
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.length ? issue.path.join('.') : undefined;
    throw new AdminApiError('invalid_payload', 'Request payload is invalid.', 422, field, { issue_count: result.error.issues.length });
  }
  return result.data;
}

function queryValue(request: FastifyRequest, key: string) {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[key];
  return typeof value === 'string' ? value : undefined;
}

function expectedRevision(request: FastifyRequest, body?: { expected_revision?: number }) {
  const fromBody = body?.expected_revision;
  const rawQuery = queryValue(request, 'expected_revision');
  const fromQuery = rawQuery === undefined ? undefined : Number(rawQuery);
  if (fromQuery !== undefined && (!Number.isSafeInteger(fromQuery) || fromQuery < 1)) {
    throw new AdminApiError('invalid_payload', 'expected_revision must be a positive integer.', 422, 'expected_revision');
  }
  if (fromBody !== undefined && fromQuery !== undefined && fromBody !== fromQuery) {
    throw new AdminApiError('invalid_payload', 'expected_revision was provided twice with different values.', 422, 'expected_revision');
  }
  return fromBody ?? fromQuery;
}

function repoKey(request: FastifyRequest) {
  const raw = String((request.params as Record<string, unknown>).repo ?? '');
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new AdminApiError('invalid_payload', 'Repository key is not safely encoded.', 422, 'repo'); }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) return decoded;
  if (/^gitlab:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}:project:[^/]+$/.test(decoded)) {
    throw new AdminApiError('invalid_payload', 'GitLab repositories must be addressed by control-plane repository UUID.', 422, 'repo');
  }
  try { return normalizeRepositoryName(decoded); } catch { throw new AdminApiError('invalid_payload', 'Repository key must be an encoded owner/repository pair or a GitLab storage key.', 422, 'repo'); }
}

async function repositoryFor(db: ControlPlaneDb, request: FastifyRequest) {
  const key = repoKey(request);
  const repository = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    ? await getRepository(db, key) : await getRepositoryByName(db, key);
  if (!repository) throw new ControlPlaneError('not_found', 'Repository was not found.', 'repo');
  return repository;
}

async function promptSourceStatus(db: ControlPlaneDb, asset: PromptAsset) {
  if (!asset.sourcePublicId) return null;
  const source = await getPrompt(db, asset.sourcePublicId);
  return source?.scope === 'public' && source.repositoryId === null ? 'active' as const : 'deleted' as const;
}

async function skillSourceStatus(db: ControlPlaneDb, asset: SkillAsset) {
  if (!asset.sourcePublicId) return null;
  const source = await getSkill(db, asset.sourcePublicId);
  return source?.scope === 'public' && source.repositoryId === null ? 'active' as const : 'deleted' as const;
}

async function promptDto(db: ControlPlaneDb, asset: PromptAsset): Promise<AdminPromptDto> {
  return { id: asset.id, scope: asset.scope, repository_id: asset.repositoryId, slug: asset.slug, title: asset.title, role: asset.role,
    content: asset.content, enabled: asset.enabled, revision: asset.revision, source_public_id: asset.sourcePublicId,
    source_public_revision: asset.sourcePublicRevision, source_status: await promptSourceStatus(db, asset), created_at: asset.createdAt, updated_at: asset.updatedAt };
}

async function skillDto(db: ControlPlaneDb, asset: SkillAsset): Promise<AdminSkillDto> {
  return { id: asset.id, scope: asset.scope, repository_id: asset.repositoryId, slug: asset.slug, title: asset.title, description: asset.description,
    content: asset.content, enabled: asset.enabled, revision: asset.revision, source_public_id: asset.sourcePublicId,
    source_public_revision: asset.sourcePublicRevision, source_status: await skillSourceStatus(db, asset), created_at: asset.createdAt, updated_at: asset.updatedAt };
}

function modelDto(model: ProviderModel): AdminModelDto {
  return { id: model.id, provider_id: model.providerId, model_identifier: model.modelIdentifier, display_name: model.displayName,
    enabled: model.enabled, revision: model.revision, created_at: model.createdAt, updated_at: model.updatedAt };
}

function commandDto(command: Command): AdminCommandDto {
  return { id: command.id, repository_id: command.repositoryId, slash_name: command.slashName, display_name: command.displayName,
    description: command.description, execution_type: command.executionType, permission: command.permission, provider_model_id: command.providerModelId,
    enabled: command.enabled, revision: command.revision, prompt_bindings: command.promptBindings.map(binding => ({ asset_id: binding.assetId,
      position: binding.position, enabled: binding.enabled, binding_kind: binding.bindingKind })), skill_bindings: command.skillBindings.map(binding => ({
      asset_id: binding.assetId, position: binding.position, enabled: binding.enabled })), created_at: command.createdAt, updated_at: command.updatedAt };
}

function profileDto(profile: ConversationProfile): AdminConversationProfileDto {
  return { id: profile.id, repository_id: profile.repositoryId, display_name: profile.displayName, provider_model_id: profile.providerModelId,
    permission: 'read_only', enabled: profile.enabled, revision: profile.revision, prompt_bindings: profile.promptBindings.map(binding => ({ asset_id: binding.assetId,
      position: binding.position, enabled: binding.enabled, binding_kind: binding.bindingKind })), skill_bindings: profile.skillBindings.map(binding => ({ asset_id: binding.assetId,
      position: binding.position, enabled: binding.enabled })), created_at: profile.createdAt, updated_at: profile.updatedAt };
}

function repositoryDto(repository: { id: string; fullNameNormalized: string; displayName: string; revision: number; createdAt: string; updatedAt: string; scmKind?: 'github' | 'gitlab'; connectionId?: string | null; remoteProjectId?: string | null; pathWithNamespace?: string | null; webUrl?: string | null; cloneUrl?: string | null; storageKey?: string }): AdminRepositoryDto {
  return { id: repository.id, full_name: repository.scmKind === 'gitlab' ? repository.storageKey ?? repository.fullNameNormalized : repository.fullNameNormalized, display_name: repository.displayName, revision: repository.revision,
    ...(repository.scmKind ? { scm_kind: repository.scmKind, connection_id: repository.connectionId ?? null, remote_project_id: repository.remoteProjectId ?? null,
      path_with_namespace: repository.pathWithNamespace ?? null, web_url: repository.webUrl ?? null, clone_url: repository.cloneUrl ?? null, storage_key: repository.storageKey } : {}),
    created_at: repository.createdAt, updated_at: repository.updatedAt };
}

async function scmConnectionDto(connection: ScmConnection, root: string): Promise<AdminScmConnectionDto> {
  const secrets = new SecretStore(root);
  return { id: connection.id, kind: connection.kind, instance_url: connection.instanceUrl, credential_ref: connection.credentialRef,
    credential_configured: await secrets.isConfigured(connection.credentialRef), webhook_mode: connection.webhookMode, webhook_secret_ref: connection.webhookSecretRef,
    webhook_secret_configured: await secrets.isConfigured(connection.webhookSecretRef), bot_user_id: connection.botUserId, bot_login: connection.botLogin, project_ids: connection.projectIds,
    enabled: connection.enabled, revision: connection.revision ?? 1, created_at: connection.createdAt, updated_at: connection.updatedAt };
}

const SAFE_REQUEST_OPTIONS = new Set([
  'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'seed',
  'reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget', 'http_referer', 'x_openrouter_title', 'stream',
]);

function safeRequestOptions(options: Record<string, string | number | boolean>) {
  return Object.fromEntries(Object.entries(options).filter(([key]) => SAFE_REQUEST_OPTIONS.has(key)));
}

async function providerDto(provider: Provider, root: string, models?: ProviderModel[]): Promise<AdminProviderDto> {
  const { SecretStore } = await import('../control-plane/secrets.ts');
  const credentialConfigured = await new SecretStore(root).isConfigured(provider.credentialRef);
  return { id: provider.id, type: provider.type, display_name: provider.displayName, base_url: provider.baseUrl, credential_ref: provider.credentialRef,
    credential_configured: credentialConfigured, request_options: safeRequestOptions(provider.requestOptions), enabled: provider.enabled, revision: provider.revision,
    created_at: provider.createdAt, updated_at: provider.updatedAt, ...(models ? { models: models.map(modelDto) } : {}) };
}

async function effectiveDto(db: ControlPlaneDb, resolved: Awaited<ReturnType<typeof resolveEffectiveConfiguration>>): Promise<AdminEffectiveDto> {
  const assets = new Map<string, PromptAsset | SkillAsset>();
  for (const asset of resolved.prompts) assets.set(asset.id, asset);
  for (const asset of resolved.skills) assets.set(asset.id, asset);
  const parts = await Promise.all(resolved.snapshot.composition.parts.map(async part => {
    const asset = assets.get(part.asset_id);
    if (!asset) throw new AdminApiError('internal_error', 'Effective configuration contains a missing asset.', 500);
    const sourceStatus = part.kind === 'prompt' ? await promptSourceStatus(db, asset as PromptAsset) : await skillSourceStatus(db, asset as SkillAsset);
    return { kind: part.kind, position: part.position, asset_id: part.asset_id, slug: part.slug, role: part.role,
      scope: 'repository' as const, revision: part.revision, sha256: part.sha256, content: part.content,
      source_public_id: asset.sourcePublicId, source_public_revision: asset.sourcePublicRevision, source_status: sourceStatus };
  }));
  return { target: resolved.target, execution_id: resolved.executionId, ...(resolved.command ? { command: { id: resolved.command.id, slash_name: resolved.command.slashName, revision: resolved.command.revision } } : {}),
    ...(resolved.conversationProfile ? { conversation_profile: { id: resolved.conversationProfile.id, revision: resolved.conversationProfile.revision, permission: 'read_only' as const } } : {}),
    execution_type: resolved.executionType, permission: resolved.permission, output_contract: resolved.outputContract,
    provider: { id: resolved.provider.id, type: resolved.provider.type, display_name: resolved.provider.displayName, base_url: resolved.provider.baseUrl,
      revision: resolved.provider.revision, credential_ref: resolved.provider.credentialRef ?? '', request_options: safeRequestOptions(resolved.provider.requestOptions) },
    model: modelDto(resolved.model), parts, snapshot_id: resolved.snapshot.snapshot_id, snapshot_sha256: snapshotSha256(resolved.snapshot) };
}

function asPromptBindings(bindings: Array<{ asset_id: string; position: number; enabled: boolean; binding_kind: 'main' | 'common' | 'auxiliary' }> | undefined) {
  return bindings?.map(binding => ({ assetId: binding.asset_id, position: binding.position, enabled: binding.enabled, bindingKind: binding.binding_kind }));
}

function asSkillBindings(bindings: Array<{ asset_id: string; position: number; enabled: boolean }> | undefined) {
  return bindings?.map(binding => ({ assetId: binding.asset_id, position: binding.position, enabled: binding.enabled }));
}

function withRoute(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const id = requestId();
    try { return success(reply, await handler(request, reply), id); }
    catch (error) { return sendError(reply, error, id); }
  };
}

export function registerAdminApi(app: FastifyInstance, config: AdminApiConfig, _github?: GitHubReader) {
  const sessions = new Map<string, SessionRecord>();
  const loginAttempts = new Map<string, LoginAttemptRecord>();
  let dbPromise: Promise<ControlPlaneDb> | undefined;
  const db = () => dbPromise ??= openControlPlaneDb(config.root);
  const publicOrigin = normalizeOrigin(config.publicOrigin);
  const secureCookie = publicOrigin?.startsWith('https://') ?? false;

  const authenticate = (request: FastifyRequest) => {
    const token = cookieValue(request, ADMIN_COOKIE);
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) return undefined;
    const record = sessions.get(token);
    if (!record || record.expiresAt <= Date.now()) { sessions.delete(token); return undefined; }
    return { token, expiresAt: record.expiresAt };
  };

  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authenticate(request)) {
      sendError(reply, new AdminApiError('authentication_required', 'Admin session is required.', 401), requestId());
      return false;
    }
    return true;
  };

  const requireOrigin = (request: FastifyRequest) => {
    const origin = normalizeOrigin(header(request, 'origin'));
    if (!publicOrigin || !origin || origin !== publicOrigin) throw new AdminApiError('csrf_origin', 'Write requests require the configured same-origin Origin.', 403, 'origin');
  };

  const guarded = (write = false) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await requireSession(request, reply))) return;
    if (write) {
      try { requireOrigin(request); }
      catch (error) { sendError(reply, error, requestId()); return false; }
    }
    return true;
  };

  app.addHook('onClose', async () => {
    if (dbPromise) await dbPromise.then(value => value.close()).catch(() => undefined);
    sessions.clear();
  });

  app.post('/api/admin/auth/login', withRoute(async (request, reply) => {
    requireOrigin(request);
    const body = parseBody(request, loginSchema);
    const now = Date.now();
    const ip = request.ip || 'unknown';
    const attempts = loginAttempts.get(ip);
    if (attempts && attempts.startedAt + LOGIN_WINDOW_MS > now && attempts.count >= LOGIN_ATTEMPTS) {
      reply.header('retry-after', String(Math.ceil((attempts.startedAt + LOGIN_WINDOW_MS - now) / 1000)));
      throw new AdminApiError('rate_limited', 'Too many login attempts; try again later.', 429);
    }
    if (!config.adminToken) throw new AdminApiError('admin_auth_unavailable', 'Admin authentication is not configured.', 503);
    const valid = safeTokenEqual(body.token, config.adminToken);
    if (!valid) {
      const next = !attempts || attempts.startedAt + LOGIN_WINDOW_MS <= now ? { startedAt: now, count: 1 } : { ...attempts, count: attempts.count + 1 };
      loginAttempts.set(ip, next);
      throw new AdminApiError('invalid_credentials', 'Invalid admin credentials.', 401);
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;
    sessions.set(token, { expiresAt });
    reply.header('set-cookie', cookieHeader(token, secureCookie, SESSION_TTL_MS / 1000));
    return { authenticated: true, expires_at: new Date(expiresAt).toISOString() };
  }));

  app.post('/api/admin/auth/logout', withRoute(async (request, reply) => {
    requireOrigin(request);
    const token = cookieValue(request, ADMIN_COOKIE);
    if (token) sessions.delete(token);
    reply.header('set-cookie', cookieHeader('', secureCookie, 0));
    return { authenticated: false };
  }));

  app.get('/api/admin/auth/session', { preHandler: guarded() }, withRoute(async request => {
    const session = authenticate(request);
    if (!session) throw new AdminApiError('authentication_required', 'Admin session is required.', 401);
    return { authenticated: true, expires_at: new Date(session.expiresAt).toISOString() };
  }));

  app.get('/api/admin/prompts/public', { preHandler: guarded() }, withRoute(async () => {
    const store = await db();
    return Promise.all((await listPrompts(store, { scope: 'public' })).map(asset => promptDto(store, asset)));
  }));
  app.post('/api/admin/prompts/public', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, publicPromptCreateSchema);
    const store = await db();
    return promptDto(store, await createPrompt(store, { ...body, scope: 'public', repositoryId: null }));
  }));
  app.get('/api/admin/prompts/public/:id', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const asset = await getPrompt(store, String((request.params as Record<string, string>).id));
    if (!asset || asset.scope !== 'public') throw new ControlPlaneError('not_found', 'Public prompt asset was not found.', 'id');
    return promptDto(store, asset);
  }));
  app.patch('/api/admin/prompts/public/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const store = await db();
    const existing = await getPrompt(store, id);
    if (!existing || existing.scope !== 'public') throw new ControlPlaneError('not_found', 'Public prompt asset was not found.', 'id');
    const body = parseBody(request, publicPromptPatchSchema);
    const { expected_revision, ...patch } = body;
    return promptDto(store, await updatePrompt(store, id, patch, { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/prompts/public/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const existing = await getPrompt(await db(), id);
    if (!existing || existing.scope !== 'public') throw new ControlPlaneError('not_found', 'Public prompt asset was not found.', 'id');
    await deletePrompt(await db(), id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id };
  }));

  app.get('/api/admin/skills/public', { preHandler: guarded() }, withRoute(async () => {
    const store = await db();
    return Promise.all((await listSkills(store, { scope: 'public' })).map(asset => skillDto(store, asset)));
  }));
  app.post('/api/admin/skills/public', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, publicSkillCreateSchema);
    const store = await db();
    return skillDto(store, await createSkill(store, { ...body, scope: 'public', repositoryId: null }));
  }));
  app.get('/api/admin/skills/public/:id', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const asset = await getSkill(store, String((request.params as Record<string, string>).id));
    if (!asset || asset.scope !== 'public') throw new ControlPlaneError('not_found', 'Public skill asset was not found.', 'id');
    return skillDto(store, asset);
  }));
  app.patch('/api/admin/skills/public/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const store = await db();
    const existing = await getSkill(store, id);
    if (!existing || existing.scope !== 'public') throw new ControlPlaneError('not_found', 'Public skill asset was not found.', 'id');
    const body = parseBody(request, publicSkillPatchSchema);
    const { expected_revision, ...patch } = body;
    return skillDto(store, await updateSkill(store, id, patch, { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/skills/public/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const existing = await getSkill(await db(), id);
    if (!existing || existing.scope !== 'public') throw new ControlPlaneError('not_found', 'Public skill asset was not found.', 'id');
    await deleteSkill(await db(), id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id };
  }));

  app.get('/api/admin/repositories', { preHandler: guarded() }, withRoute(async () => {
    return (await listRepositories(await db())).map(repositoryDto);
  }));
  app.get('/api/admin/scm-connections', { preHandler: guarded() }, withRoute(async () => {
    const store = await db(); return Promise.all((await listScmConnections(store)).map(value => scmConnectionDto(value, config.root)));
  }));
  app.post('/api/admin/scm-connections', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, scmConnectionCreateSchema);
    const connection = await createScmConnection(await db(), { id: body.id, kind: body.kind, instanceUrl: body.instance_url, credentialRef: body.credential_ref,
      webhookMode: body.webhook_mode, webhookSecretRef: body.webhook_secret_ref, botUserId: body.bot_user_id, botLogin: body.bot_login, projectIds: body.project_ids, enabled: body.enabled });
    return scmConnectionDto(connection, config.root);
  }));
  app.get('/api/admin/scm-connections/:id', { preHandler: guarded() }, withRoute(async request => {
    const connection = await getScmConnection(await db(), String((request.params as Record<string, string>).id));
    if (!connection) throw new ControlPlaneError('not_found', 'SCM connection was not found.', 'id');
    return scmConnectionDto(connection, config.root);
  }));
  app.patch('/api/admin/scm-connections/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, scmConnectionPatchSchema); const id = String((request.params as Record<string, string>).id);
    const connection = await updateScmConnection(await db(), id, { kind: body.kind, instanceUrl: body.instance_url, credentialRef: body.credential_ref, webhookMode: body.webhook_mode,
      webhookSecretRef: body.webhook_secret_ref, botUserId: body.bot_user_id, botLogin: body.bot_login, projectIds: body.project_ids, enabled: body.enabled }, { expectedRevision: body.expected_revision });
    return scmConnectionDto(connection, config.root);
  }));
  app.delete('/api/admin/scm-connections/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id); const connection = await getScmConnection(await db(), id);
    if (!connection) throw new ControlPlaneError('not_found', 'SCM connection was not found.', 'id');
    await deleteScmConnection(await db(), id);
    const secrets = new SecretStore(config.root);
    if (connection.credentialRef === secrets.scmSlotRef(id)) await secrets.deleteScmSecret(id);
    if (connection.webhookSecretRef === secrets.scmWebhookSlotRef(id)) await secrets.deleteScmWebhookSecret(id);
    return { deleted: true, id };
  }));
  app.put('/api/admin/scm-connections/:id/credential', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, scmSecretSchema); const id = String((request.params as Record<string, string>).id); const connection = await getScmConnection(await db(), id);
    if (!connection) throw new ControlPlaneError('not_found', 'SCM connection was not found.', 'id');
    const ref = await new SecretStore(config.root).writeScmSecret(id, body.secret);
    const updated = await updateScmConnection(await db(), id, { credentialRef: ref }, { expectedRevision: connection.revision });
    return scmConnectionDto(updated, config.root);
  }));
  app.put('/api/admin/scm-connections/:id/webhook-secret', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, scmSecretSchema); const id = String((request.params as Record<string, string>).id); const connection = await getScmConnection(await db(), id);
    if (!connection) throw new ControlPlaneError('not_found', 'SCM connection was not found.', 'id');
    const ref = await new SecretStore(config.root).writeScmWebhookSecret(id, body.secret);
    const updated = await updateScmConnection(await db(), id, { webhookSecretRef: ref }, { expectedRevision: connection.revision });
    return scmConnectionDto(updated, config.root);
  }));
  app.post('/api/admin/scm-connections/:id/verify', { preHandler: guarded(true) }, withRoute(async request => {
    const connection = await getScmConnection(await db(), String((request.params as Record<string, string>).id));
    if (!connection) throw new ControlPlaneError('not_found', 'SCM connection was not found.', 'id');
    if (connection.kind !== 'gitlab' || !connection.credentialRef) return { status: 'unsupported', connection: await scmConnectionDto(connection, config.root) };
    const token = await new SecretStore(config.root).read(connection.credentialRef); const client = new GitLabClient({ baseUrl: connection.instanceUrl, token });
    const { data: user } = await client.user(); const projects = [];
    for (const projectId of connection.projectIds) { const { data: project } = await client.project(projectId); projects.push({ id: String(project.id), path_with_namespace: project.path_with_namespace, visible: true }); }
    return { status: 'ok', bot: { id: String(user.id), login: String(user.username ?? user.name ?? '') }, projects };
  }));
  app.get('/api/admin/repositories/by-id/:id', { preHandler: guarded() }, withRoute(async request => {
    const repository = await getRepository(await db(), String((request.params as Record<string, string>).id));
    if (!repository) throw new ControlPlaneError('not_found', 'Repository was not found.', 'id'); return repositoryDto(repository);
  }));
  app.get('/api/admin/repositories/:repo', { preHandler: guarded() }, withRoute(async request => {
    return repositoryDto(await repositoryFor(await db(), request));
  }));
  app.post('/api/admin/repositories/:repo/bootstrap', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, repositoryCreateSchema);
    const fullName = repoKey(request);
    const report = await bootstrapControlPlane({ root: config.root, env: config.bootstrapEnv, repositories: [{ fullName, displayName: body.display_name }] });
    const result = report.repositories.find(repository => repository.fullNameNormalized === fullName);
    if (!result) throw new AdminApiError('internal_error', 'Bootstrap did not return the requested repository.', 500);
    return { repository: repositoryDto(result), bootstrap_version: report.bootstrapVersion, migration_version: report.migrationVersion,
      repository_result: report.repositoryResults.find(value => value.repository.id === result.id) ?? null };
  }));
  app.patch('/api/admin/repositories/:repo', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, z.object({ display_name: z.string().max(200), expected_revision: revisionSchema.optional() }).strict());
    const repository = await repositoryFor(await db(), request);
    return repositoryDto(await updateRepository(await db(), repository.id, { displayName: body.display_name }, { expectedRevision: expectedRevision(request, body) }));
  }));
  app.delete('/api/admin/repositories/:repo', { preHandler: guarded(true) }, withRoute(async request => {
    const repository = await repositoryFor(await db(), request);
    await deleteRepository(await db(), repository.id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id: repository.id };
  }));

  async function repositoryPrompt(request: FastifyRequest) {
    const repository = await repositoryFor(await db(), request);
    const id = String((request.params as Record<string, string>).id);
    const asset = await getPrompt(await db(), id);
    if (!asset || asset.scope !== 'repository' || asset.repositoryId !== repository.id) throw new ControlPlaneError('not_found', 'Repository prompt asset was not found.', 'id');
    return { repository, asset };
  }
  app.get('/api/admin/repositories/:repo/prompts', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    return Promise.all((await listPrompts(store, { scope: 'repository', repositoryId: repository.id })).map(asset => promptDto(store, asset)));
  }));
  app.post('/api/admin/repositories/:repo/prompts', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, publicPromptCreateSchema);
    const store = await db();
    const repository = await repositoryFor(store, request);
    return promptDto(store, await createPrompt(store, { ...body, scope: 'repository', repositoryId: repository.id }));
  }));
  app.get('/api/admin/repositories/:repo/prompts/:id', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    return promptDto(store, (await repositoryPrompt(request)).asset);
  }));
  app.patch('/api/admin/repositories/:repo/prompts/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { asset } = await repositoryPrompt(request);
    const store = await db();
    const body = parseBody(request, publicPromptPatchSchema);
    const { expected_revision, ...patch } = body;
    return promptDto(store, await updatePrompt(store, asset.id, patch, { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/repositories/:repo/prompts/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { asset } = await repositoryPrompt(request);
    await deletePrompt(await db(), asset.id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id: asset.id };
  }));
  app.post('/api/admin/repositories/:repo/prompts/copy-public/:publicId', { preHandler: guarded(true) }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    const body = parseBody(request, copySchema);
    return promptDto(store, await copyPublicPrompt(store, repository.id, String((request.params as Record<string, string>).publicId), {
      replace: body.replace, expectedRepositoryRevision: body.expected_repository_revision,
    }));
  }));

  async function repositorySkill(request: FastifyRequest) {
    const repository = await repositoryFor(await db(), request);
    const id = String((request.params as Record<string, string>).id);
    const asset = await getSkill(await db(), id);
    if (!asset || asset.scope !== 'repository' || asset.repositoryId !== repository.id) throw new ControlPlaneError('not_found', 'Repository skill asset was not found.', 'id');
    return { repository, asset };
  }
  app.get('/api/admin/repositories/:repo/skills', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    return Promise.all((await listSkills(store, { scope: 'repository', repositoryId: repository.id })).map(asset => skillDto(store, asset)));
  }));
  app.post('/api/admin/repositories/:repo/skills', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, publicSkillCreateSchema);
    const store = await db();
    const repository = await repositoryFor(store, request);
    return skillDto(store, await createSkill(store, { ...body, scope: 'repository', repositoryId: repository.id }));
  }));
  app.get('/api/admin/repositories/:repo/skills/:id', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    return skillDto(store, (await repositorySkill(request)).asset);
  }));
  app.patch('/api/admin/repositories/:repo/skills/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { asset } = await repositorySkill(request);
    const store = await db();
    const body = parseBody(request, publicSkillPatchSchema);
    const { expected_revision, ...patch } = body;
    return skillDto(store, await updateSkill(store, asset.id, patch, { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/repositories/:repo/skills/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { asset } = await repositorySkill(request);
    await deleteSkill(await db(), asset.id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id: asset.id };
  }));
  app.post('/api/admin/repositories/:repo/skills/copy-public/:publicId', { preHandler: guarded(true) }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    const body = parseBody(request, copySchema);
    return skillDto(store, await copyPublicSkill(store, repository.id, String((request.params as Record<string, string>).publicId), {
      replace: body.replace, expectedRepositoryRevision: body.expected_repository_revision,
    }));
  }));

  app.get('/api/admin/providers', { preHandler: guarded() }, withRoute(async () => {
    const store = await db();
    const providers = await listProviders(store);
    return Promise.all(providers.map(async provider => providerDto(provider, config.root, await listProviderModels(store, provider.id))));
  }));
  app.post('/api/admin/providers', { preHandler: guarded(true) }, withRoute(async request => {
    const body = parseBody(request, providerCreateSchema);
    const input: ProviderInput = { type: body.type, displayName: body.display_name, baseUrl: body.base_url, credentialRef: body.credential_ref,
      requestOptions: body.request_options, enabled: body.enabled };
    return providerDto(await createProvider(await db(), input), config.root);
  }));
  app.get('/api/admin/providers/:id', { preHandler: guarded() }, withRoute(async request => {
    const provider = await getProvider(await db(), String((request.params as Record<string, string>).id));
    if (!provider) throw new ControlPlaneError('not_found', 'Provider was not found.', 'id');
    return providerDto(provider, config.root, await listProviderModels(await db(), provider.id));
  }));
  app.patch('/api/admin/providers/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const body = parseBody(request, providerPatchSchema);
    const { expected_revision, ...patch } = body;
    const providerPatch: Partial<Pick<ProviderInput, 'type' | 'displayName' | 'baseUrl' | 'credentialRef' | 'requestOptions' | 'enabled'>> = { ...(patch.type ? { type: patch.type } : {}), ...(patch.display_name !== undefined ? { displayName: patch.display_name } : {}),
      ...(patch.base_url !== undefined ? { baseUrl: patch.base_url } : {}), ...(patch.credential_ref !== undefined ? { credentialRef: patch.credential_ref } : {}),
      ...(patch.request_options !== undefined ? { requestOptions: patch.request_options } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) };
    return providerDto(await updateProvider(await db(), id, providerPatch, { expectedRevision: expectedRevision(request, { expected_revision }) }), config.root);
  }));
  app.delete('/api/admin/providers/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    await deleteProvider(await db(), id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id };
  }));
  app.put('/api/admin/providers/:id/credential', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const body = parseBody(request, credentialSchema);
    const provider = await setProviderCredential(await db(), config.root, id, body.credential, { expectedRevision: body.expected_revision });
    return { configured: true, credential_ref: provider.credentialRef };
  }));
  app.delete('/api/admin/providers/:id/credential', { preHandler: guarded(true) }, withRoute(async request => {
    const id = String((request.params as Record<string, string>).id);
    const provider = await deleteProviderCredential(await db(), config.root, id, { expectedRevision: expectedRevision(request) });
    return { configured: false, credential_ref: provider.credentialRef };
  }));

  async function providerModel(request: FastifyRequest) {
    const provider = await getProvider(await db(), String((request.params as Record<string, string>).id));
    if (!provider) throw new ControlPlaneError('not_found', 'Provider was not found.', 'id');
    const modelId = String((request.params as Record<string, string>).modelId);
    const model = await getProviderModel(await db(), modelId);
    if (!model || model.providerId !== provider.id) throw new ControlPlaneError('not_found', 'Provider model was not found.', 'model_id');
    return { provider, model };
  }
  app.get('/api/admin/providers/:id/models', { preHandler: guarded() }, withRoute(async request => {
    const provider = await getProvider(await db(), String((request.params as Record<string, string>).id));
    if (!provider) throw new ControlPlaneError('not_found', 'Provider was not found.', 'id');
    return (await listProviderModels(await db(), provider.id)).map(modelDto);
  }));
  app.post('/api/admin/providers/:id/models', { preHandler: guarded(true) }, withRoute(async request => {
    const providerId = String((request.params as Record<string, string>).id);
    const body = parseBody(request, modelCreateSchema);
    return modelDto(await createProviderModel(await db(), { providerId, modelIdentifier: body.model_identifier, displayName: body.display_name, enabled: body.enabled }));
  }));
  app.get('/api/admin/providers/:id/models/:modelId', { preHandler: guarded() }, withRoute(async request => modelDto((await providerModel(request)).model)));
  app.patch('/api/admin/providers/:id/models/:modelId', { preHandler: guarded(true) }, withRoute(async request => {
    const { model } = await providerModel(request);
    const body = parseBody(request, modelPatchSchema);
    const { expected_revision, ...patch } = body;
    return modelDto(await updateProviderModel(await db(), model.id, { ...(patch.model_identifier !== undefined ? { modelIdentifier: patch.model_identifier } : {}),
      ...(patch.display_name !== undefined ? { displayName: patch.display_name } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) },
      { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/providers/:id/models/:modelId', { preHandler: guarded(true) }, withRoute(async request => {
    const { model } = await providerModel(request);
    await deleteProviderModel(await db(), model.id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id: model.id };
  }));

  async function repositoryCommand(request: FastifyRequest) {
    const repository = await repositoryFor(await db(), request);
    const id = String((request.params as Record<string, string>).id);
    const command = await getCommand(await db(), id);
    if (!command || command.repositoryId !== repository.id) throw new ControlPlaneError('not_found', 'Command was not found.', 'id');
    return { repository, command };
  }
  app.get('/api/admin/repositories/:repo/commands', { preHandler: guarded() }, withRoute(async request => {
    const repository = await repositoryFor(await db(), request);
    return (await listCommands(await db(), repository.id)).map(commandDto);
  }));
  app.post('/api/admin/repositories/:repo/commands', { preHandler: guarded(true) }, withRoute(async request => {
    const repository = await repositoryFor(await db(), request);
    const body = parseBody(request, commandCreateSchema);
    return commandDto(await createCommand(await db(), { repositoryId: repository.id, slashName: body.slash_name, displayName: body.display_name,
      description: body.description, executionType: body.execution_type, permission: body.permission, providerModelId: body.provider_model_id, enabled: body.enabled,
      promptBindings: asPromptBindings(body.prompt_bindings), skillBindings: asSkillBindings(body.skill_bindings) }));
  }));
  app.get('/api/admin/repositories/:repo/commands/:id', { preHandler: guarded() }, withRoute(async request => commandDto((await repositoryCommand(request)).command)));
  app.patch('/api/admin/repositories/:repo/commands/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { command } = await repositoryCommand(request);
    const body = parseBody(request, commandPatchSchema);
    const { expected_revision, ...patch } = body;
    const commandPatch: Partial<Omit<CommandInput, 'repositoryId'>> = { ...(patch.slash_name !== undefined ? { slashName: patch.slash_name } : {}),
      ...(patch.display_name !== undefined ? { displayName: patch.display_name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.execution_type !== undefined ? { executionType: patch.execution_type } : {}), ...(patch.permission !== undefined ? { permission: patch.permission } : {}),
      ...(patch.provider_model_id !== undefined ? { providerModelId: patch.provider_model_id } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.prompt_bindings !== undefined ? { promptBindings: asPromptBindings(patch.prompt_bindings) } : {}), ...(patch.skill_bindings !== undefined ? { skillBindings: asSkillBindings(patch.skill_bindings) } : {}) };
    return commandDto(await updateCommand(await db(), command.id, commandPatch, { expectedRevision: expectedRevision(request, { expected_revision }) }));
  }));
  app.delete('/api/admin/repositories/:repo/commands/:id', { preHandler: guarded(true) }, withRoute(async request => {
    const { command } = await repositoryCommand(request);
    await deleteCommand(await db(), command.id, { expectedRevision: expectedRevision(request) });
    return { deleted: true, id: command.id };
  }));
  app.get('/api/admin/repositories/:repo/commands/:id/effective', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    const command = await getCommand(store, String((request.params as Record<string, string>).id));
    if (!command || command.repositoryId !== repository.id) throw new ControlPlaneError('not_found', 'Command was not found.', 'id');
    return effectiveDto(store, await resolveEffectiveConfiguration(store, { kind: 'command', repositoryId: repository.id, commandId: command.id, executionId: `admin-${randomUUID()}` }));
  }));

  async function conversationProfile(request: FastifyRequest) {
    const repository = await repositoryFor(await db(), request);
    const profile = await getConversationProfile(await db(), repository.id);
    if (!profile) throw new ControlPlaneError('not_found', 'Conversation Profile was not found.', 'conversation_profile');
    return { repository, profile };
  }
  app.get('/api/admin/repositories/:repo/conversation-profile', { preHandler: guarded() }, withRoute(async request => profileDto((await conversationProfile(request)).profile)));
  app.put('/api/admin/repositories/:repo/conversation-profile', { preHandler: guarded(true) }, withRoute(async request => {
    const repository = await repositoryFor(await db(), request);
    const body = parseBody(request, profileSchema);
    return profileDto(await saveConversationProfile(await db(), { repositoryId: repository.id, displayName: body.display_name, providerModelId: body.provider_model_id,
      enabled: body.enabled, promptBindings: asPromptBindings(body.prompt_bindings), skillBindings: asSkillBindings(body.skill_bindings) }, { expectedRevision: expectedRevision(request, body) }));
  }));
  app.patch('/api/admin/repositories/:repo/conversation-profile', { preHandler: guarded(true) }, withRoute(async request => {
    const { repository, profile } = await conversationProfile(request);
    const current = profileDto(profile);
    const body = parseBody(request, profileSchema.partial().extend({ expected_revision: revisionSchema.optional() }).strict());
    const next = { display_name: body.display_name ?? current.display_name, provider_model_id: body.provider_model_id ?? current.provider_model_id,
      enabled: body.enabled ?? current.enabled, prompt_bindings: body.prompt_bindings ?? current.prompt_bindings, skill_bindings: body.skill_bindings ?? current.skill_bindings,
      expected_revision: body.expected_revision ?? current.revision };
    return profileDto(await saveConversationProfile(await db(), { repositoryId: repository.id, displayName: next.display_name, providerModelId: next.provider_model_id,
      enabled: next.enabled, promptBindings: asPromptBindings(next.prompt_bindings), skillBindings: asSkillBindings(next.skill_bindings) }, { expectedRevision: expectedRevision(request, { expected_revision: next.expected_revision }) }));
  }));
  app.get('/api/admin/repositories/:repo/conversation-profile/effective', { preHandler: guarded() }, withRoute(async request => {
    const store = await db();
    const repository = await repositoryFor(store, request);
    const profile = await getConversationProfile(store, repository.id);
    if (!profile) throw new ControlPlaneError('not_found', 'Conversation Profile was not found.', 'conversation_profile');
    return effectiveDto(store, await resolveEffectiveConfiguration(store, { kind: 'conversation', repositoryId: repository.id, profileId: profile.id, executionId: `admin-${randomUUID()}` }));
  }));
}
