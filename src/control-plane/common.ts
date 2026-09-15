import { createHash, randomUUID } from 'node:crypto';
import type { Row } from '@libsql/client';
import { ControlPlaneError, invalid, notFound } from './errors.ts';
import { booleanValue, isoNow, jsonValue, numberValue, optionalNumberValue, rowValue, textValue, type ControlPlaneExecutor, type ControlPlaneTransaction } from './db.ts';
import type { BootstrapMarker, BootstrapMarkerState, Repository } from './types.ts';
import { storageKey as scmStorageKey } from '../scm/identity.ts';

export const RESERVED_COMMAND_NAMES = new Set(['stop', 'close', 'approval', 'approve', 'confict']);

export function createId() {
  return randomUUID();
}

export function normalizeRepositoryName(value: string) {
  const input = value.trim().replaceAll('\\', '/');
  const pieces = input.split('/');
  const normalizedPieces = pieces.map(piece => piece.trim());
  if (normalizedPieces.length !== 2 || normalizedPieces.some(piece => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(piece))) {
    invalid('Repository name must be an owner/repository pair.', 'full_name');
  }
  if (input.includes('//') || input.startsWith('/') || input.endsWith('/')) {
    invalid('Repository name must be a safe owner/repository pair.', 'full_name');
  }
  return normalizedPieces.map(piece => piece.toLowerCase()).join('/');
}

export function normalizeCommandName(value: string) {
  const input = value.trim().replace(/^\/+/, '').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input)) invalid('Command name must match [a-z][a-z0-9-]{0,31}.', 'slash_name');
  if (RESERVED_COMMAND_NAMES.has(input)) invalid(`Command name is reserved: ${input}`, 'slash_name');
  return input;
}

export function normalizeAssetSlug(value: string) {
  const input = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input)) invalid('Asset slug must match [a-z][a-z0-9-]{0,63}.', 'slug');
  return input;
}

export function normalizeRole(value: string | null | undefined) {
  if (value === null || value === undefined || value.trim() === '') return null;
  const input = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input)) invalid('Prompt role must be a stable lowercase slug.', 'role');
  return input;
}

