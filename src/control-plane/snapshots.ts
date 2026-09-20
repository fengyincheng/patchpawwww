import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patchpawPaths } from '../config/paths.ts';
import { ControlPlaneError } from './errors.ts';
import { outputContractForTemplate } from './templates.ts';

function normalizeLineEndings(value: string) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export const COMMAND_SNAPSHOT_SCHEMA_VERSION = 'patchpaw.command-snapshot.v1';
export const LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION = 'patchpaw.command-snapshot.legacy-v1';
export const TOOLSET_VERSION = 'patchpaw-toolset-v1';

export type SnapshotTarget = 'command' | 'conversation';
export type SnapshotOutputContract = { kind: 'strict_json' | 'human_markdown' | 'none'; schema_id?: string; schema_sha256?: string };
export type SnapshotOutputBudget = {
  requested: number;
  effective: number;
  source: 'default' | 'max_tokens' | 'max_output_tokens' | 'max_completion_tokens';
  wire_key: 'max_tokens' | 'max_completion_tokens';
  capability?: number;
};

export interface CommandSnapshotPart {
  kind: 'prompt' | 'skill';
  position: number;
  asset_id: string;
  slug: string;
  role: string | null;
  revision: number;
  sha256: string;
  content: string;
}

export interface CommandSnapshot {
  schema_version: typeof COMMAND_SNAPSHOT_SCHEMA_VERSION | typeof LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION;
  snapshot_id: string;
  snapshot_sha256?: string;
  snapshot_origin?: 'control_plane' | 'legacy_reconstructed';
  legacy_verification?: {
    manifest_sha256: string;
    source_asset_digest: string;
    credential_ref_verified: true;
    workspace_freshness_verified: true;
  };
  execution_id: string;
  repository: { id: string; full_name: string };
  target: SnapshotTarget;
  template_type: 'conversation' | 'custom' | 'review' | 'repair' | 'ci' | 'conflict';
  command?: { id: string; slash_name: string; revision: number; execution_type: string; permission: 'read_only' | 'read_write' | 'read_write_approval'; enabled: boolean };
  conversation_profile?: { id: string; revision: number; permission: 'read_only'; enabled: boolean };
  composition: { output_contract: SnapshotOutputContract; parts: CommandSnapshotPart[] };
  /** Optional for legacy snapshots; new resolver snapshots freeze the effective cap here. */
  output_budget?: SnapshotOutputBudget;
  provider: {
    id: string;
    type: string;
    display_name: string;
    base_url: string;
    revision: number;
    credential_ref: string;
    model: { id: string; identifier: string; display_name: string; revision: number };
    request_options: Record<string, string | number | boolean>;
  };
  toolset_version: string;
  snapshot_created_at: string;
}

export interface SnapshotReference {
  execution_id: string;
  snapshot_id: string;
  snapshot_sha256: string;
  snapshot_schema_version: string;
  snapshot_path: string;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortedValue(entry)]));
  }
  if (typeof value === 'string') return normalizeLineEndings(value);
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(sortedValue(value));
}

