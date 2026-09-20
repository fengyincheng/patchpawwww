import type { Row } from '@libsql/client';
import { ControlPlaneDb, booleanValue, isoNow, numberValue, rowValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound } from './errors.ts';
import { assertBindingPositions, bumpRepository, createId, putMarker, normalizeCommandName } from './common.ts';
import { requireRepository } from './repositories.ts';
import { getProviderModel } from './providers.ts';
import type { Command, CommandInput, ConversationProfile, ConversationProfileInput, Permission, PromptBinding, SkillBinding } from './types.ts';

function promptBindingFromRow(row: Row): PromptBinding {
  return { assetId: textValue(row, 'prompt_asset_id'), position: numberValue(row, 'position'), enabled: booleanValue(row, 'enabled'), bindingKind: textValue(row, 'binding_kind') as PromptBinding['bindingKind'] };
}

function skillBindingFromRow(row: Row): SkillBinding {
  return { assetId: textValue(row, 'skill_asset_id'), position: numberValue(row, 'position'), enabled: booleanValue(row, 'enabled') };
}

function commandBaseFromRow(row: Row): Omit<Command, 'promptBindings' | 'skillBindings'> {
  return { id: textValue(row, 'id'), repositoryId: textValue(row, 'repository_id'), slashName: textValue(row, 'slash_name'),
    displayName: textValue(row, 'display_name'), description: textValue(row, 'description'), executionType: textValue(row, 'execution_type') as Command['executionType'],
    permission: textValue(row, 'permission') as Permission, providerModelId: textValue(row, 'provider_model_id'), enabled: booleanValue(row, 'enabled'),
    revision: numberValue(row, 'revision'), createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at') };
}

function profileBaseFromRow(row: Row): Omit<ConversationProfile, 'promptBindings' | 'skillBindings'> {
  return { id: textValue(row, 'id'), repositoryId: textValue(row, 'repository_id'), displayName: textValue(row, 'display_name'),
    providerModelId: textValue(row, 'provider_model_id'), enabled: booleanValue(row, 'enabled'), revision: numberValue(row, 'revision'),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at') };
}

async function loadCommandBindings(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, commandId: string) {
  const [prompts, skills] = await Promise.all([
    executor.execute('SELECT * FROM command_prompts WHERE command_id = :id ORDER BY position', { id: commandId }),
    executor.execute('SELECT * FROM command_skills WHERE command_id = :id ORDER BY position', { id: commandId }),
  ]);
  return { promptBindings: prompts.rows.map(promptBindingFromRow), skillBindings: skills.rows.map(skillBindingFromRow) };
}

async function loadProfileBindings(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, profileId: string) {
  const [prompts, skills] = await Promise.all([
    executor.execute('SELECT * FROM profile_prompts WHERE profile_id = :id ORDER BY position', { id: profileId }),
    executor.execute('SELECT * FROM profile_skills WHERE profile_id = :id ORDER BY position', { id: profileId }),
  ]);
  return { promptBindings: prompts.rows.map(promptBindingFromRow), skillBindings: skills.rows.map(skillBindingFromRow) };
}

async function validateModelInTransaction(transaction: ControlPlaneTransaction, modelId: string) {
  const result = await transaction.execute(`SELECT m.id FROM provider_models m JOIN providers p ON p.id = m.provider_id
    WHERE m.id = :id AND m.enabled = 1 AND p.enabled = 1`, { id: modelId });
  if (!result.rows[0]) throw new ControlPlaneError('invalid_configuration', `Provider model is missing or disabled: ${modelId}`, 'provider_model_id');
}

async function validatePromptBindings(transaction: ControlPlaneTransaction, repositoryId: string, bindings: PromptBinding[] | undefined) {
  if (!bindings) return;
  assertBindingPositions(bindings.map(binding => binding.position), 'prompt binding');
  if (new Set(bindings.map(binding => binding.assetId)).size !== bindings.length) throw new ControlPlaneError('binding_conflict', 'A prompt cannot be bound twice to one target.');
  for (const binding of bindings) {
    const result = await transaction.execute(`SELECT repository_id, scope, enabled FROM prompt_assets WHERE id = :id`, { id: binding.assetId });
    const row = result.rows[0];
    if (!row || String(row.scope) !== 'repository' || String(row.repository_id) !== repositoryId) throw new ControlPlaneError('invalid_configuration', `Prompt binding must reference a repository copy: ${binding.assetId}`);
    if (binding.enabled && Number(row.enabled) !== 1) throw new ControlPlaneError('required_binding', `Cannot enable a disabled prompt asset: ${binding.assetId}`);
  }
}

async function validateSkillBindings(transaction: ControlPlaneTransaction, repositoryId: string, bindings: SkillBinding[] | undefined) {
  if (!bindings) return;
  assertBindingPositions(bindings.map(binding => binding.position), 'skill binding');
  if (new Set(bindings.map(binding => binding.assetId)).size !== bindings.length) throw new ControlPlaneError('binding_conflict', 'A skill cannot be bound twice to one target.');
  for (const binding of bindings) {
    const result = await transaction.execute(`SELECT repository_id, scope, enabled FROM skill_assets WHERE id = :id`, { id: binding.assetId });
    const row = result.rows[0];
    if (!row || String(row.scope) !== 'repository' || String(row.repository_id) !== repositoryId) throw new ControlPlaneError('invalid_configuration', `Skill binding must reference a repository copy: ${binding.assetId}`);
    if (binding.enabled && Number(row.enabled) !== 1) throw new ControlPlaneError('required_binding', `Cannot enable a disabled skill asset: ${binding.assetId}`);
  }
}

function validateCommandCombination(input: Pick<CommandInput, 'executionType' | 'permission'>) {
  // Execution type describes task semantics. Permission describes workspace
  // capability lifecycle and is intentionally independent: read_write_approval
  // is valid for any task that has a plan-mode binding.
  void input;
}

function requireMainPrompt(bindings: PromptBinding[] | undefined, enabled: boolean) {
  if (enabled && !(bindings ?? []).some(binding => binding.enabled && binding.bindingKind === 'main')) throw new ControlPlaneError('required_binding', 'An enabled command requires an enabled main prompt binding.');
}

export async function getCommand(db: ControlPlaneDb, id: string) {
  const result = await db.execute('SELECT * FROM commands WHERE id = :id', { id });
  if (!result.rows[0]) return undefined;
  return { ...commandBaseFromRow(result.rows[0]), ...(await loadCommandBindings(db, id)) } as Command;
}

export async function listCommands(db: ControlPlaneDb, repositoryId: string) {
  await requireRepository(db, repositoryId);
  const result = await db.execute('SELECT * FROM commands WHERE repository_id = :repository_id ORDER BY slash_name', { repository_id: repositoryId });
  return Promise.all(result.rows.map(async row => ({ ...commandBaseFromRow(row), ...(await loadCommandBindings(db, String(row.id))) } as Command)));
}

export async function getCommandByName(db: ControlPlaneDb, repositoryId: string, slashName: string) {
  const name = slashName.trim().replace(/^\/+/, '').toLowerCase();
  const result = await db.execute('SELECT * FROM commands WHERE repository_id = :repository_id AND slash_name = :slash_name', { repository_id: repositoryId, slash_name: name });
  if (!result.rows[0]) return undefined;
  return { ...commandBaseFromRow(result.rows[0]), ...(await loadCommandBindings(db, String(result.rows[0].id))) } as Command;
}

async function writeCommandBindings(transaction: ControlPlaneTransaction, commandId: string, repositoryId: string, promptBindings: PromptBinding[], skillBindings: SkillBinding[]) {
  await validatePromptBindings(transaction, repositoryId, promptBindings);
  await validateSkillBindings(transaction, repositoryId, skillBindings);
  await transaction.execute('DELETE FROM command_prompts WHERE command_id = :id', { id: commandId });
  await transaction.execute('DELETE FROM command_skills WHERE command_id = :id', { id: commandId });
  for (const binding of promptBindings) await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
    VALUES (:command_id, :asset_id, :position, :enabled, :binding_kind)`, { command_id: commandId, asset_id: binding.assetId, position: binding.position, enabled: binding.enabled ? 1 : 0, binding_kind: binding.bindingKind });
  for (const binding of skillBindings) await transaction.execute(`INSERT INTO command_skills(command_id, skill_asset_id, position, enabled)
    VALUES (:command_id, :asset_id, :position, :enabled)`, { command_id: commandId, asset_id: binding.assetId, position: binding.position, enabled: binding.enabled ? 1 : 0 });
}

export async function createCommand(db: ControlPlaneDb, input: CommandInput) {
  validateCommandCombination(input);
  const slashName = normalizeCommandName(input.slashName);
  const enabled = input.enabled ?? true;
  const promptBindings = input.promptBindings ?? [];
  const skillBindings = input.skillBindings ?? [];
  requireMainPrompt(promptBindings, enabled);
  await requireRepository(db, input.repositoryId);
  const now = isoNow();
  const command: Command = { id: createId(), repositoryId: input.repositoryId, slashName, displayName: input.displayName.trim() || slashName,
    description: input.description?.trim() ?? '', executionType: input.executionType, permission: input.permission, providerModelId: input.providerModelId,
    enabled, revision: 1, promptBindings, skillBindings, createdAt: now, updatedAt: now };
  try {
    await db.transaction(async transaction => {
      await validateModelInTransaction(transaction, command.providerModelId);
      await transaction.execute(`INSERT INTO commands(
        id, repository_id, slash_name, display_name, description, execution_type, permission, provider_model_id, enabled, revision, created_at, updated_at
      ) VALUES (:id, :repository_id, :slash_name, :display_name, :description, :execution_type, :permission, :provider_model_id, :enabled, :revision, :created_at, :updated_at)`, {
        id: command.id, repository_id: command.repositoryId, slash_name: command.slashName, display_name: command.displayName, description: command.description,
        execution_type: command.executionType, permission: command.permission, provider_model_id: command.providerModelId, enabled: command.enabled ? 1 : 0,
        revision: command.revision, created_at: now, updated_at: now,
      });
      await writeCommandBindings(transaction, command.id, command.repositoryId, promptBindings, skillBindings);
      await bumpRepository(transaction, command.repositoryId);
      await putMarker(transaction, { repositoryId: command.repositoryId, seedKey: `command:${command.slashName}`, resourceKind: 'command', resourceId: command.id,
        sourceDigest: 'manual', sourceRevision: 1, state: 'override' });
    });
  } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Command already exists: ${command.slashName}`, 'slash_name');
    throw error;
  }
  return (await getCommand(db, command.id))!;
}

