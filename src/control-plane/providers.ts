import type { Row } from '@libsql/client';
import { ControlPlaneDb, booleanValue, isoNow, jsonValue, numberValue, rowValue, textValue, type ControlPlaneTransaction } from './db.ts';
import { assertExpectedRevision, ControlPlaneError, isSqliteConstraint, notFound, rethrowConstraint } from './errors.ts';
import { contentDigest, createId, putMarker } from './common.ts';
import { SecretStore, validateCredentialRef } from './secrets.ts';
import type { ExpectedRevision, Provider, ProviderInput, ProviderModel, ProviderModelInput, ProviderType } from './types.ts';
import { PROVIDER_TYPES } from './types.ts';

const SAFE_REQUEST_OPTIONS = new Set([
  'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'seed',
  'reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget', 'http_referer', 'x_openrouter_title', 'stream',
]);

function validateRequestOptions(options: Record<string, string | number | boolean>) {
  for (const [key, value] of Object.entries(options)) {
    if (!SAFE_REQUEST_OPTIONS.has(key)) throw new ControlPlaneError('invalid_configuration', 'Provider request options contain an unsupported or sensitive field.', 'request_options');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new ControlPlaneError('invalid_configuration', 'Provider request options contain an invalid value.', 'request_options');
    if (typeof value === 'string' && value.length > 1024) throw new ControlPlaneError('invalid_configuration', 'Provider request option is too long.', 'request_options');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ControlPlaneError('invalid_configuration', 'Provider request option must be finite.', 'request_options');
  }
}

function providerFromRow(row: Row): Provider {
  return {
    id: textValue(row, 'id'), type: textValue(row, 'type') as ProviderType, displayName: textValue(row, 'display_name'),
    baseUrl: textValue(row, 'base_url'), credentialRef: rowValue(row, 'credential_ref') === null ? null : textValue(row, 'credential_ref'),
    requestOptions: jsonValue<Record<string, string | number | boolean>>(row, 'request_options_json', {}),
    enabled: booleanValue(row, 'enabled'), revision: numberValue(row, 'revision'),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

function modelFromRow(row: Row): ProviderModel {
  return {
    id: textValue(row, 'id'), providerId: textValue(row, 'provider_id'), modelIdentifier: textValue(row, 'model_identifier'),
    displayName: textValue(row, 'display_name'), enabled: booleanValue(row, 'enabled'), revision: numberValue(row, 'revision'),
    createdAt: textValue(row, 'created_at'), updatedAt: textValue(row, 'updated_at'),
  };
}

function validateProviderInput(input: ProviderInput) {
  if (!PROVIDER_TYPES.includes(input.type)) throw new ControlPlaneError('invalid_configuration', `Unsupported provider type: ${input.type}`, 'type');
  try {
    const url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => /(secret|token|password|authorization|api[_-]?key)/i.test(key))) {
      throw new Error('unsafe provider URL');
    }
  } catch { throw new ControlPlaneError('invalid_configuration', 'Provider base URL must be an absolute HTTP(S) URL without embedded credentials.', 'base_url'); }
  validateCredentialRef(input.credentialRef);
  validateRequestOptions(input.requestOptions ?? {});
}

async function providerById(executor: { execute: (sql: string, args?: Record<string, string | number | null>) => Promise<{ rows: Row[] }> }, id: string) {
  const result = await executor.execute('SELECT * FROM providers WHERE id = :id', { id });
  return result.rows[0] ? providerFromRow(result.rows[0]) : undefined;
}

export async function getProvider(db: ControlPlaneDb, id: string) { return providerById(db, id); }

export async function requireProvider(db: ControlPlaneDb, id: string) {
  const provider = await getProvider(db, id);
  if (!provider) notFound('Provider', id);
  return provider;
}

export async function listProviders(db: ControlPlaneDb) {
  const result = await db.execute('SELECT * FROM providers ORDER BY display_name, id');
  return result.rows.map(providerFromRow);
}

export async function createProvider(db: ControlPlaneDb, input: ProviderInput) {
  validateProviderInput(input);
  const now = isoNow();
  const provider: Provider = { id: createId(), type: input.type, displayName: input.displayName.trim() || input.type,
    baseUrl: input.baseUrl.trim(), credentialRef: input.credentialRef ?? null, requestOptions: input.requestOptions ?? {},
    enabled: input.enabled ?? true, revision: 1, createdAt: now, updatedAt: now };
  await db.execute(`INSERT INTO providers(
    id, type, display_name, base_url, credential_ref, request_options_json, enabled, revision, created_at, updated_at
  ) VALUES (:id, :type, :display_name, :base_url, :credential_ref, :request_options_json, :enabled, :revision, :created_at, :updated_at)`, {
    id: provider.id, type: provider.type, display_name: provider.displayName, base_url: provider.baseUrl, credential_ref: provider.credentialRef,
    request_options_json: JSON.stringify(provider.requestOptions), enabled: provider.enabled ? 1 : 0, revision: provider.revision,
    created_at: now, updated_at: now,
  });
  return provider;
}

