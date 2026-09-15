import type { Row } from '@libsql/client';
import { ControlPlaneDb, isoNow, numberValue, rowValue, textValue } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound } from './errors.ts';
import { createId } from './common.ts';
import { normalizeInstanceUrl } from '../scm/identity.ts';
import type { ScmConnection } from '../scm/types.ts';
import type { ScmConnectionInput } from './types.ts';
import { validateCredentialRef } from './secrets.ts';

function fromRow(row: Row): ScmConnection {
  let projectIds: string[] = [];
  try { projectIds = JSON.parse(textValue(row, 'project_ids_json', '[]')); } catch { throw new ControlPlaneError('invalid_configuration', 'SCM connection project list is corrupt.'); }
  return { id: textValue(row, 'id'), kind: textValue(row, 'kind') as 'github' | 'gitlab', instanceUrl: textValue(row, 'instance_url'),
    credentialRef: rowValue(row, 'credential_ref') == null ? null : textValue(row, 'credential_ref'), webhookMode: textValue(row, 'webhook_mode', 'secret') as 'secret' | 'signing',
    webhookSecretRef: rowValue(row, 'webhook_secret_ref') == null ? null : textValue(row, 'webhook_secret_ref'), botUserId: rowValue(row, 'bot_user_id') == null ? null : textValue(row, 'bot_user_id'),
    botLogin: rowValue(row, 'bot_login') == null ? null : textValue(row, 'bot_login'), projectIds, enabled: numberValue(row, 'enabled') === 1, revision: numberValue(row, 'revision', 1),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at') };
}

function validate(input: ScmConnectionInput) {
  if (input.kind !== 'gitlab' && input.kind !== 'github') throw new ControlPlaneError('invalid_configuration', 'Unsupported SCM kind.', 'kind');
  let instanceUrl: string;
  try { instanceUrl = normalizeInstanceUrl(input.instanceUrl); } catch { throw new ControlPlaneError('invalid_configuration', 'SCM instance URL is invalid.', 'instance_url'); }
  validateCredentialRef(input.credentialRef); validateCredentialRef(input.webhookSecretRef);
  if (!(input.projectIds ?? []).some(value => String(value).trim()) && input.kind === 'gitlab') throw new ControlPlaneError('invalid_configuration', 'GitLab connections must list at least one registered project.', 'project_ids');
  return instanceUrl;
}

export async function getScmConnection(db: ControlPlaneDb, id: string) {
  const result = await db.execute('SELECT * FROM scm_connections WHERE id = :id', { id });
  return result.rows[0] ? fromRow(result.rows[0]) : undefined;
}
export async function listScmConnections(db: ControlPlaneDb) {
  const result = await db.execute('SELECT * FROM scm_connections ORDER BY kind, instance_url, id');
  return result.rows.map(fromRow);
}
export async function createScmConnection(db: ControlPlaneDb, input: ScmConnectionInput) {
  const instanceUrl = validate(input); const now = isoNow(); const id = input.id?.trim() || createId();
  const projectIds = [...new Set((input.projectIds ?? []).map(value => String(value).trim().toLowerCase()).filter(Boolean))];
  const connection: ScmConnection = { id, kind: input.kind, instanceUrl, credentialRef: input.credentialRef ?? null, webhookMode: input.webhookMode ?? 'secret',
    webhookSecretRef: input.webhookSecretRef ?? null, botUserId: input.botUserId ?? null, botLogin: input.botLogin ?? null, projectIds, enabled: input.enabled ?? true, revision: 1, createdAt: now, updatedAt: now };
  try { await db.execute(`INSERT INTO scm_connections(id, kind, instance_url, credential_ref, webhook_mode, webhook_secret_ref, bot_user_id, bot_login, project_ids_json, enabled, revision, created_at, updated_at)
    VALUES (:id, :kind, :instance_url, :credential_ref, :webhook_mode, :webhook_secret_ref, :bot_user_id, :bot_login, :project_ids_json, :enabled, 1, :created_at, :updated_at)`, {
    id, kind: connection.kind, instance_url: instanceUrl, credential_ref: connection.credentialRef, webhook_mode: connection.webhookMode, webhook_secret_ref: connection.webhookSecretRef,
    bot_user_id: connection.botUserId, bot_login: connection.botLogin, project_ids_json: JSON.stringify(connection.projectIds), enabled: connection.enabled ? 1 : 0, created_at: now, updated_at: now }); }
  catch (error) { if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', 'SCM connection id already exists.', 'id'); throw error; }
  return connection;
}
export async function updateScmConnection(db: ControlPlaneDb, id: string, patch: Partial<ScmConnectionInput>, options: { expectedRevision?: number } = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM scm_connections WHERE id = :id', { id }); if (!result.rows[0]) notFound('SCM connection', id);
    const current = fromRow(result.rows[0]); assertExpectedRevision(current.revision ?? 1, options.expectedRevision, 'SCM connection');
    const nextInput: ScmConnectionInput = { ...current, ...patch, id };
    const instanceUrl = validate(nextInput); const projectIds = [...new Set((patch.projectIds ?? current.projectIds).map(value => String(value).trim().toLowerCase()).filter(Boolean))]; const next = { ...current, ...patch, instanceUrl, projectIds };
    const now = isoNow(); await transaction.execute(`UPDATE scm_connections SET kind=:kind, instance_url=:instance_url, credential_ref=:credential_ref, webhook_mode=:webhook_mode,
      webhook_secret_ref=:webhook_secret_ref, bot_user_id=:bot_user_id, bot_login=:bot_login, project_ids_json=:project_ids_json, enabled=:enabled, revision=revision+1, updated_at=:updated_at WHERE id=:id`, {
      id, kind: next.kind, instance_url: next.instanceUrl, credential_ref: next.credentialRef, webhook_mode: next.webhookMode, webhook_secret_ref: next.webhookSecretRef,
      bot_user_id: next.botUserId, bot_login: next.botLogin, project_ids_json: JSON.stringify(next.projectIds), enabled: next.enabled ? 1 : 0, updated_at: now });
    return fromRow((await transaction.execute('SELECT * FROM scm_connections WHERE id=:id', { id })).rows[0]);
  });
}
export async function deleteScmConnection(db: ControlPlaneDb, id: string) {
  const references = await db.execute('SELECT COUNT(*) AS count FROM repositories WHERE connection_id = :id', { id });
  if (numberValue(references.rows[0], 'count') > 0) throw new ControlPlaneError('referenced_resource', 'SCM connection is still referenced by configured repositories.', 'id');
  const result = await db.execute('DELETE FROM scm_connections WHERE id = :id', { id }); if (!result.rowsAffected) notFound('SCM connection', id); return true;
}
