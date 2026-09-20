import type { Row } from '@libsql/client';
import { ControlPlaneDb, booleanValue, isoNow, numberValue, rowValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { ControlPlaneError } from './errors.ts';
import { promptFromRow } from './prompts.ts';
import { skillFromRow } from './skills.ts';
import { commandBaseFromRow, profileBaseFromRow } from './commands.ts';
import { contentDigest, createId, repositoryFromRow } from './common.ts';
import { outputContractForTemplate, validateTemplate, type TemplateType } from './templates.ts';
import { COMMAND_SNAPSHOT_SCHEMA_VERSION, TOOLSET_VERSION, type CommandSnapshot, type CommandSnapshotPart, validateCommandSnapshot } from './snapshots.ts';
import type { Command, ConversationProfile, PromptAsset, Provider, ProviderModel, SkillAsset } from './types.ts';
import { resolveOutputBudget } from '../models/output-budget.ts';
import { builtinPromptByRole, builtinPromptBySlug } from './builtin-prompts.ts';

export type ResolveInput =
  | { kind: 'command'; repositoryId: string; commandId?: string; slashName?: string; executionId: string }
  | { kind: 'conversation'; repositoryId: string; profileId?: string; executionId: string };

export interface ResolvedExecution {
  executionId: string;
  target: 'command' | 'conversation';
  command?: { id: string; slashName: string; revision: number };
  conversationProfile?: { id: string; revision: number };
  executionType: TemplateType;
  permission: 'read_only' | 'read_write' | 'read_write_approval';
  outputContract: ReturnType<typeof outputContractForTemplate>;
  provider: Provider;
  model: ProviderModel;
  prompts: PromptAsset[];
  skills: SkillAsset[];
  snapshot: CommandSnapshot;
}

interface BoundPrompt { binding: { position: number; enabled: boolean; bindingKind: string }; asset: PromptAsset }
interface BoundSkill { binding: { position: number; enabled: boolean }; asset: SkillAsset }

function rowString(row: Row, key: string) { return textValue(row, key); }

async function loadTarget(transaction: ControlPlaneTransaction, input: ResolveInput) {
  if (input.kind === 'command') {
    const conditions = input.commandId ? 'c.id = :command_id' : 'c.slash_name = :slash_name';
    const result = await transaction.execute(`SELECT * FROM commands c WHERE c.repository_id = :repository_id AND ${conditions}`, {
      repository_id: input.repositoryId, ...(input.commandId ? { command_id: input.commandId } : { slash_name: input.slashName?.trim().replace(/^\/+/, '').toLowerCase() ?? '' }),
    });
    if (!result.rows[0]) throw new ControlPlaneError('not_found', 'Command was not found for this repository.', 'command');
    const command = commandBaseFromRow(result.rows[0]) as Omit<Command, 'promptBindings' | 'skillBindings'>;
    const [promptRows, skillRows] = await Promise.all([
      transaction.execute(`SELECT b.position AS binding_position, b.enabled AS binding_enabled, b.binding_kind, p.*
        FROM command_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id
        WHERE b.command_id = :id ORDER BY b.position`, { id: command.id }),
      transaction.execute(`SELECT b.position AS binding_position, b.enabled AS binding_enabled, s.*
        FROM command_skills b JOIN skill_assets s ON s.id = b.skill_asset_id
        WHERE b.command_id = :id ORDER BY b.position`, { id: command.id }),
    ]);
    return { target: command, promptRows: promptRows.rows, skillRows: skillRows.rows, profile: undefined };
  }
  const result = await transaction.execute(`SELECT * FROM conversation_profiles WHERE repository_id = :repository_id ${input.profileId ? 'AND id = :profile_id' : ''}`, {
    repository_id: input.repositoryId, ...(input.profileId ? { profile_id: input.profileId } : {}),
  });
  if (!result.rows[0]) throw new ControlPlaneError('not_found', 'Conversation Profile was not found for this repository.', 'conversation_profile');
  const profile = profileBaseFromRow(result.rows[0]) as Omit<ConversationProfile, 'promptBindings' | 'skillBindings'>;
  const [promptRows, skillRows] = await Promise.all([
    transaction.execute(`SELECT b.position AS binding_position, b.enabled AS binding_enabled, b.binding_kind, p.*
      FROM profile_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id
      WHERE b.profile_id = :id ORDER BY b.position`, { id: profile.id }),
    transaction.execute(`SELECT b.position AS binding_position, b.enabled AS binding_enabled, s.*
      FROM profile_skills b JOIN skill_assets s ON s.id = b.skill_asset_id
      WHERE b.profile_id = :id ORDER BY b.position`, { id: profile.id }),
  ]);
  return { target: undefined, promptRows: promptRows.rows, skillRows: skillRows.rows, profile };
}

function mapBoundAssets(repositoryId: string, promptRows: Row[], skillRows: Row[]) {
  const prompts: BoundPrompt[] = promptRows.map(row => ({ binding: { position: numberValue(row, 'binding_position'), enabled: booleanValue(row, 'binding_enabled'), bindingKind: rowString(row, 'binding_kind') }, asset: promptFromRow(row) }));
  const skills: BoundSkill[] = skillRows.map(row => ({ binding: { position: numberValue(row, 'binding_position'), enabled: booleanValue(row, 'binding_enabled') }, asset: skillFromRow(row) }));
  for (const { binding, asset } of prompts) {
    if (asset.scope !== 'repository' || asset.repositoryId !== repositoryId) throw new ControlPlaneError('invalid_configuration', 'Prompt binding crosses repository scope.', 'prompt_binding');
    if (binding.enabled && !asset.enabled) throw new ControlPlaneError('required_binding', `Bound prompt is disabled: ${asset.slug}`, 'prompt_binding');
  }
  for (const { binding, asset } of skills) {
    if (asset.scope !== 'repository' || asset.repositoryId !== repositoryId) throw new ControlPlaneError('invalid_configuration', 'Skill binding crosses repository scope.', 'skill_binding');
    if (binding.enabled && !asset.enabled) throw new ControlPlaneError('required_binding', `Bound skill is disabled: ${asset.slug}`, 'skill_binding');
  }
  return { prompts, skills };
}

function requiredMainRole(executionType: TemplateType) {
  if (executionType === 'conversation') return 'conversation';
  if (executionType === 'review') return 'review';
  if (executionType === 'ci') return 'ci-repair';
  if (executionType === 'conflict') return 'conflict';
  return null;
}

function requiredPromptRoles(executionType: TemplateType) {
  switch (executionType) {
    case 'conversation': return ['conversation'];
    case 'custom': return [];
    case 'review': return ['review'];
    case 'ci': return ['ci-repair'];
    case 'conflict': return ['conflict'];
    case 'repair': return [];
  }
}

function effectiveParts(prompts: BoundPrompt[], skills: BoundSkill[]) {
  const enabledPrompts = prompts.filter(value => value.binding.enabled && value.asset.enabled);
  const enabledSkills = skills.filter(value => value.binding.enabled && value.asset.enabled);
  const orderedPrompts = [
    ...enabledPrompts.filter(value => value.binding.bindingKind === 'main'),
    ...enabledPrompts.filter(value => value.binding.bindingKind === 'common'),
    ...enabledPrompts.filter(value => value.binding.bindingKind === 'auxiliary'),
  ].sort((left, right) => {
    const category = (value: BoundPrompt) => value.binding.bindingKind === 'main' ? 0 : value.binding.bindingKind === 'common' ? 1 : 2;
    return category(left) - category(right) || left.binding.position - right.binding.position || left.asset.id.localeCompare(right.asset.id);
  });
  const byKind = (kind: 'main' | 'common' | 'auxiliary') => orderedPrompts.filter(value => value.binding.bindingKind === kind)
    .map(value => ({ kind: 'prompt' as const, bindingPosition: value.binding.position, asset: value.asset }));
  const ordered = [
    ...byKind('main'),
    ...enabledSkills.sort((left, right) => left.binding.position - right.binding.position || left.asset.id.localeCompare(right.asset.id))
      .map(value => ({ kind: 'skill' as const, bindingPosition: value.binding.position, asset: value.asset })),
    ...byKind('common'),
    ...byKind('auxiliary'),
  ];
  // The persisted composition order is the user-visible effective order:
  // main Prompts, Skills, common Prompts, then auxiliary Prompts. This is
  // deterministic even when the database rows were returned in another order.
  return ordered;
}

function snapshotPart(value: ReturnType<typeof effectiveParts>[number], position: number): CommandSnapshotPart {
  return { kind: value.kind, position, asset_id: value.asset.id, slug: value.asset.slug,
    role: value.kind === 'prompt' ? value.asset.role : null, revision: value.asset.revision,
    sha256: contentDigest(value.asset.content), content: value.asset.content };
}

async function resolveInTransaction(transaction: ControlPlaneTransaction, input: ResolveInput): Promise<ResolvedExecution> {
  const repositoryRow = await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id: input.repositoryId });
  if (!repositoryRow.rows[0]) throw new ControlPlaneError('not_found', 'Repository was not found.', 'repository_id');
  const repository = repositoryFromRow(repositoryRow.rows[0]);
  const loaded = await loadTarget(transaction, input);
  const { prompts, skills } = mapBoundAssets(repository.id, loaded.promptRows, loaded.skillRows);
  for (const bound of prompts) {
    const legacy = [builtinPromptBySlug(bound.asset.slug), builtinPromptByRole(bound.asset.role)].find(value => value && !value.newRuns);
    if (legacy && bound.binding.enabled && bound.asset.enabled) {
      throw new ControlPlaneError('invalid_configuration', `Legacy-only Prompt cannot participate in a new execution: ${legacy.slug}`, 'prompt_binding');
    }
  }
  const targetEnabled = input.kind === 'command' ? loaded.target!.enabled : loaded.profile!.enabled;
  if (!targetEnabled) throw new ControlPlaneError('required_binding', 'The selected command/profile is disabled.', input.kind);
  const executionType: TemplateType = input.kind === 'conversation' ? 'conversation' : loaded.target!.executionType;
  const permission = input.kind === 'conversation' ? 'read_only' : loaded.target!.permission;
  const mainBindings = prompts.filter(value => value.binding.enabled && value.binding.bindingKind === 'main' && value.asset.enabled);
  if (!mainBindings.length) throw new ControlPlaneError('required_binding', `Enabled ${input.kind} requires a main prompt binding.`, 'prompt_binding');
  const mainRole = requiredMainRole(executionType);
  if (mainRole && !mainBindings.some(value => value.asset.role === mainRole)) throw new ControlPlaneError('required_binding', `Required prompt role is missing: ${mainRole}`, 'prompt_binding');
  const activeRoles = new Set(prompts.filter(value => value.binding.enabled && value.asset.enabled).map(value => value.asset.role).filter((value): value is string => Boolean(value)));
  const missingRoles = requiredPromptRoles(executionType).filter(role => !activeRoles.has(role));
  if (missingRoles.length) throw new ControlPlaneError('required_binding', `Required prompt role is missing: ${missingRoles.join(', ')}`, 'prompt_binding');
  if (permission === 'read_write_approval' && !activeRoles.has('plan-mode')) {
    throw new ControlPlaneError('required_binding', 'Read + write (approval required) commands need an enabled plan-mode Prompt binding.', 'prompt_binding');
  }
  const modelRow = await transaction.execute(`SELECT m.*, p.type, p.display_name AS provider_display_name, p.base_url, p.credential_ref,
      p.request_options_json, p.enabled AS provider_enabled, p.revision AS provider_revision,
      p.created_at AS provider_created_at, p.updated_at AS provider_updated_at
    FROM provider_models m JOIN providers p ON p.id = m.provider_id WHERE m.id = :id`, {
    id: input.kind === 'command' ? loaded.target!.providerModelId : loaded.profile!.providerModelId,
  });
  if (!modelRow.rows[0]) throw new ControlPlaneError('provider_unavailable', 'Configured provider model is unavailable.', 'provider_model_id');
  const model = {
    id: rowString(modelRow.rows[0], 'id'), providerId: rowString(modelRow.rows[0], 'provider_id'), modelIdentifier: rowString(modelRow.rows[0], 'model_identifier'),
    displayName: rowString(modelRow.rows[0], 'display_name'), enabled: booleanValue(modelRow.rows[0], 'enabled'), revision: numberValue(modelRow.rows[0], 'revision'),
    createdAt: rowString(modelRow.rows[0], 'created_at'), updatedAt: rowString(modelRow.rows[0], 'updated_at'),
  } satisfies ProviderModel;
  if (!model.enabled || !booleanValue(modelRow.rows[0], 'provider_enabled')) throw new ControlPlaneError('provider_unavailable', 'Configured provider or model is disabled.', 'provider_model_id');
  const credentialRef = rowValue(modelRow.rows[0], 'credential_ref');
  if (credentialRef === null || credentialRef === undefined || String(credentialRef).trim() === '') throw new ControlPlaneError('provider_unavailable', 'Configured provider has no credential reference.', 'credential_ref');
  let requestOptions: Record<string, string | number | boolean>;
  try { requestOptions = JSON.parse(rowString(modelRow.rows[0], 'request_options_json') || '{}') as Record<string, string | number | boolean>; }
  catch { throw new ControlPlaneError('invalid_configuration', 'Provider request options are not valid JSON.', 'request_options'); }
  const provider = {
    id: model.providerId, type: rowString(modelRow.rows[0], 'type') as Provider['type'], displayName: rowString(modelRow.rows[0], 'provider_display_name'),
    baseUrl: rowString(modelRow.rows[0], 'base_url'), credentialRef: String(credentialRef), requestOptions, enabled: booleanValue(modelRow.rows[0], 'provider_enabled'),
    revision: numberValue(modelRow.rows[0], 'provider_revision'), createdAt: rowString(modelRow.rows[0], 'provider_created_at'), updatedAt: rowString(modelRow.rows[0], 'provider_updated_at'),
  } satisfies Provider;
  if (!provider.baseUrl || !model.modelIdentifier) throw new ControlPlaneError('provider_unavailable', 'Configured provider model is incomplete.', 'provider_model_id');
  let outputBudget;
  try { outputBudget = resolveOutputBudget(requestOptions); }
  catch (error) { throw new ControlPlaneError('invalid_configuration', (error as Error).message, (error as { field?: string }).field ?? 'request_options'); }
  const outputContract = outputContractForTemplate(executionType);
  const parts = effectiveParts(prompts, skills);
  for (const part of parts) {
    if (part.kind === 'prompt') {
      validateTemplate(part.asset.content, { templateType: executionType, role: part.asset.role });
      if (outputContract.kind === 'strict_json' && part.asset.role === 'human-readable-output') {
        throw new ControlPlaneError('incompatible_output_contract', 'Human-readable output Prompt cannot be bound to a strict JSON template.', 'prompt_binding');
      }
    }
  }
  const snapshot: CommandSnapshot = {
    schema_version: COMMAND_SNAPSHOT_SCHEMA_VERSION, snapshot_id: `snap-${createId()}`, snapshot_origin: 'control_plane', execution_id: input.executionId,
    repository: { id: repository.id, full_name: repository.fullNameNormalized }, target: input.kind, template_type: executionType,
    ...(input.kind === 'command' ? { command: { id: loaded.target!.id, slash_name: loaded.target!.slashName, revision: loaded.target!.revision,
      execution_type: loaded.target!.executionType, permission: loaded.target!.permission, enabled: loaded.target!.enabled } } :
      { conversation_profile: { id: loaded.profile!.id, revision: loaded.profile!.revision, permission: 'read_only' as const, enabled: loaded.profile!.enabled } }),
    composition: { output_contract: { kind: outputContract.kind, ...(outputContract.schemaId ? { schema_id: outputContract.schemaId } : {}) }, parts: parts.map((part, index) => snapshotPart(part, index + 1)) },
    output_budget: { requested: outputBudget.requested, effective: outputBudget.effective, source: outputBudget.source, wire_key: outputBudget.wireKey,
      ...(outputBudget.capability === undefined ? {} : { capability: outputBudget.capability }) },
    provider: { id: provider.id, type: provider.type, display_name: provider.displayName, base_url: provider.baseUrl, revision: provider.revision,
      credential_ref: provider.credentialRef, model: { id: model.id, identifier: model.modelIdentifier, display_name: model.displayName, revision: model.revision }, request_options: provider.requestOptions },
    toolset_version: TOOLSET_VERSION, snapshot_created_at: isoNow(),
  };
  validateCommandSnapshot(snapshot);
  const effective = effectiveParts(prompts, skills);
  return { executionId: input.executionId, target: input.kind, ...(input.kind === 'command' ? { command: { id: loaded.target!.id, slashName: loaded.target!.slashName, revision: loaded.target!.revision } } : { conversationProfile: { id: loaded.profile!.id, revision: loaded.profile!.revision } }),
    executionType, permission, outputContract, provider, model, prompts: effective.filter(value => value.kind === 'prompt').map(value => value.asset),
    skills: effective.filter(value => value.kind === 'skill').map(value => value.asset), snapshot };
}

export async function resolveExecution(db: ControlPlaneDb, input: ResolveInput) {
  return db.readTransaction(transaction => resolveInTransaction(transaction, input));
}

export const resolveCommand = resolveExecution;
export const resolveEffectiveConfiguration = resolveExecution;

export async function previewEffectiveConfiguration(db: ControlPlaneDb, input: ResolveInput) {
  return resolveExecution(db, input);
}

export async function validateEffectiveConfiguration(db: ControlPlaneDb, input: ResolveInput) {
  try { return { valid: true as const, resolved: await resolveExecution(db, input), errors: [] as never[] }; }
  catch (error) {
    if (error instanceof ControlPlaneError) return { valid: false as const, resolved: undefined, errors: [{ code: error.code, message: error.message, field: error.field }] };
    throw error;
  }
}
