import { ControlPlaneDb, isoNow, type ControlPlaneTransaction } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound, rethrowConstraint } from './errors.ts';
import { createId, normalizeRepositoryName, repositoryFromRow } from './common.ts';
import type { ExpectedRevision, Repository, RepositoryInput } from './types.ts';

export async function getRepository(db: ControlPlaneDb, id: string) {
  const result = await db.execute('SELECT * FROM repositories WHERE id = :id', { id });
  return result.rows[0] ? repositoryFromRow(result.rows[0]) : undefined;
}

export async function getRepositoryByName(db: ControlPlaneDb, fullName: string) {
  const fullNameNormalized = normalizeRepositoryName(fullName);
  const result = await db.execute('SELECT * FROM repositories WHERE full_name_normalized = :full_name_normalized', { full_name_normalized: fullNameNormalized });
  return result.rows[0] ? repositoryFromRow(result.rows[0]) : undefined;
}

export async function requireRepository(db: ControlPlaneDb, id: string) {
  const repository = await getRepository(db, id);
  if (!repository) notFound('Repository', id);
  return repository;
}

export async function listRepositories(db: ControlPlaneDb) {
  const result = await db.execute('SELECT * FROM repositories ORDER BY full_name_normalized');
  return result.rows.map(repositoryFromRow);
}

export async function createRepository(db: ControlPlaneDb, input: RepositoryInput) {
  const fullNameNormalized = normalizeRepositoryName(input.fullName);
  const now = isoNow();
  const repository: Repository = { id: createId(), fullNameNormalized,
    displayName: input.displayName?.trim() || input.fullName.trim(), revision: 1, createdAt: now, updatedAt: now };
  try {
    await db.execute(`INSERT INTO repositories(id, full_name_normalized, display_name, revision, created_at, updated_at)
      VALUES (:id, :full_name_normalized, :display_name, :revision, :created_at, :updated_at)`, {
      id: repository.id, full_name_normalized: repository.fullNameNormalized, display_name: repository.displayName,
      revision: repository.revision, created_at: repository.createdAt, updated_at: repository.updatedAt,
    });
  } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Repository already exists: ${fullNameNormalized}`, 'full_name');
    throw error;
  }
  return repository;
}

export async function updateRepository(db: ControlPlaneDb, id: string, patch: { displayName?: string }, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => updateRepositoryInTransaction(transaction, id, patch, options));
}

export async function updateRepositoryInTransaction(transaction: ControlPlaneTransaction, id: string, patch: { displayName?: string }, options: ExpectedRevision = {}) {
  const result = await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id });
  const current = result.rows[0];
  if (!current) notFound('Repository', id);
  const currentRevision = Number(current.revision);
  assertExpectedRevision(currentRevision, options.expectedRevision, 'Repository');
  const displayName = patch.displayName?.trim() || String(current.display_name);
  const updatedAt = isoNow();
  await transaction.execute(`UPDATE repositories SET display_name = :display_name, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, {
    id, display_name: displayName, updated_at: updatedAt,
  });
  const updated = await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id });
  return repositoryFromRow(updated.rows[0]);
}

export async function deleteRepository(db: ControlPlaneDb, id: string, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM repositories WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Repository', id);
    assertExpectedRevision(Number(result.rows[0].revision), options.expectedRevision, 'Repository');
    const counts = await transaction.execute(`SELECT
      (SELECT COUNT(*) FROM prompt_assets WHERE repository_id = :id) +
      (SELECT COUNT(*) FROM skill_assets WHERE repository_id = :id) +
      (SELECT COUNT(*) FROM commands WHERE repository_id = :id) +
      (SELECT COUNT(*) FROM conversation_profiles WHERE repository_id = :id) AS count`, { id });
    if (Number(counts.rows[0]?.count ?? 0) > 0) {
      throw new ControlPlaneError('referenced_resource', `Repository is still referenced by control-plane configuration: ${id}`);
    }
    try {
      await transaction.execute('DELETE FROM repositories WHERE id = :id', { id });
    } catch (error) {
      if (isSqliteConstraint(error)) rethrowConstraint(error, `Repository is still referenced: ${id}`);
      throw error;
    }
    return true;
  });
}