export function sha256Canonical(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function snapshotPayload(snapshot: CommandSnapshot) {
  const { snapshot_sha256: _ignored, ...payload } = snapshot;
  return payload;
}

export function snapshotSha256(snapshot: CommandSnapshot) {
  return sha256Canonical(snapshotPayload(snapshot));
}

function snapshotError(code: ControlPlaneError['code'], message: string, field?: string): never {
  throw new ControlPlaneError(code, message, field);
}

function assertSafeRequestOptions(options: Record<string, string | number | boolean>) {
  // This is the durable, non-sensitive union accepted by the five stage-04
  // adapters. The adapter, not the snapshot layer, decides which extension
  // is valid for a particular provider.
  const allowed = new Set([
    'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'max_completion_tokens',
    'presence_penalty', 'frequency_penalty', 'seed', 'reasoning_effort', 'thinking',
    'enable_thinking', 'thinking_budget', 'http_referer', 'x_openrouter_title', 'stream',
  ]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) {
      snapshotError('invalid_configuration', 'Provider request options contain an unsupported or sensitive field.', 'request_options');
    }
    if (['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'].includes(key) && typeof value !== 'number') {
      snapshotError('invalid_configuration', 'Provider request options contain an invalid non-sensitive value.', 'request_options');
    }
    if (['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'seed'].includes(key) && (!Number.isSafeInteger(value) || Number(value) < 1)) {
      snapshotError('invalid_configuration', 'Provider request options contain an invalid non-sensitive value.', 'request_options');
    }
    if (['stream', 'thinking', 'enable_thinking'].includes(key) && typeof value !== 'boolean') {
      snapshotError('invalid_configuration', 'Provider request options contain an invalid non-sensitive value.', 'request_options');
    }
    if (['http_referer', 'x_openrouter_title'].includes(key) && (typeof value !== 'string' || value.trim() === '')) {
      snapshotError('invalid_configuration', 'Provider request options contain an invalid non-sensitive value.', 'request_options');
    }
    if (key === 'thinking_budget' && (!Number.isSafeInteger(value) || Number(value) < 1)) {
      snapshotError('invalid_configuration', 'Provider request options contain an invalid non-sensitive value.', 'request_options');
    }
    if (key === 'reasoning_effort' && (typeof value !== 'string' || !['minimal', 'low', 'medium', 'high', 'max', 'none', 'auto'].includes(value))) {
      snapshotError('invalid_configuration', 'Provider request options contain an unsupported value.', 'request_options');
    }
  }
}

function normalizeSnapshot(snapshot: CommandSnapshot): CommandSnapshot {
  const normalized = structuredClone(snapshot) as CommandSnapshot;
  normalized.snapshot_sha256 = snapshot.snapshot_sha256;
  if (normalized.composition && Array.isArray(normalized.composition.parts)) {
    for (const part of normalized.composition.parts) {
      if (typeof part.content === 'string') {
        part.content = normalizeLineEndings(part.content);
      }
    }
  }
  return normalized;
}

export function validateCommandSnapshot(input: unknown, options: { allowLegacy?: boolean } = {}) {
  if (!input || typeof input !== 'object') snapshotError('snapshot_corrupt', 'Command snapshot is not an object.');
  const snapshot = normalizeSnapshot(input as CommandSnapshot);
  if (![COMMAND_SNAPSHOT_SCHEMA_VERSION, LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION].includes(snapshot.schema_version)) {
    snapshotError('snapshot_schema_unsupported', 'Command snapshot schema version is unsupported.', 'schema_version');
  }
  if (snapshot.schema_version === LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION && !options.allowLegacy) {
    snapshotError('snapshot_schema_unsupported', 'Legacy command snapshots require an explicit compatibility path.', 'schema_version');
  }
  if (typeof snapshot.snapshot_id !== 'string' || snapshot.snapshot_id.length === 0 || typeof snapshot.execution_id !== 'string' || snapshot.execution_id.length === 0) {
    snapshotError('snapshot_corrupt', 'Command snapshot identity is missing.');
  }
  if (snapshot.schema_version === LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION && snapshot.snapshot_origin !== 'legacy_reconstructed') {
    snapshotError('snapshot_corrupt', 'Legacy command snapshot origin is not verifiable.', 'snapshot_origin');
  }
  if (snapshot.schema_version === LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION && (!snapshot.legacy_verification ||
      snapshot.legacy_verification.credential_ref_verified !== true || snapshot.legacy_verification.workspace_freshness_verified !== true ||
      !snapshot.legacy_verification.manifest_sha256 || !snapshot.legacy_verification.source_asset_digest)) {
    snapshotError('snapshot_corrupt', 'Legacy command snapshot lacks verification evidence.', 'legacy_verification');
  }
  if (!snapshot.repository?.id || !snapshot.repository.full_name || !snapshot.provider?.id || !snapshot.provider.type ||
      !snapshot.provider.base_url || !snapshot.provider.credential_ref || !snapshot.provider.model?.id || !snapshot.provider.model.identifier) {
    snapshotError('snapshot_corrupt', 'Command snapshot is missing provider or repository identity.');
  }
  if (!/^env:[A-Z_][A-Z0-9_]*$/.test(snapshot.provider.credential_ref) && !/^slot:provider\/[A-Za-z0-9-]+$/.test(snapshot.provider.credential_ref)) {
    snapshotError('snapshot_corrupt', 'Command snapshot credential reference is invalid.', 'credential_ref');
  }
  try {
    const baseUrl = new URL(snapshot.provider.base_url);
    if (baseUrl.username || baseUrl.password || [...baseUrl.searchParams.keys()].some(key => /(secret|token|password|authorization|api[_-]?key)/i.test(key))) {
      snapshotError('snapshot_corrupt', 'Command snapshot provider URL contains credential material.', 'base_url');
    }
  } catch {
    snapshotError('snapshot_corrupt', 'Command snapshot provider URL is invalid.', 'base_url');
  }
  if (!['conversation', 'custom', 'review', 'repair', 'ci', 'conflict'].includes(snapshot.template_type)) {
    snapshotError('snapshot_corrupt', 'Command snapshot template type is invalid.', 'template_type');
  }
  if (!snapshot.toolset_version || !snapshot.snapshot_created_at) snapshotError('snapshot_corrupt', 'Command snapshot metadata is incomplete.');
  if (snapshot.output_budget !== undefined) {
    const output = snapshot.output_budget;
    if (!Number.isSafeInteger(output.requested) || output.requested < 1 || !Number.isSafeInteger(output.effective) || output.effective < 1
      || output.effective > output.requested || !['default', 'max_tokens', 'max_output_tokens', 'max_completion_tokens'].includes(output.source)
      || !['max_tokens', 'max_completion_tokens'].includes(output.wire_key)
      || (output.source === 'max_completion_tokens' && output.wire_key !== 'max_completion_tokens')
      || (output.source !== 'max_completion_tokens' && output.wire_key !== 'max_tokens')
      || (output.capability !== undefined && (!Number.isSafeInteger(output.capability) || output.capability < 1))) {
      snapshotError('snapshot_corrupt', 'Command snapshot output budget is invalid.', 'output_budget');
    }
    if (output.capability !== undefined && output.effective > output.capability) {
      snapshotError('snapshot_corrupt', 'Command snapshot output budget exceeds the model capability.', 'output_budget');
    }
  }
  if (snapshot.target === 'command') {
    if (!snapshot.command) snapshotError('snapshot_corrupt', 'Command snapshot is missing command identity.', 'command');
    if (snapshot.command.execution_type !== snapshot.template_type || !['read_only', 'read_write', 'read_write_approval'].includes(snapshot.command.permission)) {
      snapshotError('snapshot_corrupt', 'Command snapshot template and permission do not match.', 'command');
    }
  } else if (snapshot.target === 'conversation') {
    if (!snapshot.conversation_profile) snapshotError('snapshot_corrupt', 'Conversation snapshot is missing profile identity.', 'conversation_profile');
    if (snapshot.template_type !== 'conversation' || snapshot.conversation_profile.permission !== 'read_only') {
      snapshotError('snapshot_corrupt', 'Conversation snapshot has an invalid execution contract.', 'conversation_profile');
    }
  } else snapshotError('snapshot_corrupt', 'Command snapshot target is invalid.', 'target');
  if (!snapshot.composition || !Array.isArray(snapshot.composition.parts) || !snapshot.composition.output_contract) {
    snapshotError('snapshot_corrupt', 'Command snapshot composition is missing.');
  }
  const expectedOutput = outputContractForTemplate(snapshot.template_type);
  const actualOutput = snapshot.composition.output_contract;
  // Pre-opaque snapshots used strict JSON for review/conflict. They remain
  // readable on the explicit compatibility path, while fresh resolver
  // snapshots are marked control_plane and must use the natural-language
  // contract.
  const legacyStructuredOutput = snapshot.snapshot_origin !== 'control_plane'
    && ['review', 'conflict'].includes(snapshot.template_type)
    && actualOutput.kind === 'strict_json';
  if (!legacyStructuredOutput && (actualOutput.kind !== expectedOutput.kind || (expectedOutput.schemaId && actualOutput.schema_id !== expectedOutput.schemaId) ||
      (!expectedOutput.schemaId && actualOutput.schema_id !== undefined))) {
    snapshotError('snapshot_corrupt', 'Command snapshot output contract does not match its template.', 'output_contract');
  }
  if (!snapshot.provider.request_options || typeof snapshot.provider.request_options !== 'object' || Array.isArray(snapshot.provider.request_options)) {
    snapshotError('snapshot_corrupt', 'Provider request options are not an object.', 'request_options');
  }
  assertSafeRequestOptions(snapshot.provider.request_options);
  const positions = new Set<number>();
  for (const part of snapshot.composition.parts) {
    if (!['prompt', 'skill'].includes(part.kind) || !Number.isSafeInteger(part.position) || part.position < 1 || positions.has(part.position)) {
      snapshotError('snapshot_corrupt', 'Command snapshot composition order is invalid.', 'composition.parts');
    }
    positions.add(part.position);
    if (!part.asset_id || !part.slug || typeof part.content !== 'string' || part.content.length === 0 || !/^[a-f0-9]{64}$/.test(part.sha256)) {
      snapshotError('snapshot_corrupt', 'Command snapshot asset metadata is incomplete.', 'composition.parts');
    }
    const digest = createHash('sha256').update(normalizeLineEndings(part.content), 'utf8').digest('hex');
    if (digest !== part.sha256) snapshotError('snapshot_integrity_mismatch', 'Command snapshot asset content hash does not match.', 'composition.parts');
  }
  if (snapshot.snapshot_sha256 && snapshot.snapshot_sha256 !== snapshotSha256(snapshot)) {
    snapshotError('snapshot_integrity_mismatch', 'Command snapshot hash does not match its content.', 'snapshot_sha256');
  }
  return snapshot;
}

export function serializeCommandSnapshot(snapshot: CommandSnapshot, options: { allowLegacy?: boolean } = {}) {
  const normalized = validateCommandSnapshot(snapshot, options);
  const withHash = { ...normalized, snapshot_sha256: snapshotSha256(normalized) };
  return `${canonicalJson(withHash)}\n`;
}

function assertRunId(runId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) snapshotError('invalid_configuration', 'Run id is not a safe runtime identifier.', 'run_id');
}