export async function updateProvider(db: ControlPlaneDb, id: string, patch: Partial<Pick<ProviderInput, 'type' | 'displayName' | 'baseUrl' | 'credentialRef' | 'requestOptions' | 'enabled'>>, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM providers WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Provider', id);
    const current = providerFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Provider');
    const next = { type: patch.type ?? current.type, displayName: patch.displayName?.trim() || current.displayName,
      baseUrl: patch.baseUrl?.trim() || current.baseUrl, credentialRef: patch.credentialRef === undefined ? current.credentialRef : patch.credentialRef,
      requestOptions: patch.requestOptions ?? current.requestOptions, enabled: patch.enabled ?? current.enabled };
    validateProviderInput(next);
    const updatedAt = isoNow();
    await transaction.execute(`UPDATE providers SET type = :type, display_name = :display_name, base_url = :base_url,
      credential_ref = :credential_ref, request_options_json = :request_options_json, enabled = :enabled,
      revision = revision + 1, updated_at = :updated_at WHERE id = :id`, { id, type: next.type, display_name: next.displayName,
      base_url: next.baseUrl, credential_ref: next.credentialRef, request_options_json: JSON.stringify(next.requestOptions),
      enabled: next.enabled ? 1 : 0, updated_at: updatedAt });
    const markers = await transaction.execute('SELECT id FROM bootstrap_markers WHERE repository_id IS NULL AND resource_id = :id', { id });
    for (const marker of markers.rows) await transaction.execute('UPDATE bootstrap_markers SET state = :state, updated_at = :updated_at WHERE id = :marker_id', {
      marker_id: String(marker.id), state: next.enabled ? 'override' : 'disabled', updated_at: updatedAt,
    });
    return providerFromRow((await transaction.execute('SELECT * FROM providers WHERE id = :id', { id })).rows[0]);
  });
}

export async function deleteProvider(db: ControlPlaneDb, id: string, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const provider = await transaction.execute('SELECT * FROM providers WHERE id = :id', { id });
    if (!provider.rows[0]) notFound('Provider', id);
    assertExpectedRevision(Number(provider.rows[0].revision), options.expectedRevision, 'Provider');
    const refs = await transaction.execute(`SELECT
      (SELECT COUNT(*) FROM provider_models WHERE provider_id = :id) +
      (SELECT COUNT(*) FROM commands c JOIN provider_models m ON m.id = c.provider_model_id WHERE m.provider_id = :id) +
      (SELECT COUNT(*) FROM conversation_profiles p JOIN provider_models m ON m.id = p.provider_model_id WHERE m.provider_id = :id) AS count`, { id });
    if (Number(refs.rows[0]?.count ?? 0) > 0) throw new ControlPlaneError('referenced_resource', `Provider is still referenced: ${id}`);
    try { await transaction.execute('DELETE FROM providers WHERE id = :id', { id }); }
    catch (error) { if (isSqliteConstraint(error)) rethrowConstraint(error, `Provider is still referenced: ${id}`); throw error; }
    const markers = await transaction.execute('SELECT id FROM bootstrap_markers WHERE resource_id = :id', { id });
    for (const marker of markers.rows) await transaction.execute('UPDATE bootstrap_markers SET state = \'tombstone\', updated_at = :updated_at WHERE id = :marker_id', { marker_id: String(marker.id), updated_at: isoNow() });
    return true;
  });
}

export async function listProviderModels(db: ControlPlaneDb, providerId: string) {
  await requireProvider(db, providerId);
  const result = await db.execute('SELECT * FROM provider_models WHERE provider_id = :provider_id ORDER BY model_identifier', { provider_id: providerId });
  return result.rows.map(modelFromRow);
}

export async function getProviderModel(db: ControlPlaneDb, id: string) {
  const result = await db.execute('SELECT * FROM provider_models WHERE id = :id', { id });
  return result.rows[0] ? modelFromRow(result.rows[0]) : undefined;
}

export async function requireProviderModel(db: ControlPlaneDb, id: string) {
  const model = await getProviderModel(db, id);
  if (!model) notFound('Provider model', id);
  return model;
}