export async function updateCommand(db: ControlPlaneDb, id: string, patch: Partial<Omit<CommandInput, 'repositoryId'>> & { repositoryId?: string }, options: { expectedRevision?: number } = {}) {
  try { return await db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM commands WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Command', id);
    const current = commandBaseFromRow(result.rows[0]);
    const currentBindings = await loadCommandBindings(transaction, id);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Command');
    if (patch.repositoryId !== undefined && patch.repositoryId !== current.repositoryId) throw new ControlPlaneError('invalid_configuration', 'A command cannot move between repositories.', 'repository_id');
    const next = { repositoryId: current.repositoryId, slashName: patch.slashName === undefined ? current.slashName : normalizeCommandName(patch.slashName),
      displayName: patch.displayName?.trim() || current.displayName, description: patch.description?.trim() ?? current.description,
      executionType: patch.executionType ?? current.executionType, permission: patch.permission ?? current.permission,
      providerModelId: patch.providerModelId ?? current.providerModelId, enabled: patch.enabled ?? current.enabled,
      promptBindings: patch.promptBindings ?? currentBindings.promptBindings, skillBindings: patch.skillBindings ?? currentBindings.skillBindings };
    validateCommandCombination(next);
    requireMainPrompt(next.promptBindings, next.enabled ?? true);
    await validateModelInTransaction(transaction, next.providerModelId);
    await writeCommandBindings(transaction, id, current.repositoryId, next.promptBindings!, next.skillBindings!);
    await transaction.execute(`UPDATE commands SET slash_name = :slash_name, display_name = :display_name, description = :description,
      execution_type = :execution_type, permission = :permission, provider_model_id = :provider_model_id, enabled = :enabled,
      revision = revision + 1, updated_at = :updated_at WHERE id = :id`, { id, slash_name: next.slashName, display_name: next.displayName, description: next.description,
      execution_type: next.executionType, permission: next.permission, provider_model_id: next.providerModelId, enabled: next.enabled ? 1 : 0, updated_at: isoNow() });
    await bumpRepository(transaction, current.repositoryId);
    await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `command:${next.slashName}`, resourceKind: 'command', resourceId: id,
      sourceDigest: 'manual', sourceRevision: current.revision + 1, state: next.enabled ? 'override' : 'disabled' });
    if (next.slashName !== current.slashName) await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `command:${current.slashName}`, resourceKind: 'command', resourceId: id,
      sourceDigest: 'manual', sourceRevision: current.revision, state: 'tombstone' });
    const updated = await transaction.execute('SELECT * FROM commands WHERE id = :id', { id });
    return { ...commandBaseFromRow(updated.rows[0]), ...(await loadCommandBindings(transaction, id)) } as Command;
  }); } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', 'Command slash name already exists in this repository.', 'slash_name');
    throw error;
  }
}

