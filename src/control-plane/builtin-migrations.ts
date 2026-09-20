import { ControlPlaneDb, isoNow, numberValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { ControlPlaneError } from './errors.ts';
import { bumpRepository, contentDigest, createId, findMarker, putMarker, repositoryFromRow } from './common.ts';
import { promptFromRow } from './prompts.ts';
import { builtinPromptByRole, builtinPromptBySlug, type BuiltinPromptDefinition } from './builtin-prompts.ts';
import { loadOperationSource } from '../operation/load.ts';
import type { Permission, PromptAsset } from './types.ts';

/**
 * Versioned builtin-asset migrations.
 *
 * These are not schema migrations and not Prompt content sync. A migration here
 * means: "this PatchPaw version introduces a system-known builtin asset or
 * contract that older runtime databases do not have." The contract is narrow:
 *
 * - it never rewrites operator-owned (`override`) content;
 * - it never re-enables a `disabled` asset;
 * - it never resurrects a `tombstone`;
 * - it is idempotent and safe to run automatically during deploy;
 * - it records what it did so an operator can audit a deploy.
 */
export type BuiltinAssetAction =
  | 'created'
  | 'already_present'
  | 'preserved_override'
  | 'preserved_disabled'
  | 'preserved_tombstone'
  | 'converged_legacy'
  | 'conflict'
  | 'skipped'
  | 'binding_added'
  | 'binding_removed'
  | 'binding_present'
  | 'command_permission_converged'
  | 'command_layout_converged';

export interface BuiltinMigrationAction {
  assetKey: string;
  kind: 'prompt' | 'binding' | 'command';
  scope: 'public' | 'repository';
  repositoryId: string | null;
  action: BuiltinAssetAction;
  detail?: string;
}

export interface BuiltinAssetMigrationReport {
  migrationId: string;
  description: string;
  appliedAt: string;
  actions: BuiltinMigrationAction[];
}

export interface BuiltinAssetMigrationOptions {
  /** Directory containing the `operation/*.md` seed files. Defaults to the repository operation root. */
  operationRoot?: string;
  /** Restrict execution to specific migration ids. Used by tooling and tests. */
  only?: readonly string[];
  /** Re-run an already-recorded migration and refresh its report. */
  force?: boolean;
}

interface BuiltinMigrationContext {
  sourceContent(definition: BuiltinPromptDefinition): Promise<string>;
}

interface BuiltinAssetMigration {
  id: string;
  description: string;
  apply(transaction: ControlPlaneTransaction, context: BuiltinMigrationContext): Promise<BuiltinMigrationAction[]>;
}

/**
 * These are exact source versions that PatchPaw itself shipped before the
 * opaque-output lifecycle. They are identity evidence, not Prompt semantics:
 * unknown content is always treated as operator-owned and is never rewritten.
 */
export const KNOWN_LEGACY_BUILTIN_CONTENT_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  review: [
    '1ccaf4590c4a4913d2e95393f71985be4e76b0965b19d992bf274c3578fec559',
    '0aa7e9f1019dcedaf946e707587d18327779a9a6494cc130fe4d9750c30e854d',
  ],
  conflict: [
    'de5ba926f350e6fd0e62a3beda702ae431386507ec9efab93920df044b50888f',
    '4028e5715b4efc9d7105b9366ee063694cf18f3a246e010a8893b53e2b23c9d8',
    '2fd0feaa5ab9308fddbff951d6dac09a39704b125d1448688ce8a3a2a695f608',
  ],
  conversation: ['e9449c847f8274db059441c14e88fa430145c5ca0e8fe822f7708c708fa8f3ba'],
  'ci-repair': ['b1cd7145611e8e7a4cfc30b1cfdeb4b54b9a50c22c0a280c8277a374da7d068a'],
  'repair-completion': ['2386e39b776a4ddc6fcd9c694892a853418de512bc3d7b7c1b9a4547f6226c80'],
  'repair-closeout': ['4537e91542e403f950d127e4f2248bce6053953200ffafe74c6cd28f147806ba'],
  'repair-no-verification': ['2db09ee7493a057911e982853b7a59dc9b9031426e004960c2f4b36a7c98e72c'],
  'repair-verification-empty': ['b2560ec043093774f1576f11df97582737458432649295ad39afef6c71bec4fc'],
  'runtime-budget': ['982cfbc9684c808bc33c6ba483f9bce4d4ca13bd256c0183acd1970e43f5f1b6'],
} as const;

const OPAQUE_OUTPUT_PROMPT_KEYS = [
  'review', 'conflict', 'conversation', 'ci-repair', 'repair-completion',
  'repair-closeout', 'repair-no-verification', 'repair-verification-empty', 'runtime-budget',
] as const;

type BuiltinCommandName = 'review' | 'ci' | 'conflict';
type LayoutBindingKind = 'main' | 'common' | 'auxiliary';

