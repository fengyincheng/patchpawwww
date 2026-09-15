import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '../platform/lock.ts';
import { patchpawPaths } from '../config/paths.ts';
import { loadOperation } from '../operation/load.ts';
import { openControlPlaneDb, isoNow, type ControlPlaneDb, type ControlPlaneTransaction } from './db.ts';
import { CONTROL_PLANE_MIGRATION_VERSION } from './schema.ts';
import { ControlPlaneError } from './errors.ts';
import { contentDigest, createId, findMarker, normalizeAssetSlug, normalizeRepositoryName, putMarker, repositoryStorageKey } from './common.ts';
import { repositoryFromRow } from './common.ts';
import { discoverManagedRepositories } from './managed-repositories.ts';
import { promptFromRow } from './prompts.ts';
import { skillFromRow } from './skills.ts';
import type { BootstrapOptions, BootstrapReport, BootstrapRepositoryInput, PromptAsset, Provider, ProviderModel, Repository, SkillAsset } from './types.ts';

export const CONTROL_PLANE_BOOTSTRAP_VERSION = 'patchpaw-bootstrap-v1';
const defaultOperationRoot = fileURLToPath(new URL('../../operation/', import.meta.url));
const defaultHumanHelpSkillPath = fileURLToPath(new URL('../../skills/patchpaw-human-help/SKILL.md', import.meta.url));

interface SourcePrompt { slug: string; title: string; role: string; content: string; digest: string; }
interface SourceSkill { slug: string; title: string; description: string; content: string; digest: string; }

async function sourcePrompts(root: string) {
  const result: SourcePrompt[] = [];
  for (const entry of (await readdir(root)).filter(value => value.endsWith('.md')).sort()) {
    const slug = normalizeAssetSlug(entry.slice(0, -3));
    const content = root === defaultOperationRoot
      ? loadOperation(slug)
      : (await readFile(join(root, entry), 'utf8')).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    result.push({ slug, title: slug, role: slug, content, digest: contentDigest(content) });
  }
  return result;
}

async function sourceSkill(path: string): Promise<SourceSkill> {
  const content = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  return { slug: 'patchpaw-human-help', title: 'PatchPaw human help', description: 'Guidance for requesting human help during a task.', content, digest: contentDigest(content) };
}

async function lockBootstrap<T>(runtimeHome: string, work: () => Promise<T>) {
  return withFileLock(join(patchpawPaths(runtimeHome).locks, 'control-plane-bootstrap.lock'), 'exclusive',
    { timeoutMs: 600_000, reentrant: false }, work);
}

async function repositoryInTransaction(transaction: ControlPlaneTransaction, input: BootstrapRepositoryInput) {
  const normalized = input.scmKind === 'gitlab' ? repositoryStorageKey(input) : normalizeRepositoryName(input.fullName);
  const found = input.scmKind === 'gitlab'
    ? await transaction.execute('SELECT * FROM repositories WHERE connection_id = :connection_id AND remote_project_id = :remote_project_id', { connection_id: input.connectionId ?? null, remote_project_id: String(input.remoteProjectId ?? '') })
    : await transaction.execute("SELECT * FROM repositories WHERE full_name_normalized = :full_name_normalized AND scm_kind = 'github'", { full_name_normalized: normalized });
  if (found.rows[0]) return { repository: repositoryFromRow(found.rows[0]), created: false };
  const now = isoNow();
  const repository: Repository = { id: createId(), fullNameNormalized: normalized, displayName: input.displayName?.trim() || input.fullName.trim(), scmKind: input.scmKind ?? 'github', connectionId: input.connectionId ?? null,
    remoteProjectId: input.remoteProjectId === null || input.remoteProjectId === undefined ? null : String(input.remoteProjectId), pathWithNamespace: input.pathWithNamespace ?? null,
    webUrl: input.webUrl ?? null, cloneUrl: input.cloneUrl ?? null, storageKey: input.storageKey ?? repositoryStorageKey(input), revision: 1, createdAt: now, updatedAt: now };
  await transaction.execute(`INSERT INTO repositories(id, full_name_normalized, display_name, scm_kind, connection_id, remote_project_id, path_with_namespace, web_url, clone_url, storage_key, revision, created_at, updated_at)
    VALUES (:id, :full_name_normalized, :display_name, :scm_kind, :connection_id, :remote_project_id, :path_with_namespace, :web_url, :clone_url, :storage_key, 1, :created_at, :updated_at)`, { id: repository.id, full_name_normalized: normalized,
    display_name: repository.displayName, scm_kind: repository.scmKind, connection_id: repository.connectionId, remote_project_id: repository.remoteProjectId, path_with_namespace: repository.pathWithNamespace,
    web_url: repository.webUrl, clone_url: repository.cloneUrl, storage_key: repository.storageKey, created_at: now, updated_at: now });
  return { repository, created: true };
}

