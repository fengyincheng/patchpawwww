import type { Row } from '@libsql/client';
import { ControlPlaneDb, booleanValue, isoNow, numberValue, optionalNumberValue, rowValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound, rethrowConstraint } from './errors.ts';
import { bumpRepository, contentDigest, createId, findMarker, normalizeAssetSlug, normalizedContent, putMarker } from './common.ts';
import { requireRepository } from './repositories.ts';
import type { CopyOptions, ExpectedRevision, SkillAsset, SkillInput } from './types.ts';

export function skillFromRow(row: Row): SkillAsset {
  return {
    id: textValue(row, 'id'), scope: textValue(row, 'scope') as SkillAsset['scope'],
    repositoryId: rowValue(row, 'repository_id') === null ? null : textValue(row, 'repository_id'),
    slug: textValue(row, 'slug'), title: textValue(row, 'title'), description: textValue(row, 'description'), content: textValue(row, 'content'),
    enabled: booleanValue(row, 'enabled'), revision: numberValue(row, 'revision'),
    sourcePublicId: rowValue(row, 'source_public_id') === null ? null : textValue(row, 'source_public_id'),
    sourcePublicRevision: optionalNumberValue(row, 'source_public_revision'),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

function assertScope(input: { scope: SkillInput['scope']; repositoryId?: string | null }) {
  if (input.scope === 'public' && input.repositoryId) throw new ControlPlaneError('invalid_configuration', 'Public assets cannot have a repository.', 'repository_id');
  if (input.scope === 'repository' && !input.repositoryId) throw new ControlPlaneError('invalid_configuration', 'Repository assets require a repository.', 'repository_id');
}

async function skillById(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, id: string) {
  const result = await executor.execute('SELECT * FROM skill_assets WHERE id = :id', { id });
  return result.rows[0] ? skillFromRow(result.rows[0]) : undefined;
}

export async function getSkill(db: ControlPlaneDb, id: string) { return skillById(db, id); }

export async function requireSkill(db: ControlPlaneDb, id: string) {
  const asset = await getSkill(db, id);
  if (!asset) notFound('Skill asset', id);
  return asset;
}

export async function listSkills(db: ControlPlaneDb, filter: { scope?: SkillAsset['scope']; repositoryId?: string | null } = {}) {
  const where: string[] = [];
  const args: Record<string, string | number | null> = {};
  if (filter.scope) { where.push('scope = :scope'); args.scope = filter.scope; }
  if (filter.repositoryId === null) where.push('repository_id IS NULL');
  if (filter.repositoryId) { where.push('repository_id = :repository_id'); args.repository_id = filter.repositoryId; }
  const result = await db.execute(`SELECT * FROM skill_assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slug`, args);
  return result.rows.map(skillFromRow);
}

export async function createSkill(db: ControlPlaneDb, input: SkillInput) {
  assertScope(input);
  const slug = normalizeAssetSlug(input.slug);
  const content = normalizedContent(input.content);
  if (input.scope === 'repository') await requireRepository(db, input.repositoryId!);
  const now = isoNow();
  const asset: SkillAsset = { id: createId(), scope: input.scope, repositoryId: input.repositoryId ?? null, slug,
    title: input.title.trim() || slug, description: input.description?.trim() ?? '', content, enabled: input.enabled ?? true,
    revision: 1, sourcePublicId: null, sourcePublicRevision: null, createdAt: now, updatedAt: now };
  try {
    await db.transaction(async transaction => {
      await transaction.execute(`INSERT INTO skill_assets(
        id, scope, repository_id, slug, title, description, content, enabled, revision,
        source_public_id, source_public_revision, created_at, updated_at
      ) VALUES (:id, :scope, :repository_id, :slug, :title, :description, :content, :enabled, :revision,
        :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
        id: asset.id, scope: asset.scope, repository_id: asset.repositoryId, slug: asset.slug, title: asset.title, description: asset.description,
        content: asset.content, enabled: asset.enabled ? 1 : 0, revision: asset.revision, source_public_id: null, source_public_revision: null,
        created_at: now, updated_at: now,
      });
      if (asset.repositoryId) {
        await bumpRepository(transaction, asset.repositoryId);
        await putMarker(transaction, { repositoryId: asset.repositoryId, seedKey: `skill:${asset.slug}`, resourceKind: 'skill', resourceId: asset.id,
          sourceDigest: contentDigest(asset.content), sourceRevision: 1, state: asset.enabled ? 'override' : 'disabled' });
      } else await putMarker(transaction, { repositoryId: null, seedKey: `public-skill:${asset.slug}`, resourceKind: 'skill', resourceId: asset.id,
        sourceDigest: contentDigest(asset.content), sourceRevision: 1, state: asset.enabled ? 'override' : 'disabled' });
    });
  } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Skill slug already exists: ${slug}`, 'slug');
    throw error;
  }
  return asset;
}

async function assertSkillIsNotBound(transaction: ControlPlaneTransaction, id: string, code: 'required_binding' | 'referenced_resource' = 'referenced_resource') {
  const result = await transaction.execute(`SELECT COUNT(*) AS count FROM command_skills WHERE skill_asset_id = :id
    UNION ALL SELECT COUNT(*) AS count FROM profile_skills WHERE skill_asset_id = :id`, { id });
  const count = result.rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  if (count > 0) throw new ControlPlaneError(code, `Skill asset is still bound: ${id}`);
}

export async function updateSkill(db: ControlPlaneDb, id: string, patch: Partial<Pick<SkillInput, 'slug' | 'title' | 'description' | 'content' | 'enabled'>> = {}, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const currentRow = await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id });
    if (!currentRow.rows[0]) notFound('Skill asset', id);
    const current = skillFromRow(currentRow.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Skill asset');
    const enabled = patch.enabled ?? current.enabled;
    if (current.enabled && !enabled) await assertSkillIsNotBound(transaction, id, 'required_binding');
    const slug = patch.slug === undefined ? current.slug : normalizeAssetSlug(patch.slug);
    const content = patch.content === undefined ? current.content : normalizedContent(patch.content);
    const updatedAt = isoNow();
    try {
      await transaction.execute(`UPDATE skill_assets SET slug = :slug, title = :title, description = :description, content = :content,
        enabled = :enabled, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
        id, slug, title: patch.title?.trim() || current.title, description: patch.description?.trim() ?? current.description,
        content, enabled: enabled ? 1 : 0, updated_at: updatedAt,
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Skill slug already exists: ${slug}`, 'slug');
      throw error;
    }
    if (current.repositoryId) {
      await bumpRepository(transaction, current.repositoryId);
      await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `skill:${slug}`, resourceKind: 'skill', resourceId: id,
        sourceDigest: contentDigest(content), sourceRevision: current.sourcePublicRevision, state: enabled ? 'override' : 'disabled' });
      if (slug !== current.slug) await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `skill:${current.slug}`, resourceKind: 'skill', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    } else {
      await putMarker(transaction, { repositoryId: null, seedKey: `public-skill:${slug}`, resourceKind: 'skill', resourceId: id,
        sourceDigest: contentDigest(content), sourceRevision: current.sourcePublicRevision, state: enabled ? 'override' : 'disabled' });
      if (slug !== current.slug) await putMarker(transaction, { repositoryId: null, seedKey: `public-skill:${current.slug}`, resourceKind: 'skill', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    }
    const updated = await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id });
    return skillFromRow(updated.rows[0]);
  });
}

