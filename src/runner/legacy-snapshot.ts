import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { humanHelpSkill } from '../tasks/human-help.ts';
import { loadOperation, OPERATION_PROMPT_VERSION } from '../operation/load.ts';
import { SecretStore } from '../control-plane/secrets.ts';
import {
  COMMAND_SNAPSHOT_SCHEMA_VERSION,
  LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION,
  canonicalJson,
  loadCommandSnapshot,
  outputContractForTemplate,
  snapshotSha256,
  validateCommandSnapshot,
  writeCommandSnapshot,
  type CommandSnapshot,
} from '../control-plane/index.ts';
import { ControlPlaneError } from '../control-plane/errors.ts';
import { contentDigest } from '../control-plane/common.ts';
import { patchpawPaths } from '../config/paths.ts';
import { TOOLSET_VERSION } from '../control-plane/snapshots.ts';
import type { PausedWorkspace } from './resume.ts';

type LegacyTemplate = 'review' | 'ci' | 'conflict';

const PROVIDER_TYPES = new Set(['zhipu', 'deepseek', 'openrouter', 'kimi', 'qwen']);
const GENERATED_MANIFEST_KEYS = new Set([
  'command_id', 'command_revision', 'provider_id', 'model_id',
  'snapshot_path', 'snapshot_id', 'snapshot_sha256', 'snapshot_schema_version', 'snapshot_execution_id',
]);