export async function writeCommandSnapshot(runtimeHome: string, runId: string, snapshot: CommandSnapshot, options: { allowLegacy?: boolean } = {}): Promise<SnapshotReference> {
  assertRunId(runId);
  const normalized = validateCommandSnapshot(snapshot, options);
  const serialized = serializeCommandSnapshot(normalized, options);
  const hash = snapshotSha256(normalized);
  const path = join(patchpawPaths(runtimeHome).runs, runId, 'command-snapshot.json');
  await mkdir(join(patchpawPaths(runtimeHome).runs, runId), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path, 'utf8');
    const loaded = validateCommandSnapshot(JSON.parse(existing), options);
    if (snapshotSha256(loaded) !== hash) snapshotError('snapshot_immutable_conflict', 'An immutable command snapshot already exists with different content.', 'snapshot_path');
    return { execution_id: loaded.execution_id, snapshot_id: loaded.snapshot_id, snapshot_sha256: snapshotSha256(loaded), snapshot_schema_version: loaded.schema_version, snapshot_path: path };
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') snapshotError('snapshot_corrupt', 'Existing command snapshot cannot be read safely.', 'snapshot_path');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    // A hard-link create is atomic and fails with EEXIST rather than replacing
    // a snapshot another worker won the race to create.
    await link(temporary, path);
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readFile(path, 'utf8').catch(() => undefined);
      if (!existing) snapshotError('snapshot_corrupt', 'Concurrent command snapshot creation left no readable file.', 'snapshot_path');
      try {
        const loaded = validateCommandSnapshot(JSON.parse(existing), options);
        if (snapshotSha256(loaded) !== hash) snapshotError('snapshot_immutable_conflict', 'An immutable command snapshot already exists with different content.', 'snapshot_path');
        return { execution_id: loaded.execution_id, snapshot_id: loaded.snapshot_id, snapshot_sha256: snapshotSha256(loaded), snapshot_schema_version: loaded.schema_version, snapshot_path: path };
      } catch (raceError) {
        if (raceError instanceof ControlPlaneError) throw raceError;
        snapshotError('snapshot_corrupt', 'Concurrent command snapshot cannot be read safely.', 'snapshot_path');
      }
    }
    throw error;
  }
  return { execution_id: normalized.execution_id, snapshot_id: normalized.snapshot_id, snapshot_sha256: hash, snapshot_schema_version: normalized.schema_version, snapshot_path: path };
}