export function normalizedContent(value: string) {
  if (typeof value !== 'string' || value.trim() === '') invalid('Asset content must not be empty.', 'content');
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function contentDigest(content: string) {
  return createHash('sha256').update(normalizedContent(content), 'utf8').digest('hex');
}

export function repositoryFromRow(row: Row): Repository {
  return {
    id: textValue(row, 'id'), fullNameNormalized: textValue(row, 'full_name_normalized'),
    displayName: textValue(row, 'display_name'), revision: numberValue(row, 'revision'),
    scmKind: textValue(row, 'scm_kind', 'github') as 'github' | 'gitlab',
    connectionId: rowValue(row, 'connection_id') === null || rowValue(row, 'connection_id') === undefined ? null : textValue(row, 'connection_id'),
    remoteProjectId: rowValue(row, 'remote_project_id') === null || rowValue(row, 'remote_project_id') === undefined ? null : textValue(row, 'remote_project_id'),
    pathWithNamespace: rowValue(row, 'path_with_namespace') === null || rowValue(row, 'path_with_namespace') === undefined ? null : textValue(row, 'path_with_namespace'),
    webUrl: rowValue(row, 'web_url') === null || rowValue(row, 'web_url') === undefined ? null : textValue(row, 'web_url'),
    cloneUrl: rowValue(row, 'clone_url') === null || rowValue(row, 'clone_url') === undefined ? null : textValue(row, 'clone_url'),
    storageKey: textValue(row, 'storage_key', textValue(row, 'full_name_normalized')),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

export function repositoryStorageKey(input: { scmKind?: 'github' | 'gitlab'; connectionId?: string | null; remoteProjectId?: string | number | null; fullName: string }) {
  if (input.scmKind === 'gitlab') {
    if (!input.connectionId || input.remoteProjectId === null || input.remoteProjectId === undefined) throw new Error('GitLab repositories require a connection id and remote project id');
    return scmStorageKey('gitlab', input.connectionId, input.remoteProjectId);
  }
  return input.fullName.trim().toLowerCase();
}

export function markerFromRow(row: Row): BootstrapMarker {
  return {
    id: textValue(row, 'id'), repositoryId: rowValue(row, 'repository_id') === null ? null : textValue(row, 'repository_id'),
    seedKey: textValue(row, 'seed_key'), resourceKind: textValue(row, 'resource_kind'),
    resourceId: rowValue(row, 'resource_id') === null ? null : textValue(row, 'resource_id'),
    sourceDigest: textValue(row, 'source_digest'), sourceRevision: optionalNumberValue(row, 'source_revision'),
    state: textValue(row, 'state') as BootstrapMarkerState,
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

export function repositoryMarkerWhere(repositoryId: string | null) {
  return repositoryId === null ? { sql: 'repository_id IS NULL', args: {} } : { sql: 'repository_id = :repository_id', args: { repository_id: repositoryId } };
}

export async function findMarker(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, repositoryId: string | null, seedKey: string) {
  const where = repositoryMarkerWhere(repositoryId);
  const args: Record<string, string | number | null> = { seed_key: seedKey };
  if (repositoryId !== null) args.repository_id = repositoryId;
  const result = await executor.execute(`SELECT * FROM bootstrap_markers WHERE ${where.sql} AND seed_key = :seed_key`, args);
  return result.rows[0] ? markerFromRow(result.rows[0]) : undefined;
}

export async function putMarker(
  executor: ControlPlaneExecutor | ControlPlaneTransaction,
  input: { repositoryId: string | null; seedKey: string; resourceKind: string; resourceId: string | null; sourceDigest: string; sourceRevision?: number | null; state: BootstrapMarkerState },
) {
  const now = isoNow();
  const existing = await findMarker(executor, input.repositoryId, input.seedKey);
  if (existing) {
    await executor.execute(`UPDATE bootstrap_markers SET resource_kind = :resource_kind, resource_id = :resource_id,
      source_digest = :source_digest, source_revision = :source_revision, state = :state, updated_at = :updated_at
      WHERE id = :id`, { resource_kind: input.resourceKind, resource_id: input.resourceId, source_digest: input.sourceDigest,
      source_revision: input.sourceRevision ?? null, state: input.state, updated_at: now, id: existing.id });
    return { ...existing, ...{ resourceKind: input.resourceKind, resourceId: input.resourceId, sourceDigest: input.sourceDigest,
      sourceRevision: input.sourceRevision ?? null, state: input.state, updatedAt: now } } as BootstrapMarker;
  }
  const id = createId();
  await executor.execute(`INSERT INTO bootstrap_markers(
      id, repository_id, seed_key, resource_kind, resource_id, source_digest, source_revision, state, created_at, updated_at
    ) VALUES (:id, :repository_id, :seed_key, :resource_kind, :resource_id, :source_digest, :source_revision, :state, :created_at, :updated_at)`, {
    id, repository_id: input.repositoryId, seed_key: input.seedKey, resource_kind: input.resourceKind,
    resource_id: input.resourceId, source_digest: input.sourceDigest, source_revision: input.sourceRevision ?? null,
    state: input.state, created_at: now, updated_at: now,
  });
  return { id, repositoryId: input.repositoryId, seedKey: input.seedKey, resourceKind: input.resourceKind,
    resourceId: input.resourceId, sourceDigest: input.sourceDigest, sourceRevision: input.sourceRevision ?? null,
    state: input.state, createdAt: now, updatedAt: now } as BootstrapMarker;
}

export async function bumpRepository(executor: ControlPlaneExecutor | ControlPlaneTransaction, repositoryId: string) {
  const result = await executor.execute(`UPDATE repositories SET revision = revision + 1, updated_at = :updated_at WHERE id = :id`, { id: repositoryId, updated_at: isoNow() });
  if (!result.rowsAffected) notFound('Repository', repositoryId);
}

export function assertBindingPositions(positions: number[] | undefined, field: string) {
  if (!positions) return;
  const seen = new Set<number>();
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 1 || seen.has(position)) {
      throw new ControlPlaneError('binding_conflict', `${field} positions must be unique positive integers.`, field);
    }
    seen.add(position);
  }
}

export function isEnabled(row: Row, key = 'enabled') {
  return booleanValue(row, key);
}

export function readRequestOptions(row: Row) {
  return jsonValue<Record<string, string | number | boolean>>(row, 'request_options_json', {});
}

export type ControlPlaneDbExecutor = ControlPlaneExecutor;