export async function deleteCommand(db: ControlPlaneDb, id: string, options: { expectedRevision?: number } = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM commands WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Command', id);
    const current = commandBaseFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Command');
    await transaction.execute('DELETE FROM commands WHERE id = :id', { id });
    await bumpRepository(transaction, current.repositoryId);
    await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `command:${current.slashName}`, resourceKind: 'command', resourceId: id,
      sourceDigest: 'manual', sourceRevision: current.revision, state: 'tombstone' });
    return true;
  });
}

export async function getConversationProfile(db: ControlPlaneDb, repositoryId: string) {
  const result = await db.execute('SELECT * FROM conversation_profiles WHERE repository_id = :repository_id', { repository_id: repositoryId });
  if (!result.rows[0]) return undefined;
  return { ...profileBaseFromRow(result.rows[0]), ...(await loadProfileBindings(db, String(result.rows[0].id))) } as ConversationProfile;
}

async function writeProfileBindings(transaction: ControlPlaneTransaction, profileId: string, repositoryId: string, promptBindings: PromptBinding[], skillBindings: SkillBinding[]) {
  await validatePromptBindings(transaction, repositoryId, promptBindings);
  await validateSkillBindings(transaction, repositoryId, skillBindings);
  await transaction.execute('DELETE FROM profile_prompts WHERE profile_id = :id', { id: profileId });
  await transaction.execute('DELETE FROM profile_skills WHERE profile_id = :id', { id: profileId });
  for (const binding of promptBindings) await transaction.execute(`INSERT INTO profile_prompts(profile_id, prompt_asset_id, position, enabled, binding_kind)
    VALUES (:profile_id, :asset_id, :position, :enabled, :binding_kind)`, { profile_id: profileId, asset_id: binding.assetId, position: binding.position, enabled: binding.enabled ? 1 : 0, binding_kind: binding.bindingKind });
  for (const binding of skillBindings) await transaction.execute(`INSERT INTO profile_skills(profile_id, skill_asset_id, position, enabled)
    VALUES (:profile_id, :asset_id, :position, :enabled)`, { profile_id: profileId, asset_id: binding.assetId, position: binding.position, enabled: binding.enabled ? 1 : 0 });
}

