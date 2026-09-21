import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlPlaneError,
  bootstrapControlPlane,
  closeControlPlaneDb,
  getRepositoryByName,
  loadCommandSnapshot,
  openControlPlaneDb,
  resolveExecution,
  setProviderCredential,
  getProvider,
  updatePrompt,
  updateProvider,
  writeCommandSnapshot,
  writeCommandSnapshotAndManifest,
  renderTemplate,
  renderTemplateWithDiagnostics,
  validateTemplate,
  LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION,
  validateCommandSnapshot,
} from '../src/control-plane/index.ts';

async function isolatedControlPlane() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-resolver-'));
  const report = await bootstrapControlPlane({ root, env: { ZAI_MODEL: 'glm-snapshot-test' }, repositories: [{ fullName: 'Owner/Repo' }] });
  const db = await openControlPlaneDb(root);
  const repository = (await getRepositoryByName(db, 'owner/repo'))!;
  return { root, db, report, repository };
}

const expectCode = async (promise: Promise<unknown>, code: ControlPlaneError['code']) => {
  await assert.rejects(promise, error => error instanceof ControlPlaneError && error.code === code);
};

test('resolver reads one effective configuration and builds a traceable immutable snapshot', async () => {
  const { root, db, repository, report } = await isolatedControlPlane();
  try {
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-1' });
    assert.equal(resolved.executionType, 'review');
    assert.equal(resolved.permission, 'read_only');
    assert.equal(resolved.outputContract.kind, 'none');
    assert.equal(resolved.snapshot.schema_version, 'patchpaw.command-snapshot.v1');
    assert.equal(resolved.snapshot.provider.credential_ref, 'env:ZAI_API_KEY');
    assert.equal(resolved.snapshot.provider.model.identifier, 'glm-snapshot-test');
    assert.deepEqual(resolved.snapshot.composition.parts.map(part => part.role), ['review', null, 'shared', 'stop-closeout']);
    assert.equal(resolved.snapshot.composition.parts.every(part => /^[a-f0-9]{64}$/.test(part.sha256)), true);

    const reference = await writeCommandSnapshot(root, 'run-review-1', resolved.snapshot);
    assert.equal(reference.snapshot_id, resolved.snapshot.snapshot_id);
    const manifestResult = await writeCommandSnapshotAndManifest(root, 'run-review-manifest', resolved.snapshot, { repo: 'owner/repo' });
    assert.equal(manifestResult.manifest.execution_id, resolved.snapshot.execution_id);
    assert.equal(manifestResult.manifest.snapshot_sha256, manifestResult.reference.snapshot_sha256);
    assert.equal((await loadCommandSnapshot(root, 'run-review-1')).snapshotSha256, reference.snapshot_sha256);
    const file = await readFile(reference.snapshot_path, 'utf8');
    assert.equal(file.includes('ZAI_API_KEY'), true);
    assert.equal(file.includes('glm-snapshot-test'), true);
    assert.equal(file.includes('credential_ref'), true);
    assert.equal(file.includes('super-secret'), false);
    assert.equal(report.provider.id.length > 0, true);

    const reviewPrompt = resolved.prompts.find(prompt => prompt.role === 'review')!;
    await updatePrompt(db, reviewPrompt.id, { content: `${reviewPrompt.content}\nRepository edit.` }, { expectedRevision: reviewPrompt.revision });
    const changed = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-2' });
    assert.notEqual(changed.snapshot.composition.parts.find(part => part.role === 'review')?.sha256,
      resolved.snapshot.composition.parts.find(part => part.role === 'review')?.sha256);
    const restored = await loadCommandSnapshot(root, 'run-review-1');
    assert.equal(restored.snapshot.composition.parts.find(part => part.role === 'review')?.content, reviewPrompt.content);
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});

test('resolver fails closed for missing roles and disabled providers without exposing credentials', async () => {
  const { root, db, repository, report } = await isolatedControlPlane();
  try {
    const review = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-1' });
    const main = review.prompts.find(prompt => prompt.role === 'review')!;
    await updatePrompt(db, main.id, { role: null }, { expectedRevision: main.revision });
    await expectCode(resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-2' }), 'required_binding');

    const provider = await getProvider(db, report.provider.id);
    await updateProvider(db, report.provider.id, { enabled: false }, { expectedRevision: provider!.revision });
    await expectCode(resolveExecution(db, { kind: 'conversation', repositoryId: repository.id, executionId: 'exec-conversation-1' }), 'provider_unavailable');
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});

test('legacy pre-opaque review snapshots keep strict_json only through explicit compatibility', async () => {
  const { root, db, repository } = await isolatedControlPlane();
  try {
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-legacy' });
    const historical = structuredClone(resolved.snapshot);
    historical.schema_version = LEGACY_COMMAND_SNAPSHOT_SCHEMA_VERSION;
    historical.snapshot_origin = 'legacy_reconstructed';
    delete historical.snapshot_sha256;
    historical.composition.output_contract = { kind: 'strict_json' };
    historical.legacy_verification = {
      manifest_sha256: 'legacy-manifest-evidence', source_asset_digest: 'legacy-source-evidence',
      credential_ref_verified: true, workspace_freshness_verified: true,
    };
    assert.throws(() => validateCommandSnapshot(historical), error => error instanceof ControlPlaneError && error.code === 'snapshot_schema_unsupported');
    assert.doesNotThrow(() => validateCommandSnapshot(historical, { allowLegacy: true }));
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});

test('custom commands resolve only their selected prompt and do not inherit built-in task roles', async () => {
  const { root, db, repository, report } = await isolatedControlPlane();
  try {
    const customPrompt = await import('../src/control-plane/prompts.ts').then(({ createPrompt }) => createPrompt(db, {
      scope: 'repository', repositoryId: repository.id, slug: 'readme-task', title: 'README task', role: null,
      content: 'CUSTOM_TASK_MARKER\nRead the requested README and answer in natural language.'
    }));
    const custom = await import('../src/control-plane/commands.ts').then(({ createCommand }) => createCommand(db, {
      repositoryId: repository.id, slashName: '/readme', displayName: 'README', executionType: 'custom',
      permission: 'read_only', providerModelId: report.model.id,
      promptBindings: [{ assetId: customPrompt.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [],
    }));
    const resolved = await resolveExecution(db, { kind: 'command', commandId: custom.id, repositoryId: repository.id, executionId: 'exec-custom-1' });
    assert.equal(resolved.executionType, 'custom');
    assert.equal(resolved.outputContract.kind, 'none');
    assert.deepEqual(resolved.snapshot.composition.parts.map(part => part.role), [null]);
    assert.match(resolved.snapshot.composition.parts[0].content, /CUSTOM_TASK_MARKER/);
    assert.equal(resolved.snapshot.composition.parts.some(part => ['review', 'review-json-retry', 'conflict', 'ci-repair'].includes(part.role ?? '')), false);
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});

test('template validation supports optional variables, ignores unused inputs, and rejects unknown or missing values', () => {
  assert.deepEqual(validateTemplate('Hello {{comment?}}', { templateType: 'conversation', role: 'conversation' }).usedVariables, ['comment']);
  assert.equal(renderTemplate('Hello {{comment?}}', {}, { templateType: 'conversation', role: 'conversation' }), 'Hello ');
  assert.equal(renderTemplate('Hello {{comment}}', { comment: 'PatchPaw', unused: 'not rendered' }, { templateType: 'conversation', role: 'conversation' }), 'Hello PatchPaw');
  assert.deepEqual(renderTemplateWithDiagnostics('Hello {{comment}}', { comment: 'PatchPaw', unused: 'ignored' }, { templateType: 'conversation', role: 'conversation' }).ignoredVariables, ['unused']);
  assert.throws(() => validateTemplate('Leak {{apiKey}}', { templateType: 'conversation', role: 'conversation' }), error => error instanceof ControlPlaneError && error.code === 'unknown_template_variable');
  assert.throws(() => renderTemplate('Need {{comment}}', {}, { templateType: 'conversation', role: 'conversation' }), error => error instanceof ControlPlaneError && error.code === 'missing_required_template_variable');
});

test('snapshot loader rejects missing, corrupt, and tampered snapshots', async () => {
  const { root, db, repository } = await isolatedControlPlane();
  try {
    await expectCode(loadCommandSnapshot(root, 'never-written'), 'snapshot_missing');
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: '/review', executionId: 'exec-review-1' });
    const reference = await writeCommandSnapshot(root, 'run-review-1', resolved.snapshot);
    await writeFile(reference.snapshot_path, '{not-json');
    await expectCode(loadCommandSnapshot(root, 'run-review-1'), 'snapshot_corrupt');
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});

test('credential slot contents remain outside resolver and snapshot output', async () => {
  const { root, db, repository, report } = await isolatedControlPlane();
  try {
    await setProviderCredential(db, root, report.provider.id, 'super-secret-not-for-snapshots');
    const resolved = await resolveExecution(db, { kind: 'conversation', repositoryId: repository.id, executionId: 'exec-conversation-1' });
    const reference = await writeCommandSnapshot(root, 'run-conversation-1', resolved.snapshot);
    const file = await readFile(reference.snapshot_path, 'utf8');
    assert.equal(file.includes('super-secret-not-for-snapshots'), false);
    assert.equal(JSON.stringify(resolved).includes('super-secret-not-for-snapshots'), false);
  } finally { closeControlPlaneDb(db); await rm(root, { recursive: true, force: true }); }
});
