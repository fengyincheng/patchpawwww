import type { ControlPlaneDb } from './db.ts';
import type { ScmKind } from '../scm/types.ts';

export const PROVIDER_TYPES = ['zhipu', 'deepseek', 'openrouter', 'kimi', 'qwen'] as const;
export type ProviderType = typeof PROVIDER_TYPES[number];

export const EXECUTION_TYPES = ['custom', 'review', 'repair', 'ci', 'conflict'] as const;
export type ExecutionType = typeof EXECUTION_TYPES[number];

export const PERMISSIONS = ['read_only', 'read_write', 'read_write_approval'] as const;
export type Permission = typeof PERMISSIONS[number];
export type AssetScope = 'public' | 'repository';
export type BindingKind = 'main' | 'common' | 'auxiliary';

export interface Repository {
  id: string;
  fullNameNormalized: string;
  displayName: string;
  scmKind: ScmKind;
  connectionId: string | null;
  remoteProjectId: string | null;
  pathWithNamespace: string | null;
  webUrl: string | null;
  cloneUrl: string | null;
  storageKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptAsset {
  id: string;
  scope: AssetScope;
  repositoryId: string | null;
  slug: string;
  title: string;
  role: string | null;
  content: string;
  enabled: boolean;
  revision: number;
  sourcePublicId: string | null;
  sourcePublicRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillAsset {
  id: string;
  scope: AssetScope;
  repositoryId: string | null;
  slug: string;
  title: string;
  description: string;
  content: string;
  enabled: boolean;
  revision: number;
  sourcePublicId: string | null;
  sourcePublicRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  id: string;
  type: ProviderType;
  displayName: string;
  baseUrl: string;
  credentialRef: string | null;
  requestOptions: Record<string, string | number | boolean>;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  modelIdentifier: string;
  displayName: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptBinding {
  assetId: string;
  position: number;
  enabled: boolean;
  bindingKind: BindingKind;
}

export interface SkillBinding {
  assetId: string;
  position: number;
  enabled: boolean;
}

export interface Command {
  id: string;
  repositoryId: string;
  slashName: string;
  displayName: string;
  description: string;
  executionType: ExecutionType;
  permission: Permission;
  providerModelId: string;
  enabled: boolean;
  revision: number;
  promptBindings: PromptBinding[];
  skillBindings: SkillBinding[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationProfile {
  id: string;
  repositoryId: string;
  displayName: string;
  providerModelId: string;
  enabled: boolean;
  revision: number;
  promptBindings: PromptBinding[];
  skillBindings: SkillBinding[];
  createdAt: string;
  updatedAt: string;
}

export type BootstrapMarkerState = 'seeded' | 'override' | 'disabled' | 'tombstone';

export interface BootstrapMarker {
  id: string;
  repositoryId: string | null;
  seedKey: string;
  resourceKind: string;
  resourceId: string | null;
  sourceDigest: string;
  sourceRevision: number | null;
  state: BootstrapMarkerState;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryInput {
  fullName: string;
  displayName?: string;
  scmKind?: ScmKind;
  connectionId?: string | null;
  remoteProjectId?: string | number | null;
  pathWithNamespace?: string | null;
  webUrl?: string | null;
  cloneUrl?: string | null;
  storageKey?: string;
}

export interface ScmConnectionInput {
  id?: string;
  kind: ScmKind;
  instanceUrl: string;
  credentialRef?: string | null;
  webhookMode?: 'secret' | 'signing';
  webhookSecretRef?: string | null;
  botUserId?: string | null;
  botLogin?: string | null;
  projectIds?: string[];
  enabled?: boolean;
}

export type { ScmConnection } from '../scm/types.ts';

export interface PromptInput {
  scope: AssetScope;
  repositoryId?: string | null;
  slug: string;
  title: string;
  role?: string | null;
  content: string;
  enabled?: boolean;
}

export interface SkillInput {
  scope: AssetScope;
  repositoryId?: string | null;
  slug: string;
  title: string;
  description?: string;
  content: string;
  enabled?: boolean;
}

export interface ProviderInput {
  type: ProviderType;
  displayName: string;
  baseUrl: string;
  credentialRef?: string | null;
  requestOptions?: Record<string, string | number | boolean>;
  enabled?: boolean;
}

export interface ProviderModelInput {
  providerId: string;
  modelIdentifier: string;
  displayName?: string;
  enabled?: boolean;
}

export interface CommandInput {
  repositoryId: string;
  slashName: string;
  displayName: string;
  description?: string;
  executionType: ExecutionType;
  permission: Permission;
  providerModelId: string;
  enabled?: boolean;
  promptBindings?: PromptBinding[];
  skillBindings?: SkillBinding[];
}

export interface ConversationProfileInput {
  repositoryId: string;
  displayName: string;
  providerModelId: string;
  enabled?: boolean;
  promptBindings?: PromptBinding[];
  skillBindings?: SkillBinding[];
}

export interface ExpectedRevision {
  expectedRevision?: number;
}

export interface CopyOptions {
  replace?: boolean;
  expectedRepositoryRevision?: number;
}

export interface BootstrapRepositoryInput extends RepositoryInput {}

export interface BootstrapOptions {
  root: string;
  repositories?: BootstrapRepositoryInput[];
  env?: NodeJS.ProcessEnv;
  operationRoot?: string;
  humanHelpSkillPath?: string;
  /** Reuse a DB prepared before the worker acquires the runtime shared lock. */
  controlPlaneDb?: ControlPlaneDb;
}

export interface BootstrapReport {
  bootstrapVersion: string;
  migrationVersion: number;
  repositories: Repository[];
  publicPrompts: PromptAsset[];
  publicSkills: SkillAsset[];
  provider: Provider;
  model: ProviderModel;
  repositoryResults: Array<{ repository: Repository; created: boolean; commandIds: string[]; profileId: string }>;
}