export async function saveConversationProfile(db: ControlPlaneDb, input: ConversationProfileInput, options: { expectedRevision?: number } = {}) {
  await requireRepository(db, input.repositoryId);
  const promptBindings = input.promptBindings ?? [];
  const skillBindings = input.skillBindings ?? [];
  if (input.enabled === false && !(await getConversationProfile(db, input.repositoryId))) throw new ControlPlaneError('required_binding', 'Every managed repository must retain an active Conversation Profile.');
  if (!(promptBindings.some(binding => binding.enabled && binding.bindingKind === 'main'))) throw new ControlPlaneError('required_binding', 'Conversation profile requires an enabled main prompt binding.');
  const existing = await getConversationProfile(db, input.repositoryId);
  return db.transaction(async transaction => {
    await validateModelInTransaction(transaction, input.providerModelId);
    const now = isoNow();
    if (!existing) {
      const profile: ConversationProfile = { id: createId(), repositoryId: input.repositoryId, displayName: input.displayName.trim() || 'Conversation',
        providerModelId: input.providerModelId, enabled: input.enabled ?? true, revision: 1, promptBindings, skillBindings, createdAt: now, updatedAt: now };
      await transaction.execute(`INSERT INTO conversation_profiles(id, repository_id, display_name, provider_model_id, enabled, revision, created_at, updated_at)
        VALUES (:id, :repository_id, :display_name, :provider_model_id, :enabled, 1, :created_at, :updated_at)`, { id: profile.id, repository_id: profile.repositoryId,
        display_name: profile.displayName, provider_model_id: profile.providerModelId, enabled: profile.enabled ? 1 : 0, created_at: now, updated_at: now });
      await writeProfileBindings(transaction, profile.id, profile.repositoryId, promptBindings, skillBindings);
      await bumpRepository(transaction, profile.repositoryId);
      await putMarker(transaction, { repositoryId: profile.repositoryId, seedKey: 'conversation-profile', resourceKind: 'conversation_profile', resourceId: profile.id,
        sourceDigest: 'manual', sourceRevision: 1, state: 'override' });
      return { ...profile };
    }
    assertExpectedRevision(existing.revision, options.expectedRevision, 'Conversation profile');
    if (existing.enabled && input.enabled === false) throw new ControlPlaneError('required_binding', 'Every managed repository must retain an active Conversation Profile.');
    await transaction.execute(`UPDATE conversation_profiles SET display_name = :display_name, provider_model_id = :provider_model_id,
      enabled = :enabled, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, { id: existing.id, display_name: input.displayName.trim() || existing.displayName,
      provider_model_id: input.providerModelId, enabled: (input.enabled ?? existing.enabled) ? 1 : 0, updated_at: now });
    await writeProfileBindings(transaction, existing.id, existing.repositoryId, promptBindings, skillBindings);
    await bumpRepository(transaction, existing.repositoryId);
    await putMarker(transaction, { repositoryId: existing.repositoryId, seedKey: 'conversation-profile', resourceKind: 'conversation_profile', resourceId: existing.id,
      sourceDigest: 'manual', sourceRevision: existing.revision + 1, state: 'override' });
    const updated = await transaction.execute('SELECT * FROM conversation_profiles WHERE id = :id', { id: existing.id });
    return { ...profileBaseFromRow(updated.rows[0]), ...(await loadProfileBindings(transaction, existing.id)) } as ConversationProfile;
  });
}

export async function findModelForCommand(db: ControlPlaneDb, modelId: string) {
  return getProviderModel(db, modelId);
}

export { commandBaseFromRow, profileBaseFromRow, loadCommandBindings, loadProfileBindings };