export async function writeCommandSnapshotAndManifest(runtimeHome: string, runId: string, snapshot: CommandSnapshot,
  manifest: Record<string, unknown> = {}, options: { allowLegacy?: boolean } = {}) {
  const reference = await writeCommandSnapshot(runtimeHome, runId, snapshot, options);
  const paths = patchpawPaths(runtimeHome);
  const manifestPath = join(paths.runs, runId, 'manifest.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ControlPlaneError('snapshot_corrupt', 'Run manifest cannot be read safely.', 'manifest_path');
  }
  if (existing.execution_id !== undefined && existing.execution_id !== snapshot.execution_id) {
    throw new ControlPlaneError('snapshot_immutable_conflict', 'Run manifest execution does not match command snapshot.', 'execution_id');
  }
  if (manifest.execution_id !== undefined && manifest.execution_id !== snapshot.execution_id) {
    throw new ControlPlaneError('snapshot_immutable_conflict', 'Provided manifest execution does not match command snapshot.', 'execution_id');
  }
  const nextManifest = attachSnapshotReference({ ...existing, ...manifest }, reference);
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(nextManifest)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, manifestPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { reference, manifest: nextManifest, manifestPath };
}

export async function loadCommandSnapshot(runtimeHome: string, runId: string, options: { allowLegacy?: boolean } = {}) {
  assertRunId(runId);
  const path = join(patchpawPaths(runtimeHome).runs, runId, 'command-snapshot.json');
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') snapshotError('snapshot_missing', 'Command snapshot is missing; recovery cannot use current configuration.', 'snapshot_path');
    snapshotError('snapshot_corrupt', 'Command snapshot cannot be read safely.', 'snapshot_path');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { snapshotError('snapshot_corrupt', 'Command snapshot is not valid JSON.', 'snapshot_path'); }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { snapshot_sha256?: unknown }).snapshot_sha256 !== 'string') {
    snapshotError('snapshot_corrupt', 'Command snapshot has no durable content hash.', 'snapshot_sha256');
  }
  const snapshot = validateCommandSnapshot(parsed, options);
  return { snapshot, snapshotSha256: snapshotSha256(snapshot), path };
}

export function snapshotReference(snapshot: CommandSnapshot, snapshotPath = ''): SnapshotReference {
  const validated = validateCommandSnapshot(snapshot);
  return { execution_id: validated.execution_id, snapshot_id: validated.snapshot_id, snapshot_sha256: snapshotSha256(validated), snapshot_schema_version: validated.schema_version, snapshot_path: snapshotPath };
}

export function attachSnapshotReference<T extends Record<string, unknown>>(manifest: T, reference: SnapshotReference): T & {
  execution_id: string;
  snapshot_id: string; snapshot_sha256: string; snapshot_schema_version: string; snapshot_path: string;
} {
  return { ...manifest, execution_id: reference.execution_id, snapshot_id: reference.snapshot_id, snapshot_sha256: reference.snapshot_sha256,
    snapshot_schema_version: reference.snapshot_schema_version, snapshot_path: reference.snapshot_path } as T & {
      execution_id: string;
      snapshot_id: string; snapshot_sha256: string; snapshot_schema_version: string; snapshot_path: string;
    };
}