interface CommandLayoutBinding {
  role: string;
  bindingKind: LayoutBindingKind;
}

interface CommandLayoutVariant {
  id: string;
  permission: Permission | 'any';
  bindings: readonly CommandLayoutBinding[];
}

interface BuiltinCommandLayout {
  current: (permission: string) => CommandLayoutVariant;
  historical: readonly CommandLayoutVariant[];
}

const binding = (role: string, bindingKind: LayoutBindingKind): CommandLayoutBinding => ({ role, bindingKind });

function currentPermission(value: string): Permission {
  if (value === 'read_only' || value === 'read_write' || value === 'read_write_approval') return value;
  return 'read_write';
}

/**
 * Command composition is versioned data, not an anonymous role array. The
 * historical variants explicitly preserve both deployed approval-aware tails:
 * `shared → plan-mode` from older bootstrap and `plan-mode → shared` after the
 * v1 migration. Current layouts put every auxiliary Prompt before the common
 * `shared` Prompt just like fresh bootstrap does.
 */
const BUILTIN_COMMAND_LAYOUTS: Record<BuiltinCommandName, BuiltinCommandLayout> = {
  review: {
    current: permission => ({
      id: `review_current_${currentPermission(permission)}`,
      permission: currentPermission(permission),
      bindings: [
        binding('review', 'main'), binding('stop-closeout', 'auxiliary'),
        ...(permission === 'read_write_approval' ? [binding('plan-mode', 'auxiliary')] : []),
        binding('shared', 'common'),
      ],
    }),
    historical: [
      { id: 'review_v1_json_retry', permission: 'any', bindings: [
        binding('review', 'main'), binding('review-json-retry', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('shared', 'common'),
      ] },
      { id: 'review_v1_json_retry_with_plan_mode_tail', permission: 'read_write_approval', bindings: [
        binding('review', 'main'), binding('review-json-retry', 'auxiliary'), binding('stop-closeout', 'auxiliary'),
        binding('shared', 'common'), binding('plan-mode', 'auxiliary'),
      ] },
    ],
  },
  ci: {
    current: permission => ({
      id: `ci_current_${currentPermission(permission)}`,
      permission: currentPermission(permission),
      bindings: [
        binding('ci-repair', 'main'), binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'),
        ...(permission === 'read_write_approval' ? [binding('plan-mode', 'auxiliary')] : []),
        binding('shared', 'common'),
      ],
    }),
    historical: [
      { id: 'ci_v1_verification', permission: 'read_write', bindings: [
        binding('ci-repair', 'main'), binding('repair-completion', 'auxiliary'), binding('repair-feedback', 'auxiliary'),
        binding('repair-no-verification', 'auxiliary'), binding('repair-verification-empty', 'auxiliary'),
        binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('shared', 'common'),
      ] },
      { id: 'ci_v1_verification_with_plan_mode_tail', permission: 'read_write_approval', bindings: [
        binding('ci-repair', 'main'), binding('repair-completion', 'auxiliary'), binding('repair-feedback', 'auxiliary'),
        binding('repair-no-verification', 'auxiliary'), binding('repair-verification-empty', 'auxiliary'),
        binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('shared', 'common'),
        binding('plan-mode', 'auxiliary'),
      ] },
    ],
  },
  conflict: {
    current: permission => ({
      id: `conflict_current_${currentPermission(permission)}`,
      permission: currentPermission(permission),
      bindings: [
        binding('conflict', 'main'), binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'),
        ...(permission === 'read_write_approval' ? [binding('plan-mode', 'auxiliary')] : []),
        binding('shared', 'common'),
      ],
    }),
    historical: [
      { id: 'conflict_v1_verification', permission: 'read_write', bindings: [
        binding('conflict', 'main'), binding('repair-completion', 'auxiliary'), binding('repair-feedback', 'auxiliary'),
        binding('repair-no-verification', 'auxiliary'), binding('repair-verification-empty', 'auxiliary'),
        binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('shared', 'common'),
      ] },
      { id: 'conflict_v1_verification_with_plan_mode_tail', permission: 'read_write_approval', bindings: [
        binding('conflict', 'main'), binding('repair-completion', 'auxiliary'), binding('repair-feedback', 'auxiliary'),
        binding('repair-no-verification', 'auxiliary'), binding('repair-verification-empty', 'auxiliary'),
        binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('shared', 'common'),
        binding('plan-mode', 'auxiliary'),
      ] },
      { id: 'conflict_v1_verification_with_plan_mode_before_shared', permission: 'read_write_approval', bindings: [
        binding('conflict', 'main'), binding('repair-completion', 'auxiliary'), binding('repair-feedback', 'auxiliary'),
        binding('repair-no-verification', 'auxiliary'), binding('repair-verification-empty', 'auxiliary'),
        binding('repair-closeout', 'auxiliary'), binding('stop-closeout', 'auxiliary'), binding('plan-mode', 'auxiliary'),
        binding('shared', 'common'),
      ] },
    ],
  },
};

function builtinConflict(message: string): never {
  throw new ControlPlaneError('invalid_configuration', message, 'builtin_asset');
}

async function sourceContent(definition: BuiltinPromptDefinition, operationRoot: string | undefined) {
  return loadOperationSource(definition.source, operationRoot);
}

async function promptBySlug(transaction: ControlPlaneTransaction, scope: PromptAsset['scope'], repositoryId: string | null, slug: string) {
  const result = scope === 'public'
    ? await transaction.execute(`SELECT * FROM prompt_assets WHERE scope = 'public' AND repository_id IS NULL AND slug = :slug`, { slug })
    : await transaction.execute(`SELECT * FROM prompt_assets WHERE scope = 'repository' AND repository_id = :repository_id AND slug = :slug`, { repository_id: repositoryId, slug });
  return result.rows[0] ? promptFromRow(result.rows[0]) : undefined;
}

async function activePromptWithRole(transaction: ControlPlaneTransaction, scope: PromptAsset['scope'], repositoryId: string | null, role: string) {
  const result = scope === 'public'
    ? await transaction.execute(`SELECT * FROM prompt_assets WHERE scope = 'public' AND repository_id IS NULL AND role = :role AND enabled = 1`, { role })
    : await transaction.execute(`SELECT * FROM prompt_assets WHERE scope = 'repository' AND repository_id = :repository_id AND role = :role AND enabled = 1`, { repository_id: repositoryId, role });
  return result.rows[0] ? promptFromRow(result.rows[0]) : undefined;
}

async function insertPublicPrompt(transaction: ControlPlaneTransaction, definition: BuiltinPromptDefinition, content: string) {
  const now = isoNow();
  const id = createId();
  await transaction.execute(`INSERT INTO prompt_assets(
    id, scope, repository_id, slug, title, role, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
  ) VALUES (:id, 'public', NULL, :slug, :title, :role, :content, 1, 1, NULL, NULL, :created_at, :updated_at)`, {
    id, slug: definition.slug, title: definition.slug, role: definition.role, content, created_at: now, updated_at: now,
  });
  await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${definition.slug}`, resourceKind: 'prompt', resourceId: id,
    sourceDigest: contentDigest(content), sourceRevision: 1, state: 'seeded' });
  return { id, scope: 'public' as const, repositoryId: null, slug: definition.slug, title: definition.slug, role: definition.role,
    content, enabled: true, revision: 1, sourcePublicId: null, sourcePublicRevision: null, createdAt: now, updatedAt: now } satisfies PromptAsset;
}

/**
 * Ensure the public builtin Prompt exists under the ownership marker contract.
 * Returns the usable asset, or `undefined` when the operator intentionally made
 * it unavailable (disabled/tombstone). Throws on a contradictory identity.
 */
async function ensurePublicBuiltinPrompt(
  transaction: ControlPlaneTransaction,
  definition: BuiltinPromptDefinition,
  content: string,
  actions: BuiltinMigrationAction[],
) {
  const asset = await promptBySlug(transaction, 'public', null, definition.slug);
  const marker = await findMarker(transaction, null, `public-prompt:${definition.slug}`);
  const record = (action: BuiltinAssetAction, detail?: string) => {
    actions.push({ assetKey: definition.key, kind: 'prompt', scope: 'public', repositoryId: null, action, ...(detail ? { detail } : {}) });
  };

  if (asset) {
    if (!marker) builtinConflict(`Public Prompt "${definition.slug}" exists without an ownership marker; refusing to adopt it.`);
    if (marker.resourceId && marker.resourceId !== asset.id) {
      builtinConflict(`Public Prompt "${definition.slug}" marker points at a different asset; refusing to overwrite.`);
    }
    // Respecting ownership preserves content, not a broken identity. A runtime
    // role is only usable when the asset still matches the registered identity.
    if (asset.role !== definition.role) {
      builtinConflict(`Public Prompt "${definition.slug}" has role "${asset.role ?? 'null'}"; expected "${definition.role}".`);
    }
    if (!asset.enabled || marker.state === 'disabled') { record('preserved_disabled'); return undefined; }
    if (marker.state === 'tombstone') { record('preserved_tombstone'); return undefined; }
    if (marker.state === 'override') { record('preserved_override'); return asset; }
    record('already_present');
    return asset;
  }

  if (marker?.state === 'tombstone') { record('preserved_tombstone'); return undefined; }
  if (marker?.state === 'disabled') { record('preserved_disabled'); return undefined; }
  if (marker?.state === 'override') builtinConflict(`Public Prompt "${definition.slug}" is operator-owned but its asset is missing; refusing to recreate it.`);
  const collision = await activePromptWithRole(transaction, 'public', null, definition.role);
  if (collision) builtinConflict(`Public role "${definition.role}" is already held by "${collision.slug}"; refusing to overwrite it.`);
  const created = await insertPublicPrompt(transaction, definition, content);
  record('created');
  return created;
}

async function ensureRepositoryPlanModeCopy(
  transaction: ControlPlaneTransaction,
  definition: BuiltinPromptDefinition,
  repositoryId: string,
  publicAsset: PromptAsset,
  actions: BuiltinMigrationAction[],
) {
  const record = (action: BuiltinAssetAction, detail?: string) => {
    actions.push({ assetKey: definition.key, kind: 'prompt', scope: 'repository', repositoryId, action, ...(detail ? { detail } : {}) });
  };
  const asset = await promptBySlug(transaction, 'repository', repositoryId, definition.slug);
  const marker = await findMarker(transaction, repositoryId, `prompt:${definition.slug}`);

  if (asset) {
    if (!marker) builtinConflict(`Repository Prompt "${definition.slug}" exists without an ownership marker; refusing to adopt it.`);
    if (marker.resourceId && marker.resourceId !== asset.id) {
      builtinConflict(`Repository Prompt "${definition.slug}" marker points at a different asset; refusing to overwrite.`);
    }
    if (asset.role !== definition.role) {
      builtinConflict(`Repository Prompt "${definition.slug}" has role "${asset.role ?? 'null'}"; expected "${definition.role}".`);
    }
    if (!asset.enabled || marker.state === 'disabled') { record('preserved_disabled'); return undefined; }
    if (marker.state === 'tombstone') { record('preserved_tombstone'); return undefined; }
    if (marker.state === 'override') { record('preserved_override'); return asset; }
    record('already_present');
    return asset;
  }

  if (marker?.state === 'tombstone') { record('preserved_tombstone'); return undefined; }
  if (marker?.state === 'disabled') { record('preserved_disabled'); return undefined; }
  if (marker?.state === 'override') builtinConflict(`Repository Prompt "${definition.slug}" is operator-owned but its asset is missing; refusing to recreate it.`);
  const collision = await activePromptWithRole(transaction, 'repository', repositoryId, definition.role);
  if (collision) builtinConflict(`Repository role "${definition.role}" is already held by "${collision.slug}"; refusing to overwrite it.`);

  const now = isoNow();
  const id = createId();
  await transaction.execute(`INSERT INTO prompt_assets(
    id, scope, repository_id, slug, title, role, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
  ) VALUES (:id, 'repository', :repository_id, :slug, :title, :role, :content, 1, 1, :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
    id, repository_id: repositoryId, slug: definition.slug, title: publicAsset.title, role: definition.role, content: publicAsset.content,
    source_public_id: publicAsset.id, source_public_revision: publicAsset.revision, created_at: now, updated_at: now,
  });
  await putMarker(transaction, { repositoryId, seedKey: `prompt:${definition.slug}`, resourceKind: 'prompt', resourceId: id,
    sourceDigest: contentDigest(publicAsset.content), sourceRevision: publicAsset.revision, state: 'seeded' });
  await bumpRepository(transaction, repositoryId);
  record('created');
  return { id, scope: 'repository' as const, repositoryId, slug: definition.slug, title: publicAsset.title, role: definition.role,
    content: publicAsset.content, enabled: true, revision: 1, sourcePublicId: publicAsset.id, sourcePublicRevision: publicAsset.revision,
    createdAt: now, updatedAt: now } satisfies PromptAsset;
}