async function publicPromptInTransaction(transaction: ControlPlaneTransaction, source: SourcePrompt) {
  const marker = await findMarker(transaction, null, `public-prompt:${source.slug}`);
  const found = await transaction.execute(`SELECT * FROM prompt_assets WHERE scope = 'public' AND slug = :slug`, { slug: source.slug });
  if (found.rows[0]) return promptFromRow(found.rows[0]);
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') return undefined;
  const now = isoNow();
  const id = createId();
  await transaction.execute(`INSERT INTO prompt_assets(
    id, scope, repository_id, slug, title, role, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
  ) VALUES (:id, 'public', NULL, :slug, :title, :role, :content, 1, 1, NULL, NULL, :created_at, :updated_at)`, {
    id, slug: source.slug, title: source.title, role: source.role, content: source.content, created_at: now, updated_at: now,
  });
  await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${source.slug}`, resourceKind: 'prompt', resourceId: id,
    sourceDigest: source.digest, sourceRevision: 1, state: 'seeded' });
  return promptFromRow((await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id })).rows[0]);
}

async function publicSkillInTransaction(transaction: ControlPlaneTransaction, source: SourceSkill) {
  const marker = await findMarker(transaction, null, `public-skill:${source.slug}`);
  const found = await transaction.execute(`SELECT * FROM skill_assets WHERE scope = 'public' AND slug = :slug`, { slug: source.slug });
  if (found.rows[0]) return skillFromRow(found.rows[0]);
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') return undefined;
  const now = isoNow();
  const id = createId();
  await transaction.execute(`INSERT INTO skill_assets(
    id, scope, repository_id, slug, title, description, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
  ) VALUES (:id, 'public', NULL, :slug, :title, :description, :content, 1, 1, NULL, NULL, :created_at, :updated_at)`, {
    id, slug: source.slug, title: source.title, description: source.description, content: source.content, created_at: now, updated_at: now,
  });
  await putMarker(transaction, { repositoryId: null, seedKey: `public-skill:${source.slug}`, resourceKind: 'skill', resourceId: id,
    sourceDigest: source.digest, sourceRevision: 1, state: 'seeded' });
  return skillFromRow((await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id })).rows[0]);
}

async function providerInTransaction(transaction: ControlPlaneTransaction, env: NodeJS.ProcessEnv) {
  const seedKey = 'provider:zhipu';
  const marker = await findMarker(transaction, null, seedKey);
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') throw new ControlPlaneError('required_binding', 'The default Zhipu provider was explicitly removed.');
  const existing = marker?.resourceId ? await transaction.execute('SELECT * FROM providers WHERE id = :id', { id: marker.resourceId }) : await transaction.execute(`SELECT * FROM providers WHERE type = 'zhipu' ORDER BY created_at LIMIT 1`);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { provider: {
      id: String(row.id), type: 'zhipu' as const, displayName: String(row.display_name), baseUrl: String(row.base_url), credentialRef: row.credential_ref === null ? null : String(row.credential_ref),
      requestOptions: JSON.parse(String(row.request_options_json ?? '{}')) as Record<string, string | number | boolean>, enabled: Number(row.enabled) === 1, revision: Number(row.revision),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } satisfies Provider, created: false };
  }
  const now = isoNow();
  const id = createId();
  const baseUrl = env.ZAI_BASE_URL?.trim() || 'https://api.z.ai/api/paas/v4';
  const requestOptions: Record<string, string | number | boolean> = {};
  if (env.ZAI_REASONING_EFFORT?.trim()) requestOptions.reasoning_effort = env.ZAI_REASONING_EFFORT.trim();
  await transaction.execute(`INSERT INTO providers(
    id, type, display_name, base_url, credential_ref, request_options_json, enabled, revision, created_at, updated_at
  ) VALUES (:id, 'zhipu', 'Zhipu', :base_url, 'env:ZAI_API_KEY', :request_options_json, 1, 1, :created_at, :updated_at)`, {
    id, base_url: baseUrl, request_options_json: JSON.stringify(requestOptions), created_at: now, updated_at: now,
  });
  await putMarker(transaction, { repositoryId: null, seedKey, resourceKind: 'provider', resourceId: id, sourceDigest: contentDigest(`${baseUrl}|${JSON.stringify(requestOptions)}`), state: 'seeded' });
  return { provider: {
    id, type: 'zhipu' as const, displayName: 'Zhipu', baseUrl, credentialRef: 'env:ZAI_API_KEY', requestOptions, enabled: true, revision: 1, createdAt: now, updatedAt: now,
  } satisfies Provider, created: true };
}

async function modelInTransaction(transaction: ControlPlaneTransaction, provider: Provider, env: NodeJS.ProcessEnv) {
  const identifier = env.ZAI_MODEL?.trim() || 'glm-4.5-flash';
  const seedKey = `model:zhipu:${identifier}`;
  const marker = await findMarker(transaction, null, seedKey);
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') throw new ControlPlaneError('required_binding', `Default model seed was explicitly removed: ${identifier}`);
  const existing = marker?.resourceId ? await transaction.execute('SELECT * FROM provider_models WHERE id = :id', { id: marker.resourceId }) : await transaction.execute('SELECT * FROM provider_models WHERE provider_id = :provider_id AND model_identifier = :identifier', { provider_id: provider.id, identifier });
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { model: { id: String(row.id), providerId: String(row.provider_id), modelIdentifier: String(row.model_identifier), displayName: String(row.display_name), enabled: Number(row.enabled) === 1,
      revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } satisfies ProviderModel, created: false };
  }
  const now = isoNow();
  const id = createId();
  await transaction.execute(`INSERT INTO provider_models(id, provider_id, model_identifier, display_name, enabled, revision, created_at, updated_at)
    VALUES (:id, :provider_id, :identifier, :display_name, 1, 1, :created_at, :updated_at)`, { id, provider_id: provider.id, identifier, display_name: identifier, created_at: now, updated_at: now });
  await putMarker(transaction, { repositoryId: null, seedKey, resourceKind: 'provider_model', resourceId: id, sourceDigest: contentDigest(identifier), state: 'seeded' });
  return { model: { id, providerId: provider.id, modelIdentifier: identifier, displayName: identifier, enabled: true, revision: 1, createdAt: now, updatedAt: now } satisfies ProviderModel, created: true };
}

async function copyAssetsForRepository(transaction: ControlPlaneTransaction, repository: Repository, publicPrompts: PromptAsset[], publicSkills: SkillAsset[]) {
  const prompts: PromptAsset[] = [];
  let createdAny = false;
  for (const source of publicPrompts) {
    const found = await transaction.execute('SELECT * FROM prompt_assets WHERE scope = \'repository\' AND repository_id = :repository_id AND slug = :slug', { repository_id: repository.id, slug: source.slug });
    if (found.rows[0]) { prompts.push(promptFromRow(found.rows[0])); continue; }
    const marker = await findMarker(transaction, repository.id, `prompt:${source.slug}`);
    if (marker?.state === 'tombstone' || marker?.state === 'disabled') continue;
    const now = isoNow(); const id = createId();
    await transaction.execute(`INSERT INTO prompt_assets(id, scope, repository_id, slug, title, role, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at)
      VALUES (:id, 'repository', :repository_id, :slug, :title, :role, :content, :enabled, 1, :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
      id, repository_id: repository.id, slug: source.slug, title: source.title, role: source.role, content: source.content, enabled: source.enabled ? 1 : 0,
      source_public_id: source.id, source_public_revision: source.revision, created_at: now, updated_at: now,
    });
    await putMarker(transaction, { repositoryId: repository.id, seedKey: `prompt:${source.slug}`, resourceKind: 'prompt', resourceId: id, sourceDigest: contentDigest(source.content), sourceRevision: source.revision, state: 'seeded' });
    createdAny = true;
    prompts.push(promptFromRow((await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id })).rows[0]));
  }
  const skills: SkillAsset[] = [];
  for (const source of publicSkills) {
    const found = await transaction.execute('SELECT * FROM skill_assets WHERE scope = \'repository\' AND repository_id = :repository_id AND slug = :slug', { repository_id: repository.id, slug: source.slug });
    if (found.rows[0]) { skills.push(skillFromRow(found.rows[0])); continue; }
    const marker = await findMarker(transaction, repository.id, `skill:${source.slug}`);
    if (marker?.state === 'tombstone' || marker?.state === 'disabled') continue;
    const now = isoNow(); const id = createId();
    await transaction.execute(`INSERT INTO skill_assets(id, scope, repository_id, slug, title, description, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at)
      VALUES (:id, 'repository', :repository_id, :slug, :title, :description, :content, :enabled, 1, :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
      id, repository_id: repository.id, slug: source.slug, title: source.title, description: source.description, content: source.content, enabled: source.enabled ? 1 : 0,
      source_public_id: source.id, source_public_revision: source.revision, created_at: now, updated_at: now,
    });
    await putMarker(transaction, { repositoryId: repository.id, seedKey: `skill:${source.slug}`, resourceKind: 'skill', resourceId: id, sourceDigest: contentDigest(source.content), sourceRevision: source.revision, state: 'seeded' });
    createdAny = true;
    skills.push(skillFromRow((await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id })).rows[0]));
  }
  if (createdAny) await transaction.execute('UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: repository.id, updated_at: isoNow() });
  return { prompts, skills };
}

async function builtInCommand(transaction: ControlPlaneTransaction, repository: Repository, model: ProviderModel, name: 'review' | 'ci' | 'conflict', prompts: PromptAsset[], humanHelp: SkillAsset, shared: PromptAsset) {
  const found = await transaction.execute('SELECT * FROM commands WHERE repository_id = :repository_id AND slash_name = :slash_name', { repository_id: repository.id, slash_name: name });
  if (found.rows[0]) {
    const commandId = String(found.rows[0].id);
    const marker = await findMarker(transaction, repository.id, `command:${name}`);
    // A seeded command may have been created by an earlier bootstrap version.
    // Converge only that owned record; an operator override remains entirely
    // under control-plane ownership and is allowed to fail closed in the resolver.
    if (marker?.state !== 'seeded') return commandId;
    const auxiliaryRoles = name === 'review'
      ? ['stop-closeout']
      : ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'];
    const bound = await transaction.execute(`SELECT b.position, p.role
      FROM command_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id WHERE b.command_id = :id`, { id: commandId });
    const boundRoles = new Set(bound.rows.map(row => String(row.role ?? '')));
    let nextPosition = Math.max(0, ...bound.rows.map(row => Number(row.position))) + 1;
    const added: PromptAsset[] = [];
    for (const role of auxiliaryRoles) {
      if (boundRoles.has(role)) continue;
      const asset = prompts.find(value => value.role === role && value.enabled);
      if (!asset) throw new ControlPlaneError('required_binding', `Required bootstrap asset is unavailable for /${name}: ${role}`);
      await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
        VALUES (:command_id, :prompt_asset_id, :position, 1, 'auxiliary')`, { command_id: commandId, prompt_asset_id: asset.id, position: nextPosition++ });
      added.push(asset);
    }
    if (added.length) {
      await transaction.execute('UPDATE commands SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: commandId, updated_at: isoNow() });
      await transaction.execute('UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: repository.id, updated_at: isoNow() });
      const allBound = await transaction.execute('SELECT prompt_asset_id FROM command_prompts WHERE command_id = :id ORDER BY position', { id: commandId });
      await putMarker(transaction, { repositoryId: repository.id, seedKey: `command:${name}`, resourceKind: 'command', resourceId: commandId,
        sourceDigest: contentDigest(allBound.rows.map(row => String(row.prompt_asset_id)).join(':')), sourceRevision: Number(found.rows[0].revision) + 1, state: 'seeded' });
    }
    return commandId;
  }
  if (!model.enabled) throw new ControlPlaneError('required_binding', `Cannot bind disabled provider model to /${name}`);
  const marker = await findMarker(transaction, repository.id, `command:${name}`);
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') throw new ControlPlaneError('required_binding', `Built-in command was explicitly removed: /${name}`);
  const mainRole = name === 'review' ? 'review' : name === 'ci' ? 'ci-repair' : 'conflict';
  const auxiliaryRoles = name === 'review'
    ? ['review-json-retry', 'stop-closeout']
    : ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'];
  const main = prompts.find(asset => asset.role === mainRole && asset.enabled);
  const auxiliary = auxiliaryRoles.map(role => prompts.find(asset => asset.role === role && asset.enabled));
  if (!main || auxiliary.some(asset => !asset) || !shared.enabled || !humanHelp.enabled) throw new ControlPlaneError('required_binding', `Required bootstrap asset is unavailable for /${name}`);
  const now = isoNow(); const id = createId(); const permission = name === 'review' ? 'read_only' : 'read_write'; const executionType = name;
  await transaction.execute(`INSERT INTO commands(id, repository_id, slash_name, display_name, description, execution_type, permission, provider_model_id, enabled, revision, created_at, updated_at)
    VALUES (:id, :repository_id, :slash_name, :display_name, :description, :execution_type, :permission, :provider_model_id, 1, 1, :created_at, :updated_at)`, {
    id, repository_id: repository.id, slash_name: name, display_name: name === 'ci' ? '/CI' : `/${name}`, description: `Built-in ${name} command`, execution_type: executionType,
    permission, provider_model_id: model.id, created_at: now, updated_at: now,
  });
  await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind) VALUES
    (:id, :main, 1, 1, 'main'), (:id, :shared, :shared_position, 1, 'common')`, { id, main: main.id, shared: shared.id, shared_position: auxiliary.length + 2 });
  for (const [index, asset] of auxiliary.entries()) await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
    VALUES (:id, :asset, :position, 1, 'auxiliary')`, { id, asset: asset!.id, position: index + 2 });
  await transaction.execute(`INSERT INTO command_skills(command_id, skill_asset_id, position, enabled) VALUES (:id, :skill, 1, 1)`, { id, skill: humanHelp.id });
  await transaction.execute('UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: repository.id, updated_at: isoNow() });
  await putMarker(transaction, { repositoryId: repository.id, seedKey: `command:${name}`, resourceKind: 'command', resourceId: id, sourceDigest: contentDigest(`${main.id}:${auxiliary.map(asset => asset!.id).join(':')}:${shared.id}:${humanHelp.id}`), state: 'seeded' });
  return id;
}