function fail(message: string, field = 'legacy_snapshot'): never {
  throw new ControlPlaneError('snapshot_corrupt', message, field);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function manifestDigest(manifest: Record<string, unknown>) {
  return digest(Object.fromEntries(Object.entries(manifest).filter(([key]) => !GENERATED_MANIFEST_KEYS.has(key))));
}

function templateFromManifest(manifest: Record<string, unknown>): LegacyTemplate {
  const raw = String(manifest.template_type ?? manifest.task ?? manifest.command ?? '').trim().replace(/^\/+/, '').toLowerCase();
  if (raw === 'ci-repair') return 'ci';
  if (raw === 'review' || raw === 'ci' || raw === 'conflict') return raw;
  fail('Legacy manifest does not identify a supported model task.', 'template_type');
}

function assertManifestBasics(manifest: Record<string, unknown>, repo: string, prNumber: number, candidate: PausedWorkspace) {
  if (manifest.repo !== repo || Number(manifest.pr_number) !== prNumber) fail('Legacy manifest does not match the paused PR.', 'manifest');
  if (!Number.isSafeInteger(Number(manifest.execution_id)) || Number(manifest.execution_id) !== candidate.execution_id) fail('Legacy manifest execution identity is incomplete.', 'execution_id');
  if (typeof manifest.prompt_version !== 'string' || manifest.prompt_version !== OPERATION_PROMPT_VERSION) fail('Legacy prompt version cannot be verified.', 'prompt_version');
  if (typeof manifest.toolset_version !== 'string' || manifest.toolset_version !== TOOLSET_VERSION) fail('Legacy toolset version cannot be verified.', 'toolset_version');
  if (typeof manifest.initial_head_sha !== 'string' || typeof manifest.base_sha !== 'string' || typeof manifest.current_base_ref !== 'string' || typeof manifest.workspace_path !== 'string') {
    fail('Legacy manifest is missing Git/workspace freshness facts.', 'manifest');
  }
  if (manifest.workspace_path !== candidate.workspace.path) fail('Legacy manifest workspace does not match the paused workspace.', 'workspace_path');
}

function sourceLayout(template: LegacyTemplate) {
  const main = template === 'review' ? 'review' : template === 'ci' ? 'ci-repair' : 'conflict';
  const auxiliary = template === 'review'
    ? ['review-json-retry', 'stop-closeout']
    : ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'];
  return { main, auxiliary };
}

function sourceParts(template: LegacyTemplate) {
  const layout = sourceLayout(template);
  const prompts = [layout.main, 'shared', ...layout.auxiliary].map(slug => ({ kind: 'prompt' as const, slug, role: slug, content: loadOperation(slug) }));
  const skill = { kind: 'skill' as const, slug: 'patchpaw-human-help', role: null, content: humanHelpSkill.trim() };
  const ordered = [prompts[0], skill, prompts[1], ...prompts.slice(2)];
  return ordered.map((part, index) => ({ ...part, position: index + 1, asset_id: `legacy-${part.kind}-${part.slug}`, revision: 1,
    sha256: contentDigest(part.content) }));
}

function sourceAssetDigest(parts: ReturnType<typeof sourceParts>) {
  return digest(parts.map(part => ({ kind: part.kind, slug: part.slug, sha256: part.sha256 })));
}

function assertProviderManifest(manifest: Record<string, unknown>, snapshot: CommandSnapshot) {
  const providerType = String(manifest.provider_type ?? '');
  const baseUrl = String(manifest.base_url ?? manifest.provider ?? '');
  const model = String(manifest.model_identifier ?? manifest.model ?? '');
  if (!PROVIDER_TYPES.has(providerType) || !baseUrl || !model) fail('Legacy provider type, base URL or model identifier is incomplete.', 'provider');
  if (providerType !== snapshot.provider.type || baseUrl !== snapshot.provider.base_url || model !== snapshot.provider.model.identifier) {
    fail('Legacy snapshot provider facts do not match the legacy manifest.', 'provider');
  }
  if (String(manifest.credential_ref ?? '') !== snapshot.provider.credential_ref) fail('Legacy credential reference does not match the manifest.', 'credential_ref');
}

function assertSourceMatches(snapshot: CommandSnapshot, manifest: Record<string, unknown>) {
  const expected = sourceParts(snapshot.template_type as LegacyTemplate);
  const actual = snapshot.composition.parts.map(part => ({ kind: part.kind, slug: part.slug, sha256: part.sha256 }));
  const expectedDigest = sourceAssetDigest(expected);
  if (canonicalJson(actual) !== canonicalJson(expected.map(part => ({ kind: part.kind, slug: part.slug, sha256: part.sha256 })))) fail('Legacy snapshot source asset set is not the fixed operation/Skill layout.', 'source_asset_digest');
  if (String(manifest.source_asset_digest ?? '') !== expectedDigest || snapshot.legacy_verification?.source_asset_digest !== expectedDigest) fail('Legacy source asset digest cannot be verified.', 'source_asset_digest');
  for (const [index, part] of snapshot.composition.parts.entries()) {
    const source = expected[index];
    if (part.content !== source.content || part.sha256 !== source.sha256) fail('Legacy snapshot source asset content changed.', `composition.parts[${index}]`);
  }
}

async function assertLegacyEvidence(runtimeHome: string, runId: string, repo: string, prNumber: number, candidate: PausedWorkspace, snapshot: CommandSnapshot, manifest: Record<string, unknown>) {
  if (snapshot.schema_version !== LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION || snapshot.snapshot_origin !== 'legacy_reconstructed') fail('Legacy snapshot origin or schema is not verifiable.');
  assertManifestBasics(manifest, repo, prNumber, candidate);
  if (snapshot.execution_id !== `${candidate.run_id}:${candidate.execution_id}`) fail('Legacy snapshot execution identity does not match the paused execution.', 'execution_id');
  if (manifest.snapshot_execution_id !== undefined && manifest.snapshot_execution_id !== snapshot.execution_id) fail('Legacy snapshot execution reference does not match the manifest.', 'snapshot_execution_id');
  if (manifest.snapshot_sha256 !== undefined && manifest.snapshot_sha256 !== snapshotSha256(snapshot)) fail('Legacy snapshot hash does not match the manifest.', 'snapshot_sha256');
  if (manifest.snapshot_schema_version !== undefined && manifest.snapshot_schema_version !== snapshot.schema_version) fail('Legacy snapshot schema reference does not match the manifest.', 'snapshot_schema_version');
  if (manifest.snapshot_id !== undefined && manifest.snapshot_id !== snapshot.snapshot_id) fail('Legacy snapshot id does not match the manifest.', 'snapshot_id');
  if (snapshot.template_type !== templateFromManifest(manifest)) fail('Legacy snapshot task does not match the manifest.', 'template_type');
  assertProviderManifest(manifest, snapshot);
  assertSourceMatches(snapshot, manifest);
  if (snapshot.legacy_verification?.manifest_sha256 !== manifestDigest(manifest)) fail('Legacy manifest digest cannot be verified.', 'manifest_sha256');
  const credentialRef = snapshot.provider.credential_ref;
  if (!/^slot:provider\/[A-Za-z0-9-]+$/.test(credentialRef) || !(await new SecretStore(runtimeHome).isConfigured(credentialRef))) fail('Legacy credential slot is unavailable or is not stable.', 'credential_ref');
}

async function readLegacyManifest(runtimeHome: string, runId: string) {
  try { return JSON.parse(await readFile(join(patchpawPaths(runtimeHome).runs, runId, 'manifest.json'), 'utf8')) as Record<string, unknown>; }
  catch { fail('Legacy run manifest is missing or unreadable.', 'manifest'); }
}

async function reconstruct(runtimeHome: string, runId: string, repo: string, prNumber: number, candidate: PausedWorkspace, manifest: Record<string, unknown>) {
  assertManifestBasics(manifest, repo, prNumber, candidate);
  const template = templateFromManifest(manifest);
  const parts = sourceParts(template);
  const expectedDigest = sourceAssetDigest(parts);
  if (manifest.source_asset_digest !== expectedDigest) fail('Legacy source asset digest does not match current source assets.', 'source_asset_digest');
  const providerType = String(manifest.provider_type ?? '');
  const baseUrl = String(manifest.base_url ?? manifest.provider ?? '');
  const modelIdentifier = String(manifest.model_identifier ?? manifest.model ?? '');
  const credentialRef = String(manifest.credential_ref ?? '');
  if (!PROVIDER_TYPES.has(providerType) || !baseUrl || !modelIdentifier || !/^slot:provider\/[A-Za-z0-9-]+$/.test(credentialRef) || !(await new SecretStore(runtimeHome).isConfigured(credentialRef))) {
    fail('Legacy provider facts or stable credential slot cannot be verified.', 'provider');
  }
  const permission = template === 'review' ? 'read_only' as const : 'read_write' as const;
  const providerId = `legacy-provider-${contentDigest(`${providerType}:${baseUrl}:${credentialRef}`).slice(0, 24)}`;
  const modelId = `legacy-model-${contentDigest(`${providerId}:${modelIdentifier}`).slice(0, 24)}`;
  const commandId = `legacy-command-${contentDigest(`${repo}:${prNumber}:${template}`).slice(0, 24)}`;
  const snapshot: CommandSnapshot = {
    schema_version: LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION, snapshot_id: `legacy-snap-${contentDigest(`${runId}:${candidate.execution_id}:${expectedDigest}`).slice(0, 24)}`,
    snapshot_origin: 'legacy_reconstructed', execution_id: `${candidate.run_id}:${candidate.execution_id}`,
    repository: { id: `legacy-repo-${contentDigest(repo).slice(0, 24)}`, full_name: repo }, target: 'command', template_type: template,
    command: { id: commandId, slash_name: template, revision: 1, execution_type: template, permission, enabled: true },
    composition: { output_contract: (() => { const contract = outputContractForTemplate(template); return { kind: contract.kind, ...(contract.schemaId ? { schema_id: contract.schemaId } : {}) }; })(), parts },
    provider: { id: providerId, type: providerType, display_name: providerType, base_url: baseUrl, revision: 1, credential_ref: credentialRef,
      model: { id: modelId, identifier: modelIdentifier, display_name: modelIdentifier, revision: 1 },
      request_options: typeof manifest.request_options === 'object' && manifest.request_options ? manifest.request_options as Record<string, string | number | boolean>
        : manifest.reasoning_effort ? { reasoning_effort: String(manifest.reasoning_effort) } : {} },
    toolset_version: TOOLSET_VERSION, snapshot_created_at: new Date().toISOString(),
    legacy_verification: { manifest_sha256: manifestDigest(manifest), source_asset_digest: expectedDigest, credential_ref_verified: true, workspace_freshness_verified: true },
  };
  validateCommandSnapshot(snapshot, { allowLegacy: true });
  await writeCommandSnapshot(runtimeHome, runId, snapshot, { allowLegacy: true });
  return loadCommandSnapshot(runtimeHome, runId, { allowLegacy: true });
}

export async function loadOrReconstructLegacySnapshot(runtimeHome: string, runId: string, repo: string, prNumber: number, candidate: PausedWorkspace) {
  const manifest = await readLegacyManifest(runtimeHome, candidate.run_id);
  let loaded;
  try { loaded = await loadCommandSnapshot(runtimeHome, candidate.run_id, { allowLegacy: true }); }
  catch (error) {
    if (!(error instanceof ControlPlaneError) || error.code !== 'snapshot_missing') throw error;
    loaded = await reconstruct(runtimeHome, candidate.run_id, repo, prNumber, candidate, manifest);
  }
  if (loaded.snapshot.schema_version === COMMAND_SNAPSHOT_SCHEMA_VERSION) return loaded;
  await assertLegacyEvidence(runtimeHome, candidate.run_id, repo, prNumber, candidate, loaded.snapshot, manifest);
  return loaded;
}