async function repositoryPromptsBySlug(transaction: ControlPlaneTransaction, repositoryId: string, slug: string) {
  const result = await transaction.execute(`SELECT * FROM prompt_assets
    WHERE scope = 'repository' AND repository_id = :repository_id AND slug = :slug`, { repository_id: repositoryId, slug });
  return result.rows.map(promptFromRow);
}

async function convergeKnownLegacyPrompt(
  transaction: ControlPlaneTransaction,
  definition: BuiltinPromptDefinition,
  content: string,
  asset: PromptAsset,
  actions: BuiltinMigrationAction[],
) {
  const repositoryId = asset.repositoryId;
  const marker = await findMarker(transaction, repositoryId, repositoryId === null ? `public-prompt:${definition.slug}` : `prompt:${definition.slug}`);
  const record = (action: BuiltinAssetAction, detail?: string) => {
    actions.push({ assetKey: definition.key, kind: 'prompt', scope: asset.scope, repositoryId, action, ...(detail ? { detail } : {}) });
  };

  if (!marker) builtinConflict(`${asset.scope === 'public' ? 'Public' : 'Repository'} Prompt "${definition.slug}" exists without an ownership marker; refusing to adopt it.`);
  if (marker.resourceId && marker.resourceId !== asset.id) builtinConflict(`Prompt "${definition.slug}" marker points at a different asset; refusing to overwrite.`);
  if (asset.role !== definition.role) builtinConflict(`Prompt "${definition.slug}" has role "${asset.role ?? 'null'}"; expected "${definition.role}".`);
  if (!asset.enabled || marker.state === 'disabled') { record('preserved_disabled'); return; }
  if (marker.state === 'tombstone') { record('preserved_tombstone'); return; }

  const currentDigest = contentDigest(asset.content);
  const targetDigest = contentDigest(content);
  if (currentDigest === targetDigest) { record('already_present'); return; }
  if (!(KNOWN_LEGACY_BUILTIN_CONTENT_DIGESTS[definition.key] ?? []).includes(currentDigest)) {
    record(marker.state === 'override' ? 'preserved_override' : 'skipped', 'content digest is not a PatchPaw-known legacy version');
    return;
  }

  await transaction.execute(`UPDATE prompt_assets SET content = :content, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
    id: asset.id, content, updated_at: isoNow(),
  });
  if (repositoryId) await bumpRepository(transaction, repositoryId);
  await putMarker(transaction, { repositoryId, seedKey: repositoryId === null ? `public-prompt:${definition.slug}` : `prompt:${definition.slug}`,
    resourceKind: 'prompt', resourceId: asset.id, sourceDigest: targetDigest, sourceRevision: marker.sourceRevision, state: marker.state });
  record('converged_legacy', `${currentDigest} → ${targetDigest}`);
}

function hasExactLayout(
  rows: Array<{ role: string; slug: string; position: number; bindingKind: string; bindingEnabled: boolean; assetEnabled: boolean }>,
  layout: CommandLayoutVariant,
) {
  if (rows.length !== layout.bindings.length || rows.some(row => !row.bindingEnabled || !row.assetEnabled)) return false;
  return rows.every((row, index) => {
    const expected = layout.bindings[index];
    const definition = builtinPromptByRole(expected.role);
    return row.position === index + 1
      && row.role === expected.role
      && row.bindingKind === expected.bindingKind
      && definition?.role === row.role
      && definition.slug === row.slug
      && builtinPromptBySlug(row.slug)?.role === expected.role;
  });
}

async function convergeLegacyCommandLayout(
  transaction: ControlPlaneTransaction,
  repositoryId: string,
  commandName: keyof typeof BUILTIN_COMMAND_LAYOUTS,
  actions: BuiltinMigrationAction[],
) {
  const layout = BUILTIN_COMMAND_LAYOUTS[commandName];
  const commandResult = await transaction.execute(`SELECT id, permission, revision FROM commands
    WHERE repository_id = :repository_id AND slash_name = :slash_name`, { repository_id: repositoryId, slash_name: commandName });
  const command = commandResult.rows[0];
  if (!command) return;
  const bindingResult = await transaction.execute(`SELECT b.prompt_asset_id AS asset_id, b.position,
      b.enabled AS binding_enabled, b.binding_kind, p.slug, p.role, p.enabled AS asset_enabled
    FROM command_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id
    WHERE b.command_id = :command_id ORDER BY b.position`, { command_id: String(command.id) });
  const rows = bindingResult.rows.map(row => ({
    assetId: String(row.asset_id), position: numberValue(row, 'position'), bindingEnabled: numberValue(row, 'binding_enabled') === 1,
    bindingKind: textValue(row, 'binding_kind'), slug: textValue(row, 'slug'), role: textValue(row, 'role'), assetEnabled: numberValue(row, 'asset_enabled') === 1,
  }));
  const permission = textValue(command, 'permission');
  const legacyLayout = layout.historical.find(candidate =>
    (candidate.permission === 'any' || candidate.permission === permission) && hasExactLayout(rows, candidate));
  if (!legacyLayout) return;

  const marker = await findMarker(transaction, repositoryId, `command:${commandName}`);
  if (!marker) builtinConflict(`Built-in /${commandName} has no ownership marker; refusing to rewrite its Prompt bindings.`);
  if (marker.resourceId && marker.resourceId !== String(command.id)) builtinConflict(`Built-in /${commandName} marker points at a different command; refusing to rewrite it.`);
  if (marker.state === 'disabled' || marker.state === 'tombstone') {
    actions.push({ assetKey: commandName, kind: 'command', scope: 'repository', repositoryId, action: 'skipped', detail: `/${commandName} is ${marker.state}` });
    return;
  }

  const targetLayout = layout.current(permission);
  const targetAssets = new Map<string, PromptAsset>();
  for (const targetBinding of targetLayout.bindings) {
    const role = targetBinding.role;
    const definition = builtinPromptByRole(role);
    const asset = await activePromptWithRole(transaction, 'repository', repositoryId, role);
    if (!definition || !definition.newRuns || !asset || builtinPromptBySlug(asset.slug)?.slug !== definition.slug || builtinPromptBySlug(asset.slug)?.role !== role) {
      actions.push({ assetKey: commandName, kind: 'command', scope: 'repository', repositoryId, action: 'skipped', detail: `required active Prompt role is unavailable: ${role}` });
      return;
    }
    targetAssets.set(role, asset);
  }

  const targetBindings = targetLayout.bindings.map((targetBinding, index) => {
    const asset = targetAssets.get(targetBinding.role);
    if (!asset) builtinConflict(`required active Prompt role is unavailable: ${targetBinding.role}`);
    return { asset, position: index + 1, bindingKind: targetBinding.bindingKind };
  });
  await transaction.execute('DELETE FROM command_prompts WHERE command_id = :command_id', { command_id: String(command.id) });
  for (const binding of targetBindings) {
    await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
      VALUES (:command_id, :prompt_asset_id, :position, 1, :binding_kind)`, { command_id: String(command.id), prompt_asset_id: binding.asset.id,
      position: binding.position, binding_kind: binding.bindingKind });
  }
  await transaction.execute(`UPDATE commands SET revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
    id: String(command.id), updated_at: isoNow(),
  });
  await bumpRepository(transaction, repositoryId);
  const finalCommand = await transaction.execute('SELECT revision FROM commands WHERE id = :id', { id: String(command.id) });
  const allBound = await transaction.execute('SELECT prompt_asset_id FROM command_prompts WHERE command_id = :id ORDER BY position', { id: String(command.id) });
  await putMarker(transaction, { repositoryId, seedKey: `command:${commandName}`, resourceKind: 'command', resourceId: String(command.id),
    sourceDigest: contentDigest(allBound.rows.map(row => String(row.prompt_asset_id)).join(':')), sourceRevision: numberValue(finalCommand.rows[0], 'revision'), state: marker.state });
  const currentRoles = new Set(targetLayout.bindings.map(targetBinding => targetBinding.role));
  for (const legacyBinding of legacyLayout.bindings) {
    if (!currentRoles.has(legacyBinding.role)) actions.push({ assetKey: commandName, kind: 'binding', scope: 'repository', repositoryId, action: 'binding_removed', detail: legacyBinding.role });
  }
  actions.push({ assetKey: commandName, kind: 'command', scope: 'repository', repositoryId, action: 'command_layout_converged', detail: `${legacyLayout.id} → ${targetLayout.id}` });
}

const OPAQUE_OUTPUT_MIGRATION: BuiltinAssetMigration = {
  id: 'builtin-assets-v2-opaque-output',
  description: 'Converge known legacy Prompt bodies and command bindings to the opaque-output new-run contract.',
  async apply(transaction, context) {
    const actions: BuiltinMigrationAction[] = [];
    for (const key of OPAQUE_OUTPUT_PROMPT_KEYS) {
      const definition = builtinPromptBySlug(key);
      if (!definition) builtinConflict(`The ${key} Prompt is missing from the builtin registry.`);
      const content = await context.sourceContent(definition);
      const publicAsset = await promptBySlug(transaction, 'public', null, definition.slug);
      if (publicAsset) await convergeKnownLegacyPrompt(transaction, definition, content, publicAsset, actions);
      const repositories = await transaction.execute('SELECT id FROM repositories ORDER BY full_name_normalized');
      for (const row of repositories.rows) {
        const repositoryId = String(row.id);
        for (const asset of await repositoryPromptsBySlug(transaction, repositoryId, definition.slug)) {
          await convergeKnownLegacyPrompt(transaction, definition, content, asset, actions);
        }
      }
    }
    const repositories = await transaction.execute('SELECT id FROM repositories ORDER BY full_name_normalized');
    for (const row of repositories.rows) {
      const repositoryId = String(row.id);
      await convergeLegacyCommandLayout(transaction, repositoryId, 'review', actions);
      await convergeLegacyCommandLayout(transaction, repositoryId, 'ci', actions);
      await convergeLegacyCommandLayout(transaction, repositoryId, 'conflict', actions);
    }
    return actions;
  },
};

/** Narrowly converge the system-owned built-in /conflict command; never touch operator-owned commands. */
async function convergeSeededConflictCommand(
  transaction: ControlPlaneTransaction,
  repositoryId: string,
  definition: BuiltinPromptDefinition,
  planMode: PromptAsset,
  command: { id: string; permission: string },
  actions: BuiltinMigrationAction[],
) {
  const record = (kind: 'command' | 'binding', action: BuiltinAssetAction, detail?: string) => {
    actions.push({ assetKey: definition.key, kind, scope: 'repository', repositoryId, action, ...(detail ? { detail } : {}) });
  };
  const bindings = await transaction.execute(`SELECT b.prompt_asset_id AS asset_id, b.position, b.enabled AS binding_enabled, b.binding_kind, p.role, p.enabled AS asset_enabled
    FROM command_prompts b JOIN prompt_assets p ON p.id = b.prompt_asset_id WHERE b.command_id = :id`, { id: command.id });
  const planModeRows = bindings.rows.filter(row => String(row.role ?? '') === definition.role);
  const activePlanMode = planModeRows.some(row => numberValue(row, 'binding_enabled') === 1 && numberValue(row, 'asset_enabled') === 1);

  if (planModeRows.length > 0 && !activePlanMode) {
    // An operator disabled the binding or the Prompt. That intent is ambiguous,
    // so do not silently enable it and do not converge the permission into a
    // state the resolver would reject.
    record('binding', 'skipped', 'inactive plan-mode binding preserved');
    return;
  }
  const permissionNeedsChange = command.permission === 'read_write';
  const bindingNeedsChange = planModeRows.length === 0;
  if (!permissionNeedsChange && !bindingNeedsChange) { record('binding', 'binding_present'); return; }

  if (permissionNeedsChange) {
    await transaction.execute(`UPDATE commands SET permission = 'read_write_approval', revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
      id: command.id, updated_at: isoNow(),
    });
    record('command', 'command_permission_converged', 'read_write → read_write_approval');
  }
  if (bindingNeedsChange) {
    const existingBindings = bindings.rows
      .map(row => ({ assetId: textValue(row, 'asset_id'), position: numberValue(row, 'position'), enabled: numberValue(row, 'binding_enabled'), bindingKind: textValue(row, 'binding_kind'), role: textValue(row, 'role') }))
      .sort((left, right) => left.position - right.position);
    const commonIndex = existingBindings.findIndex(row => row.bindingKind === 'common');
    const nextBindings = [...existingBindings];
    nextBindings.splice(commonIndex < 0 ? nextBindings.length : commonIndex, 0, {
      assetId: planMode.id, position: 0, enabled: 1, bindingKind: 'auxiliary', role: definition.role,
    });
    await transaction.execute('DELETE FROM command_prompts WHERE command_id = :id', { id: command.id });
    for (const [index, binding] of nextBindings.entries()) {
      await transaction.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
        VALUES (:command_id, :prompt_asset_id, :position, :enabled, :binding_kind)`, {
        command_id: command.id, prompt_asset_id: binding.assetId, position: index + 1, enabled: binding.enabled,
        binding_kind: binding.bindingKind,
      });
    }
    record('binding', 'binding_added');
  }
  // Converge command/repository revision and the ownership marker exactly once,
  // from the state actually written, so marker.sourceRevision can never drift.
  if (bindingNeedsChange && !permissionNeedsChange) {
    await transaction.execute('UPDATE commands SET revision = revision + 1, updated_at = :updated_at WHERE id = :id', { id: command.id, updated_at: isoNow() });
  }
  await bumpRepository(transaction, repositoryId);
  const finalCommand = await transaction.execute('SELECT revision FROM commands WHERE id = :id', { id: command.id });
  const allBound = await transaction.execute('SELECT prompt_asset_id FROM command_prompts WHERE command_id = :id ORDER BY position', { id: command.id });
  await putMarker(transaction, { repositoryId, seedKey: 'command:conflict', resourceKind: 'command', resourceId: command.id,
    sourceDigest: contentDigest(allBound.rows.map(row => String(row.prompt_asset_id)).join(':')),
    sourceRevision: numberValue(finalCommand.rows[0], 'revision'), state: 'seeded' });
}

const PLAN_MODE_MIGRATION: BuiltinAssetMigration = {
  id: 'builtin-assets-v1-plan-mode',
  description: 'Install the plan-mode lifecycle Prompt and converge the system-owned read_write_approval contract.',
  async apply(transaction, context) {
    const definition = builtinPromptBySlug('plan-mode');
    if (!definition) builtinConflict('The plan-mode Prompt is missing from the builtin registry.');
    const actions: BuiltinMigrationAction[] = [];
    const content = await context.sourceContent(definition);
    const publicAsset = await ensurePublicBuiltinPrompt(transaction, definition, content, actions);
    if (!publicAsset) {
      actions.push({ assetKey: definition.key, kind: 'command', scope: 'repository', repositoryId: null, action: 'skipped',
        detail: 'public plan-mode Prompt is unavailable' });
      return actions;
    }
    const repositories = await transaction.execute('SELECT * FROM repositories ORDER BY full_name_normalized');
    for (const row of repositories.rows) {
      const repository = repositoryFromRow(row);
      // Only a repository whose built-in /conflict is still PatchPaw-owned gets a
      // repository copy/binding. A repository without that command, or with an
      // operator-owned one, keeps its configuration untouched (section 12.2).
      const commandResult = await transaction.execute(`SELECT * FROM commands
        WHERE repository_id = :repository_id AND slash_name = 'conflict'`, { repository_id: repository.id });
      if (!commandResult.rows[0]) {
        actions.push({ assetKey: definition.key, kind: 'command', scope: 'repository', repositoryId: repository.id, action: 'skipped',
          detail: 'no built-in /conflict command' });
        continue;
      }
      const commandMarker = await findMarker(transaction, repository.id, 'command:conflict');
      if (commandMarker?.state !== 'seeded') {
        actions.push({ assetKey: definition.key, kind: 'command', scope: 'repository', repositoryId: repository.id,
          action: 'preserved_override', detail: 'operator-owned /conflict' });
        continue;
      }
      const planMode = await ensureRepositoryPlanModeCopy(transaction, definition, repository.id, publicAsset, actions);
      if (!planMode) {
        actions.push({ assetKey: definition.key, kind: 'command', scope: 'repository', repositoryId: repository.id, action: 'skipped',
          detail: 'repository plan-mode Prompt is unavailable' });
        continue;
      }
      await convergeSeededConflictCommand(transaction, repository.id, definition, planMode, {
        id: String(commandResult.rows[0].id), permission: String(commandResult.rows[0].permission),
      }, actions);
    }
    return actions;
  },
};

export const BUILTIN_ASSET_MIGRATIONS: readonly BuiltinAssetMigration[] = [PLAN_MODE_MIGRATION, OPAQUE_OUTPUT_MIGRATION];

export const BUILTIN_ASSET_MIGRATION_IDS = BUILTIN_ASSET_MIGRATIONS.map(migration => migration.id);

async function loadApplied(transaction: ControlPlaneTransaction, id: string) {
  const result = await transaction.execute('SELECT id FROM builtin_asset_migrations WHERE id = :id', { id });
  return Boolean(result.rows[0]);
}

/**
 * Apply every pending builtin-asset migration in order. Already-recorded
 * migrations are skipped; `force` re-runs them to prove idempotency.
 */
export async function runBuiltinAssetMigrations(db: ControlPlaneDb, options: BuiltinAssetMigrationOptions = {}): Promise<BuiltinAssetMigrationReport[]> {
  const context: BuiltinMigrationContext = { sourceContent: definition => sourceContent(definition, options.operationRoot) };
  return db.transaction(async transaction => {
    const reports: BuiltinAssetMigrationReport[] = [];
    for (const migration of BUILTIN_ASSET_MIGRATIONS) {
      if (options.only && !options.only.includes(migration.id)) continue;
      if (!options.force && await loadApplied(transaction, migration.id)) continue;
      const actions = await migration.apply(transaction, context);
      const report: BuiltinAssetMigrationReport = { migrationId: migration.id, description: migration.description, appliedAt: isoNow(), actions };
      await transaction.execute(`INSERT INTO builtin_asset_migrations(id, applied_at, report_json) VALUES (:id, :applied_at, :report_json)
        ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at, report_json = excluded.report_json`, {
        id: migration.id, applied_at: report.appliedAt, report_json: JSON.stringify(report),
      });
      reports.push(report);
    }
    return reports;
  });
}

export async function listBuiltinAssetMigrations(db: ControlPlaneDb) {
  const result = await db.execute('SELECT id, applied_at, report_json FROM builtin_asset_migrations ORDER BY applied_at, id');
  return result.rows.map(row => ({ id: textValue(row, 'id'), appliedAt: textValue(row, 'applied_at'),
    report: parseBuiltinAssetMigrationReport(textValue(row, 'report_json')) }));
}

const BUILTIN_ASSET_ACTIONS: ReadonlySet<string> = new Set([
  'created', 'already_present', 'preserved_override', 'preserved_disabled', 'preserved_tombstone',
  'converged_legacy', 'conflict', 'skipped', 'binding_added', 'binding_removed', 'binding_present',
  'command_permission_converged', 'command_layout_converged',
]);

const BUILTIN_ASSET_KINDS: ReadonlySet<string> = new Set(['prompt', 'binding', 'command']);
const BUILTIN_ASSET_SCOPES: ReadonlySet<string> = new Set(['public', 'repository']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBuiltinMigrationAction(value: unknown): value is BuiltinMigrationAction {
  if (!isRecord(value) || typeof value.assetKey !== 'string' || typeof value.kind !== 'string' || !BUILTIN_ASSET_KINDS.has(value.kind)
      || typeof value.scope !== 'string' || !BUILTIN_ASSET_SCOPES.has(value.scope)
      || (value.repositoryId !== null && typeof value.repositoryId !== 'string')
      || typeof value.action !== 'string' || !BUILTIN_ASSET_ACTIONS.has(value.action)) return false;
  return value.detail === undefined || typeof value.detail === 'string';
}

function parseBuiltinAssetMigrationReport(raw: string): BuiltinAssetMigrationReport {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ControlPlaneError('invalid_configuration', 'Builtin asset migration report is not valid JSON.', 'builtin_asset_migrations');
  }
  if (!isRecord(value) || typeof value.migrationId !== 'string' || typeof value.description !== 'string'
      || typeof value.appliedAt !== 'string' || !Array.isArray(value.actions) || !value.actions.every(isBuiltinMigrationAction)) {
    throw new ControlPlaneError('invalid_configuration', 'Builtin asset migration report has an invalid shape.', 'builtin_asset_migrations');
  }
  return {
    migrationId: value.migrationId,
    description: value.description,
    appliedAt: value.appliedAt,
    actions: value.actions,
  };
}