export async function deleteSkill(db: ControlPlaneDb, id: string, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Skill asset', id);
    const current = skillFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Skill asset');
    await assertSkillIsNotBound(transaction, id);
    await transaction.execute('DELETE FROM skill_assets WHERE id = :id', { id });
    if (current.repositoryId) {
      await bumpRepository(transaction, current.repositoryId);
      await putMarker(transaction, { repositoryId: current.repositoryId, seedKey: `skill:${current.slug}`, resourceKind: 'skill', resourceId: id,
        sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    } else await putMarker(transaction, { repositoryId: null, seedKey: `public-skill:${current.slug}`, resourceKind: 'skill', resourceId: id,
      sourceDigest: contentDigest(current.content), sourceRevision: current.sourcePublicRevision, state: 'tombstone' });
    return true;
  });
}

export async function copyPublicSkill(db: ControlPlaneDb, repositoryId: string, publicId: string, options: CopyOptions = {}) {
  return db.transaction(async transaction => {
    const repoResult = await transaction.execute('SELECT id FROM repositories WHERE id = :id', { id: repositoryId });
    if (!repoResult.rows[0]) notFound('Repository', repositoryId);
    const sourceRow = await transaction.execute(`SELECT * FROM skill_assets WHERE id = :id AND scope = 'public' AND repository_id IS NULL`, { id: publicId });
    if (!sourceRow.rows[0]) notFound('Public skill asset', publicId);
    const source = skillFromRow(sourceRow.rows[0]);
    const existingRows = await transaction.execute(`SELECT * FROM skill_assets WHERE repository_id = :repository_id AND slug = :slug`, { repository_id: repositoryId, slug: source.slug });
    const existing = existingRows.rows[0] ? skillFromRow(existingRows.rows[0]) : undefined;
    if (existing && !options.replace) throw new ControlPlaneError('slug_conflict', `Repository skill already exists: ${source.slug}`, 'slug');
    if (options.replace) {
      if (options.expectedRepositoryRevision === undefined) throw new ControlPlaneError('revision_conflict', 'Replacing a repository skill requires expected_repository_revision.', 'expected_repository_revision');
      const repo = await transaction.execute('SELECT revision FROM repositories WHERE id = :id', { id: repositoryId });
      assertExpectedRevision(Number(repo.rows[0].revision), options.expectedRepositoryRevision, 'Repository');
      if (!existing) throw new ControlPlaneError('not_found', `Repository skill does not exist for replacement: ${source.slug}`);
      await transaction.execute(`UPDATE skill_assets SET title = :title, description = :description, content = :content, enabled = :enabled,
        revision = revision + 1, source_public_id = :source_public_id, source_public_revision = :source_public_revision,
        updated_at = :updated_at WHERE id = :id`, { id: existing.id, title: source.title, description: source.description, content: source.content,
        enabled: source.enabled ? 1 : 0, source_public_id: source.id, source_public_revision: source.revision, updated_at: isoNow() });
      await bumpRepository(transaction, repositoryId);
      await putMarker(transaction, { repositoryId, seedKey: `skill:${source.slug}`, resourceKind: 'skill', resourceId: existing.id,
        sourceDigest: contentDigest(source.content), sourceRevision: source.revision, state: 'override' });
      const updated = await transaction.execute('SELECT * FROM skill_assets WHERE id = :id', { id: existing.id });
      return skillFromRow(updated.rows[0]);
    }
    const now = isoNow();
    const copy: SkillAsset = { ...source, id: createId(), scope: 'repository', repositoryId, revision: 1,
      sourcePublicId: source.id, sourcePublicRevision: source.revision, createdAt: now, updatedAt: now };
    try {
      await transaction.execute(`INSERT INTO skill_assets(
        id, scope, repository_id, slug, title, description, content, enabled, revision, source_public_id, source_public_revision, created_at, updated_at
      ) VALUES (:id, 'repository', :repository_id, :slug, :title, :description, :content, :enabled, 1, :source_public_id, :source_public_revision, :created_at, :updated_at)`, {
        id: copy.id, repository_id: repositoryId, slug: copy.slug, title: copy.title, description: copy.description, content: copy.content,
        enabled: copy.enabled ? 1 : 0, source_public_id: copy.sourcePublicId, source_public_revision: copy.sourcePublicRevision, created_at: now, updated_at: now,
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Repository skill already exists: ${source.slug}`, 'slug');
      throw error;
    }
    await bumpRepository(transaction, repositoryId);
    await putMarker(transaction, { repositoryId, seedKey: `skill:${copy.slug}`, resourceKind: 'skill', resourceId: copy.id,
      sourceDigest: contentDigest(copy.content), sourceRevision: copy.sourcePublicRevision, state: 'seeded' });
    return copy;
  });
}

export async function findSkillMarker(db: ControlPlaneDb, repositoryId: string, slug: string) {
  return findMarker(db, repositoryId, `skill:${normalizeAssetSlug(slug)}`);
}
