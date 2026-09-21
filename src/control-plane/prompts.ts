import type { Row } from '@libsql/client';
import { ControlPlaneDb, booleanValue, isoNow, numberValue, optionalNumberValue, rowValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound, rethrowConstraint } from './errors.ts';
import { bumpRepository, contentDigest, createId, findMarker, normalizeAssetSlug, normalizeRole, normalizedContent, putMarker } from './common.ts';
import { requireRepository } from './repositories.ts';
import { builtinPromptByRole, builtinPromptBySlug } from './builtin-prompts.ts';
import type { CopyOptions, ExpectedRevision, PromptAsset, PromptInput } from './types.ts';

export function promptFromRow(row: Row): PromptAsset {
  return {
    id: textValue(row, 'id'), scope: textValue(row, 'scope') as PromptAsset['scope'],
    repositoryId: rowValue(row, 'repository_id') === null ? null : textValue(row, 'repository_id'),
    slug: textValue(row, 'slug'), title: textValue(row, 'title'), role: rowValue(row, 'role') === null ? null : textValue(row, 'role'),
    content: textValue(row, 'content'), enabled: booleanValue(row, 'enabled'), revision: numberValue(row, 'revision'),
    sourcePublicId: rowValue(row, 'source_public_id') === null ? null : textValue(row, 'source_public_id'),
    sourcePublicRevision: optionalNumberValue(row, 'source_public_revision'),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

function assertScope(input: { scope: PromptInput['scope']; repositoryId?: string | null }) {
  if (input.scope === 'public' && input.repositoryId) throw new ControlPlaneError('invalid_configuration', 'Public assets cannot have a repository.', 'repository_id');
  if (input.scope === 'repository' && !input.repositoryId) throw new ControlPlaneError('invalid_configuration', 'Repository assets require a repository.', 'repository_id');
}

async function promptById(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, id: string) {
  const result = await executor.execute('SELECT * FROM prompt_assets WHERE id = :id', { id });
  return result.rows[0] ? promptFromRow(result.rows[0]) : undefined;
}

export async function getPrompt(db: ControlPlaneDb, id: string) { return promptById(db, id); }

export async function requirePrompt(db: ControlPlaneDb, id: string) {
  const asset = await getPrompt(db, id);
  if (!asset) notFound('Prompt asset', id);
  return asset;
}

export async function listPrompts(db: ControlPlaneDb, filter: { scope?: PromptAsset['scope']; repositoryId?: string | null } = {}) {
  const where: string[] = [];
  const args: Record<string, string | number | null> = {};
  if (filter.scope) { where.push('scope = :scope'); args.scope = filter.scope; }
  if (filter.repositoryId === null) where.push('repository_id IS NULL');
  if (filter.repositoryId) { where.push('repository_id = :repository_id'); args.repository_id = filter.repositoryId; }
  const result = await db.execute(`SELECT * FROM prompt_assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slug`, args);
  return result.rows.map(promptFromRow);
}

export async function createPrompt(db: ControlPlaneDb, input: PromptInput) {
  assertScope(input);
  const slug = normalizeAssetSlug(input.slug);
  const role = normalizeRole(input.role);
  assertBuiltinIdentityIngress(slug, role);
  const content = normalizedContent(input.content);
  if (input.scope === 'repository') await requireRepository(db, input.repositoryId!);
  const now = isoNow();
  const asset: PromptAsset = { id: createId(), scope: input.scope, repositoryId: input.repositoryId ?? null,
    slug, title: input.title.trim() || slug, role, content, enabled: input.enabled ?? true, revision: 1,
    sourcePublicId: null, sourcePublicRevision: null, createdAt: now, updatedAt: now };
  try {
    await db.transaction(async transaction => {
      await transaction.execute(`INSERT INTO prompt_assets(
        id, scope, repository_id, slug, title, role, content, enabled, revision,
        source_public_id, source_public_revision, created_at, updated_at
      ) VALUES (:id, :scope, :repository_id, :slug, :title, :role, :content, :enabled, :revision,
        :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
        id: asset.id, scope: asset.scope, repository_id: asset.repositoryId, slug: asset.slug, title: asset.title,
        role: asset.role, content: asset.content, enabled: asset.enabled ? 1 : 0, revision: asset.revision,
        source_public_id: null, source_public_revision: null, created_at: now, updated_at: now,
      });
      if (asset.repositoryId) {
        await bumpRepository(transaction, asset.repositoryId);
        await putMarker(transaction, { repositoryId: asset.repositoryId, seedKey: `prompt:${asset.slug}`, resourceKind: 'prompt', resourceId: asset.id,
          sourceDigest: contentDigest(asset.content), sourceRevision: 1, state: asset.enabled ? 'override' : 'disabled' });
      } else await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${asset.slug}`, resourceKind: 'prompt', resourceId: asset.id,
        sourceDigest: contentDigest(asset.content), sourceRevision: 1, state: asset.enabled ? 'override' : 'disabled' });
    });
  } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Prompt slug or role already exists: ${slug}`, 'slug');
    throw error;
  }
  return asset;
}

async function assertPromptIsNotBound(transaction: ControlPlaneTransaction, id: string, requiredCode: 'required_binding' | 'referenced_resource' = 'referenced_resource') {
  const result = await transaction.execute(`SELECT COUNT(*) AS count FROM command_prompts WHERE prompt_asset_id = :id
    UNION ALL SELECT COUNT(*) AS count FROM profile_prompts WHERE prompt_asset_id = :id`, { id });
  const count = result.rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  if (count > 0) throw new ControlPlaneError(requiredCode, `Prompt asset is still bound: ${id}`);
}

function assertBuiltinIdentityLocked(current: PromptAsset, patch: Partial<Pick<PromptInput, 'slug' | 'role'>>) {
  const definition = builtinPromptBySlug(current.slug);
  if (!definition?.identityLocked) return;
  if (patch.slug !== undefined && normalizeAssetSlug(patch.slug) !== definition.slug) {
    throw new ControlPlaneError('invalid_configuration', `Builtin Prompt identity is locked: ${definition.slug}`, 'slug');
  }
  if (patch.role !== undefined && normalizeRole(patch.role) !== definition.role) {
    throw new ControlPlaneError('invalid_configuration', `Builtin Prompt identity is locked: ${definition.slug}`, 'role');
  }
}

function assertBuiltinIdentityIngress(slug: string, role: string | null) {
  const reservedSlug = builtinPromptBySlug(slug);
  if (reservedSlug?.identityLocked && role !== reservedSlug.role) {
    throw new ControlPlaneError('invalid_configuration',
      `Reserved builtin Prompt slug "${slug}" requires role "${reservedSlug.role}".`, 'role');
  }
  const reservedRole = builtinPromptByRole(role);
  if (reservedRole?.identityLocked && slug !== reservedRole.slug) {
    throw new ControlPlaneError('invalid_configuration',
      `Reserved builtin Prompt role "${role}" requires slug "${reservedRole.slug}".`, 'slug');
  }
}

export async function updatePrompt(db: ControlPlaneDb, id: string, patch: Partial<Pick<PromptInput, 'slug' | 'title' | 'role' | 'content' | 'enabled'>> = {}, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const currentRow = await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id });
    if (!currentRow.rows[0]) notFound('Prompt asset', id);
    const current = promptFromRow(currentRow.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Prompt asset');
    const slug = patch.slug === undefined ? current.slug : normalizeAssetSlug(patch.slug);
    const role = patch.role === undefined ? current.role : normalizeRole(patch.role);
    assertBuiltinIdentityLocked(current, patch);
    assertBuiltinIdentityIngress(slug, role);
    const enabled = patch.enabled ?? current.enabled;
    if (current.enabled && !enabled) await assertPromptIsNotBound(transaction, id, 'required_binding');
    const content = patch.content === undefined ? current.content : normalizedContent(patch.content);
    const updatedAt = isoNow();
    try {
      await transaction.execute(`UPDATE prompt_assets SET slug = :slug, title = :title, role = :role, content = :content,
        enabled = :enabled, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
        id, slug, title: patch.title?.trim() || current.title, role, content, enabled: enabled ? 1 : 0, updated_at: updatedAt,
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Prompt slug or role already exists: ${slug}`, 'slug');
      throw error;
    }
    if (current.repositoryId) {
      await bumpRepository(transaction, current.repositoryId);
      await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `prompt:${slug}`, resourceKind: 'prompt', resourceId: id,
        sourceDigest: contentDigest(content), sourceRevision: current.sourcePublicRevision, state: enabled ? 'override' : 'disabled' });
      if (slug !== current.slug) await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `prompt:${current.slug}`, resourceKind: 'prompt', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    } else {
      await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${slug}`, resourceKind: 'prompt', resourceId: id,
        sourceDigest: contentDigest(content), sourceRevision: current.sourcePublicRevision, state: enabled ? 'override' : 'disabled' });
      if (slug !== current.slug) await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${current.slug}`, resourceKind: 'prompt', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    }
    const updated = await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id });
    return promptFromRow(updated.rows[0]);
  });
}

export async function deletePrompt(db: ControlPlaneDb, id: string, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Prompt asset', id);
    const current = promptFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Prompt asset');
    await assertPromptIsNotBound(transaction, id);
    await transaction.execute('DELETE FROM prompt_assets WHERE id = :id', { id });
    if (current.repositoryId) {
      await bumpRepository(transaction, current.repositoryId);
      await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `prompt:${current.slug}`, resourceKind: 'prompt', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    } else await putMarker(transaction, { repositoryId: null, seedKey: `public-prompt:${current.slug}`, resourceKind: 'prompt', resourceId: id,
      sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    return true;
  });
}

export async function copyPublicPrompt(db: ControlPlaneDb, repositoryId: string, publicId: string, options: CopyOptions = {}) {
  return db.transaction(async transaction => {
    await requireRepositoryInTransaction(transaction, repositoryId);
    const sourceRow = await transaction.execute(`SELECT * FROM prompt_assets WHERE id = :id AND scope = 'public' AND repository_id IS NULL`, { id: publicId });
    if (!sourceRow.rows[0]) notFound('Public prompt asset', publicId);
    const source = promptFromRow(sourceRow.rows[0]);
    const existingRows = await transaction.execute(`SELECT * FROM prompt_assets WHERE repository_id = :repository_id AND slug = :slug`, { repository_id: repositoryId, slug: source.slug });
    const existing = existingRows.rows[0] ? promptFromRow(existingRows.rows[0]) : undefined;
    if (existing && !options.replace) throw new ControlPlaneError('slug_conflict', `Repository prompt already exists: ${source.slug}`, 'slug');
    if (options.replace) {
      if (options.expectedRepositoryRevision === undefined) throw new ControlPlaneError('revision_conflict', 'Replacing a repository prompt requires expected_repository_revision.', 'expected_repository_revision');
      const repo = await repositoryRowInTransaction(transaction, repositoryId);
      assertExpectedRevision(Number(repo.revision), options.expectedRepositoryRevision, 'Repository');
      if (!existing) throw new ControlPlaneError('not_found', `Repository prompt does not exist for replacement: ${source.slug}`);
      await transaction.execute(`UPDATE prompt_assets SET title = :title, role = :role, content = :content, enabled = :enabled,
        revision = revision + 1, source_public_id = :source_public_id, source_public_revision = :source_public_revision,
        updated_at = :updated_at WHERE id = :id`, { id: existing.id, title: source.title, role: source.role, content: source.content,
        enabled: source.enabled ? 1 : 0, source_public_id: source.id, source_public_revision: source.revision, updated_at: isoNow() });
      await bumpRepository(transaction, repositoryId);
      await putMarker(transaction, { repositoryId, seedKey: `prompt:${source.slug}`, resourceKind: 'prompt', resourceId: existing.id,
        sourceDigest: contentDigest(source.content), sourceRevision: source.revision, state: 'override' });
      const updated = await transaction.execute('SELECT * FROM prompt_assets WHERE id = :id', { id: existing.id });
      return promptFromRow(updated.rows[0]);
    }
    const now = isoNow();
    const copy: PromptAsset = { ...source, id: createId(), scope: 'repository', repositoryId,
      revision: 1, sourcePublicId: source.id, sourcePublicRevision: source.revision, createdAt: now, updatedAt: now };
    try {
      await transaction.execute(`INSERT INTO prompt_assets(
        id, scope, repository_id, slug, title, role, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
      ) VALUES (:id, 'repository', :repository_id, :slug, :title, :role, :content, :enabled, 1, :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
        id: copy.id, repository_id: repositoryId, slug: copy.slug, title: copy.title, role: copy.role, content: copy.content, enabled: copy.enabled ? 1 : 0,
        source_public_id: copy.sourcePublicId, source_public_revision: copy.sourcePublicRevision, created_at: now, updated_at: now,
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Repository prompt already exists: ${source.slug}`, 'slug');
      throw error;
    }
    await bumpRepository(transaction, repositoryId);
    await putMarker(transaction, { repositoryId, seedKey: `prompt:${copy.slug}`, resourceKind: 'prompt', resourceId: copy.id,
      sourceDigest: contentDigest(copy.content), sourceRevision: copy.sourcePublicRevision, state: 'seeded' });
    return copy;
  });
}

async function repositoryRowInTransaction(transaction: ControlPlaneTransaction, id: string) {
  const result = await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id });
  if (!result.rows[0]) notFound('Repository', id);
  return result.rows[0];
}

async function requireRepositoryInTransaction(transaction: ControlPlaneTransaction, id: string) {
  await repositoryRowInTransaction(transaction, id);
}

export async function findPromptMarker(db: ControlPlaneDb, repositoryId: string, slug: string) {
  return findMarker(db, repositoryId, `prompt:${normalizeAssetSlug(slug)}`);
}