async function conversationProfile(transaction: ControlPlaneTransaction, repository: Repository, model: ProviderModel, prompts: PromptAsset[], humanHelp: SkillAsset, shared: PromptAsset) {
  const found = await transaction.execute('SELECT * FROM conversation_profiles WHERE repository_id = :repository_id', { repository_id: repository.id });
  if (found.rows[0]) {
    const profileId = String(found.rows[0].id);
    const marker = await findMarker(transaction, repository.id, 'conversation-profile');
    if (marker?.state !== 'seeded') return profileId;
    const bound = await transaction.execute(`SELECT b.position, p.role
      FROM profile_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id WHERE b.profile_id = :id`, { id: profileId });
    if (bound.rows.some(row => String(row.role ?? '') === 'stop-closeout')) return profileId;
    const stopCloseout = prompts.find(asset => asset.role === 'stop-closeout' && asset.enabled);
    if (!stopCloseout) throw new ControlPlaneError('required_binding', 'Required bootstrap asset is unavailable for Conversation Profile: stop-closeout');
    const nextPosition = Math.max(0, ...bound.rows.map(row => Number(row.position))) + 1;
    await transaction.execute(`INSERT INTO profile_prompts(profile_id, prompt_asset_id, position, enabled, binding_kind)
      VALUES (:profile_id, :prompt_asset_id, :position, 1, 'auxiliary')`, { profile_id: profileId, prompt_asset_id: stopCloseout.id, position: nextPosition });
    await transaction.execute('UPDATE conversation_profiles SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: profileId, updated_at: isoNow() });
    await transaction.execute('UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: repository.id, updated_at: isoNow() });
    const allBound = await transaction.execute('SELECT prompt_asset_id FROM profile_prompts WHERE profile_id = :id ORDER BY position', { id: profileId });
    await putMarker(transaction, { repositoryId: repository.id, seedKey: 'conversation-profile', resourceKind: 'conversation_profile', resourceId: profileId,
      sourceDigest: contentDigest(allBound.rows.map(row => String(row.prompt_asset_id)).join(':')), sourceRevision: Number(found.rows[0].revision) + 1, state: 'seeded' });
    return profileId;
  }
  if (!model.enabled) throw new ControlPlaneError('required_binding', 'Cannot bind a disabled provider model to Conversation Profile.');
  const marker = await findMarker(transaction, repository.id, 'conversation-profile');
  if (marker?.state === 'tombstone' || marker?.state === 'disabled') throw new ControlPlaneError('required_binding', 'Conversation Profile was explicitly removed.');
  const main = prompts.find(asset => asset.role === 'conversation' && asset.enabled);
  const auxiliary = prompts.find(asset => asset.role === 'conversation-retry' && asset.enabled);
  if (!main || !auxiliary || !shared.enabled || !humanHelp.enabled) throw new ControlPlaneError('required_binding', 'Required bootstrap assets are unavailable for Conversation Profile.');
  const now = isoNow(); const id = createId();
  await transaction.execute(`INSERT INTO conversation_profiles(id, repository_id, display_name, provider_model_id, enabled, revision, created_at, updated_at)
    VALUES (:id, :repository_id, 'Conversation', :provider_model_id, 1, 1, :created_at, :updated_at)`, { id, repository_id: repository.id, provider_model_id: model.id, created_at: now, updated_at: now });
  const stopCloseout = prompts.find(asset => asset.role === 'stop-closeout' && asset.enabled);
  if (!stopCloseout) throw new ControlPlaneError('required_binding', 'Required bootstrap asset is unavailable for Conversation Profile: stop-closeout');
  await transaction.execute(`INSERT INTO profile_prompts(profile_id, prompt_asset_id, position, enabled, binding_kind) VALUES
    (:id, :main, 1, 1, 'main'), (:id, :auxiliary, 2, 1, 'auxiliary'), (:id, :shared, 3, 1, 'common'), (:id, :stop_closeout, 4, 1, 'auxiliary')`, { id, main: main.id, auxiliary: auxiliary.id, shared: shared.id, stop_closeout: stopCloseout.id });
  await transaction.execute('INSERT INTO profile_skills(profile_id, skill_asset_id, position, enabled) VALUES (:id, :skill, 1, 1)', { id, skill: humanHelp.id });
  await transaction.execute('UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: repository.id, updated_at: isoNow() });
  await putMarker(transaction, { repositoryId: repository.id, seedKey: 'conversation-profile', resourceKind: 'conversation_profile', resourceId: id, sourceDigest: contentDigest(`${main.id}:${auxiliary.id}:${shared.id}:${stopCloseout.id}:${humanHelp.id}`), state: 'seeded' });
  return id;
}

export async function bootstrapControlPlane(options: BootstrapOptions): Promise<BootstrapReport> {
  const operationRoot = options.operationRoot ?? defaultOperationRoot;
  const skillPath = options.humanHelpSkillPath ?? defaultHumanHelpSkillPath;
  const [promptSources, skillSource] = await Promise.all([sourcePrompts(operationRoot), sourceSkill(skillPath)]);
  const repositoryInputs: NonNullable<BootstrapOptions['repositories']> = options.repositories ?? (await discoverManagedRepositories(options.root)).map(fullName => ({ fullName }));
  const ownsDb = !options.controlPlaneDb;
  const db: ControlPlaneDb = options.controlPlaneDb ?? await openControlPlaneDb(options.root);
  try {
    return await lockBootstrap(options.root, async () => db.transaction(async transaction => {
      const publicPrompts: PromptAsset[] = [];
      for (const source of promptSources) {
        const prompt = await publicPromptInTransaction(transaction, source);
        if (prompt) publicPrompts.push(prompt);
      }
      const publicSkills: SkillAsset[] = [];
      const skill = await publicSkillInTransaction(transaction, skillSource);
      if (skill) publicSkills.push(skill);
      const providerSeed = await providerInTransaction(transaction, options.env ?? process.env);
      const modelSeed = await modelInTransaction(transaction, providerSeed.provider, options.env ?? process.env);
      const repositoryResults: BootstrapReport['repositoryResults'] = [];
      const repositories: Repository[] = [];
      for (const input of repositoryInputs) {
        const managed = await repositoryInTransaction(transaction, input);
        repositories.push(managed.repository);
        const copied = await copyAssetsForRepository(transaction, managed.repository, publicPrompts, publicSkills);
        const sharedRows = await transaction.execute(`SELECT * FROM prompt_assets
          WHERE scope = 'repository' AND repository_id = :repository_id AND role = 'shared'`, { repository_id: managed.repository.id });
        const helpRows = await transaction.execute(`SELECT * FROM skill_assets
          WHERE scope = 'repository' AND repository_id = :repository_id AND slug = 'patchpaw-human-help'`, { repository_id: managed.repository.id });
        const shared = copied.prompts.find(asset => asset.role === 'shared') ?? (sharedRows.rows[0] ? promptFromRow(sharedRows.rows[0]) : undefined);
        const humanHelp = copied.skills.find(asset => asset.slug === 'patchpaw-human-help') ?? (helpRows.rows[0] ? skillFromRow(helpRows.rows[0]) : undefined);
        if (!shared || !humanHelp) throw new ControlPlaneError('required_binding', `Bootstrap copies are incomplete for ${managed.repository.fullNameNormalized}`);
        const commandIds = [
          await builtInCommand(transaction, managed.repository, modelSeed.model, 'review', copied.prompts, humanHelp, shared),
          await builtInCommand(transaction, managed.repository, modelSeed.model, 'ci', copied.prompts, humanHelp, shared),
          await builtInCommand(transaction, managed.repository, modelSeed.model, 'conflict', copied.prompts, humanHelp, shared),
        ];
        const profileId = await conversationProfile(transaction, managed.repository, modelSeed.model, copied.prompts, humanHelp, shared);
        const finalRepository = repositoryFromRow((await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id: managed.repository.id })).rows[0]);
        repositories[repositories.length - 1] = finalRepository;
        repositoryResults.push({ repository: finalRepository, created: managed.created, commandIds, profileId });
      }
      await db.setMeta('bootstrap_version', CONTROL_PLANE_BOOTSTRAP_VERSION, transaction);
      await db.setMeta('bootstrap_completed_at', isoNow(), transaction);
      return { bootstrapVersion: CONTROL_PLANE_BOOTSTRAP_VERSION, migrationVersion: CONTROL_PLANE_MIGRATION_VERSION, repositories, publicPrompts, publicSkills,
        provider: providerSeed.provider, model: modelSeed.model, repositoryResults };
    }));
  } finally { if (ownsDb) db.close(); }
}

export const bootstrap = bootstrapControlPlane;