export async function createProviderModel(db: ControlPlaneDb, input: ProviderModelInput) {
  await requireProvider(db, input.providerId);
  const identifier = input.modelIdentifier.trim();
  if (!identifier) throw new ControlPlaneError('invalid_configuration', 'Model identifier cannot be empty.', 'model_identifier');
  const now = isoNow();
  const model: ProviderModel = { id: createId(), providerId: input.providerId, modelIdentifier: identifier,
    displayName: input.displayName?.trim() || identifier, enabled: input.enabled ?? true, revision: 1, createdAt: now, updatedAt: now };
  try {
    await db.execute(`INSERT INTO provider_models(
      id, provider_id, model_identifier, display_name, enabled, revision, created_at, updated_at
    ) VALUES (:id, :provider_id, :model_identifier, :display_name, :enabled, :revision, :created_at, :updated_at)`, {
      id: model.id, provider_id: model.providerId, model_identifier: model.modelIdentifier, display_name: model.displayName,
      enabled: model.enabled ? 1 : 0, revision: model.revision, created_at: now, updated_at: now,
    });
  } catch (error) {
    if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Model identifier already exists for provider: ${identifier}`, 'model_identifier');
    throw error;
  }
  return model;
}

export async function updateProviderModel(db: ControlPlaneDb, id: string, patch: Partial<Pick<ProviderModelInput, 'modelIdentifier' | 'displayName' | 'enabled'>>, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM provider_models WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Provider model', id);
    const current = modelFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Provider model');
    const identifier = patch.modelIdentifier?.trim() || current.modelIdentifier;
    if (!identifier) throw new ControlPlaneError('invalid_configuration', 'Model identifier cannot be empty.', 'model_identifier');
    const updatedAt = isoNow();
    try {
      await transaction.execute(`UPDATE provider_models SET model_identifier = :model_identifier, display_name = :display_name,
        enabled = :enabled, revision = revision + 1, updated_at = :updated_at WHERE id = :id`, { id, model_identifier: identifier,
        display_name: patch.displayName?.trim() || current.displayName, enabled: (patch.enabled ?? current.enabled) ? 1 : 0, updated_at: updatedAt });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ControlPlaneError('slug_conflict', `Model identifier already exists for provider: ${identifier}`, 'model_identifier');
      throw error;
    }
    const markers = await transaction.execute('SELECT id FROM bootstrap_markers WHERE repository_id IS NULL AND resource_id = :id', { id });
    for (const marker of markers.rows) await transaction.execute('UPDATE bootstrap_markers SET state = :state, updated_at = :updated_at WHERE id = :marker_id', {
      marker_id: String(marker.id), state: identifier === current.modelIdentifier ? ((patch.enabled ?? current.enabled) ? 'override' : 'disabled') : 'tombstone', updated_at: updatedAt,
    });
    if (identifier !== current.modelIdentifier && markers.rows.length > 0) await putMarker(transaction, { repositoryId: null, seedKey: `model:zhipu:${identifier}`, resourceKind: 'provider_model', resourceId: id,
      sourceDigest: contentDigest(identifier), sourceRevision: current.revision + 1, state: (patch.enabled ?? current.enabled) ? 'override' : 'disabled' });
    return modelFromRow((await transaction.execute('SELECT * FROM provider_models WHERE id = :id', { id })).rows[0]);
  });
}

export async function deleteProviderModel(db: ControlPlaneDb, id: string, options: ExpectedRevision = {}) {
  return db.transaction(async transaction => {
    const result = await transaction.execute('SELECT * FROM provider_models WHERE id = :id', { id });
    if (!result.rows[0]) notFound('Provider model', id);
    const current = modelFromRow(result.rows[0]);
    assertExpectedRevision(current.revision, options.expectedRevision, 'Provider model');
    const refs = await transaction.execute(`SELECT
      (SELECT COUNT(*) FROM commands WHERE provider_model_id = :id) +
      (SELECT COUNT(*) FROM conversation_profiles WHERE provider_model_id = :id) AS count`, { id });
    if (Number(refs.rows[0]?.count ?? 0) > 0) throw new ControlPlaneError('referenced_resource', `Provider model is still bound: ${id}`);
    try { await transaction.execute('DELETE FROM provider_models WHERE id = :id', { id }); }
    catch (error) { if (isSqliteConstraint(error)) rethrowConstraint(error, `Provider model is still referenced: ${id}`); throw error; }
    const markers = await transaction.execute('SELECT id FROM bootstrap_markers WHERE resource_id = :id', { id });
    for (const marker of markers.rows) await transaction.execute('UPDATE bootstrap_markers SET state = \'tombstone\', updated_at = :updated_at WHERE id = :marker_id', { marker_id: String(marker.id), updated_at: isoNow() });
    return true;
  });
}

export async function setProviderCredential(db: ControlPlaneDb, runtimeHome: string, providerId: string, secret: string, options: ExpectedRevision = {}) {
  const provider = await requireProvider(db, providerId);
  assertExpectedRevision(provider.revision, options.expectedRevision, 'Provider');
  const secrets = new SecretStore(runtimeHome);
  // Filesystem first, DB second: a failed DB commit leaves an unused file or the
  // old stable reference, never a committed reference to a missing file.
  const credentialRef = await secrets.writeProviderSecret(providerId, secret);
  try {
    return await updateProvider(db, providerId, { credentialRef }, { expectedRevision: provider.revision });
  } catch (error) {
    // The stable slot remains valid for a retry. Do not put the secret in the
    // error or attempt to roll back the previous credential contents.
    throw error;
  }
}

export async function deleteProviderCredential(db: ControlPlaneDb, runtimeHome: string, providerId: string, options: ExpectedRevision = {}) {
  const provider = await requireProvider(db, providerId);
  const updated = await updateProvider(db, providerId, { credentialRef: null }, options.expectedRevision === undefined ? {} : options);
  if (provider.credentialRef?.startsWith('slot:provider/')) await new SecretStore(runtimeHome).deleteProviderSecret(providerId);
  return updated;
}

export { providerFromRow, modelFromRow };
