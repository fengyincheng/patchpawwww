import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { patchpawPaths } from '../src/config/paths.ts';
import {
  ControlPlaneError,
  bootstrapControlPlane,
  closeControlPlaneDb,
  copyPublicPrompt,
  copyPublicSkill,
  createCommand,
  createProvider,
  createProviderModel,
  createPrompt,
  createRepository,
  createSkill,
  deleteProviderModel,
  deletePrompt,
  deleteSkill,
  discoverManagedRepositories,
  getCommand,
  getConversationProfile,
  getProvider,
  getRepository,
  getProviderModel,
  listCommands,
  listPrompts,
  listProviderModels,
  listProviders,
  listSkills,
  openControlPlaneDb,
  PROVIDER_TYPES,
  SecretStore,
  setProviderCredential,
  updateCommand,
  updatePrompt,
} from '../src/control-plane/index.ts';

const expectCode = async (promise: Promise<unknown>, code: ControlPlaneError['code']) => {
  await assert.rejects(promise, error => error instanceof ControlPlaneError && error.code === code);
};

test('control-plane schema, paths, revisions, copy independence, and atomic command bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-control-plane-'));
  const db = await openControlPlaneDb(root);
  try {
    assert.equal((await db.execute('PRAGMA journal_mode')).rows[0].journal_mode, 'wal');
    assert.equal(await db.getMeta('schema_version'), '3');
    assert.equal(await db.getMeta('migration_version'), '3');
    assert.equal(patchpawPaths(root).controlPlaneDb, db.path);
    assert.notEqual(db.path, patchpawPaths(root).communicationDb);

    const publicPrompt = await createPrompt(db, { scope: 'public', slug: 'review', title: 'Review', role: 'review', content: 'public review v1' });
    const publicSkill = await createSkill(db, { scope: 'public', slug: 'rules', title: 'Rules', content: '# Rules v1' });
    const repository = await createRepository(db, { fullName: 'Owner/Repo' });
    const repoPrompt = await copyPublicPrompt(db, repository.id, publicPrompt.id);
    const repoSkill = await copyPublicSkill(db, repository.id, publicSkill.id);
    assert.equal(repoPrompt.scope, 'repository');
    assert.equal(repoPrompt.sourcePublicId, publicPrompt.id);
    assert.equal(repoPrompt.sourcePublicRevision, 1);

    await updatePrompt(db, publicPrompt.id, { content: 'public review v2' }, { expectedRevision: 1 });
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id }))[0].content, 'public review v1');
    await expectCode(copyPublicPrompt(db, repository.id, publicPrompt.id), 'slug_conflict');

    const changed = await updatePrompt(db, repoPrompt.id, { content: 'repository review' }, { expectedRevision: 1 });
    assert.equal(changed.revision, 2);
    await expectCode(updatePrompt(db, repoPrompt.id, { content: 'lost update' }, { expectedRevision: 1 }), 'revision_conflict');

    const provider = await createProvider(db, { type: 'zhipu', displayName: 'Zhipu', baseUrl: 'https://provider.test/v1', credentialRef: 'env:ZAI_API_KEY' });
    const modelA = await createProviderModel(db, { providerId: provider.id, modelIdentifier: 'glm-4-example' });
    const modelB = await createProviderModel(db, { providerId: provider.id, modelIdentifier: 'glm-5-example' });
    assert.deepEqual((await listProviderModels(db, provider.id)).map(model => model.modelIdentifier), ['glm-4-example', 'glm-5-example']);
    const command = await createCommand(db, { repositoryId: repository.id, slashName: '/Review-Custom', displayName: 'Custom review', executionType: 'review', permission: 'read_only', providerModelId: modelA.id,
      promptBindings: [{ assetId: repoPrompt.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [{ assetId: repoSkill.id, position: 1, enabled: true }] });
    assert.equal(command.slashName, 'review-custom');
    assert.equal(command.providerModelId, modelA.id);
    assert.equal((await getCommand(db, command.id))?.promptBindings[0].assetId, repoPrompt.id);
    await expectCode(updateCommand(db, command.id, { providerModelId: modelB.id, promptBindings: [{ assetId: publicPrompt.id, position: 1, enabled: true, bindingKind: 'main' }] }, { expectedRevision: command.revision }), 'invalid_configuration');
    const afterRollback = (await getCommand(db, command.id))!;
    assert.equal(afterRollback.providerModelId, modelA.id);
    assert.equal(afterRollback.promptBindings[0].assetId, repoPrompt.id);
    await expectCode(deletePrompt(db, repoPrompt.id, { expectedRevision: changed.revision }), 'referenced_resource');
    await expectCode(deleteProviderModel(db, modelA.id, { expectedRevision: 1 }), 'referenced_resource');
    assert.equal((await getProvider(db, provider.id))?.credentialRef, 'env:ZAI_API_KEY');
  } finally { closeControlPlaneDb(db); }
});

test('provider credentials use an isolated 0600 slot and never appear in returned resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-secrets-'));
  const db = await openControlPlaneDb(root);
  try {
    const provider = await createProvider(db, { type: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://provider.test/v1' });
    for (const type of PROVIDER_TYPES.filter(value => value !== 'deepseek')) {
      await createProvider(db, { type, displayName: type, baseUrl: 'https://provider.test/v1' });
    }
    const updated = await setProviderCredential(db, root, provider.id, 'not-a-real-secret');
    const path = patchpawPaths(root).providerSecrets;
    const slot = join(path, `${provider.id}.key`);
    assert.equal(updated.credentialRef, `slot:provider/${provider.id}`);
    assert.equal(await readFile(slot, 'utf8'), 'not-a-real-secret');
    if (process.platform !== 'win32') assert.equal((await stat(slot)).mode & 0o777, 0o600);
    else assert.equal(await new SecretStore(root).isConfigured(updated.credentialRef), true);
    assert.equal(JSON.stringify(updated).includes('not-a-real-secret'), false);
    assert.equal(JSON.stringify(updated).includes('Authorization'), false);
  } finally { closeControlPlaneDb(db); }
});

test('bootstrap is isolated, seeds every source asset, and is idempotent under concurrent initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-bootstrap-'));
  const env = { ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4', ZAI_MODEL: 'glm-test-bootstrap', ZAI_REASONING_EFFORT: 'high' };
  const operationHashes = await Promise.all((await readdir(join(process.cwd(), 'operation'))).filter(file => file.endsWith('.md')).map(async file => [file, createHash('sha256').update(await readFile(join(process.cwd(), 'operation', file))).digest('hex')] as const));

  const [first, second] = await Promise.all([
    bootstrapControlPlane({ root, env, repositories: [{ fullName: 'Owner/Repo' }] }),
    bootstrapControlPlane({ root, env, repositories: [{ fullName: 'owner/repo' }] }),
  ]);
  assert.equal(first.repositories.length, 1);
  assert.equal(second.repositories.length, 1);
  assert.equal(first.publicPrompts.length, operationHashes.length);
  assert.equal(first.publicSkills.length, 1);
  assert.equal(first.provider.credentialRef, 'env:ZAI_API_KEY');
  assert.equal(first.provider.requestOptions.reasoning_effort, 'high');
  const db = await openControlPlaneDb(root);
  try {
    const repository = (await import('../src/control-plane/repositories.ts')).getRepositoryByName;
    const managed = (await repository(db, 'owner/repo'))!;
    const beforeRevision = managed.revision;
    const commands = await listCommands(db, managed.id);
    assert.deepEqual(commands.map(command => command.slashName), ['ci', 'conflict', 'review']);
    assert.equal(commands.find(command => command.slashName === 'review')?.permission, 'read_only');
    assert.equal(commands.find(command => command.slashName === 'ci')?.permission, 'read_write');
    assert.ok(await getConversationProfile(db, managed.id));
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).length, first.publicPrompts.length);
    assert.equal((await listSkills(db, { scope: 'repository', repositoryId: managed.id })).length, 1);
    const removable = (await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.slug === 'runtime-budget')!;
    await deletePrompt(db, removable.id, { expectedRevision: removable.revision });
    const publicReview = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review')!;
    await updatePrompt(db, publicReview.id, { content: 'public changed after bootstrap' }, { expectedRevision: publicReview.revision });
    const beforeRerun = (await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.slug === 'review')!;
    const publicStop = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'stop-closeout')!;
    const repositoryStop = (await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.slug === 'stop-closeout')!;
    await deletePrompt(db, publicStop.id, { expectedRevision: publicStop.revision });
    const publicHelp = (await listSkills(db, { scope: 'public' }))[0]!;
    const repositoryHelp = (await listSkills(db, { scope: 'repository', repositoryId: managed.id }))[0]!;
    await deleteSkill(db, publicHelp.id, { expectedRevision: publicHelp.revision });
    const rerun = await bootstrapControlPlane({ root, env, repositories: [{ fullName: 'OWNER/REPO' }] });
    assert.equal(rerun.repositories[0].revision, beforeRevision + 1);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).some(asset => asset.slug === 'runtime-budget'), false);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.slug === 'review')?.content, beforeRerun.content);
    assert.equal((await listPrompts(db, { scope: 'public' })).some(asset => asset.slug === 'stop-closeout'), false);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.id === repositoryStop.id)?.content, repositoryStop.content);
    assert.equal((await listSkills(db, { scope: 'public' })).length, 0);
    assert.equal((await listSkills(db, { scope: 'repository', repositoryId: managed.id })).find(asset => asset.id === repositoryHelp.id)?.content, repositoryHelp.content);
    assert.equal((await getProviderModel(db, first.model.id))?.modelIdentifier, 'glm-test-bootstrap');
    const providers = await listProviders(db);
    assert.deepEqual(providers.map(value => value.type), ['zhipu']);
    assert.equal(JSON.stringify(rerun).includes('ZAI_API_KEY'), true);
    assert.equal(JSON.stringify(rerun).includes('not-a-real-secret'), false);
    assert.equal(operationHashes.length >= 15, true);
    for (const [file, hash] of operationHashes) assert.equal(createHash('sha256').update(await readFile(join(process.cwd(), 'operation', file))).digest('hex'), hash, file);
  } finally { closeControlPlaneDb(db); }
});

test('managed repository discovery uses current repo/state records and ignores empty or legacy directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-discovery-'));
  const paths = patchpawPaths(root);
  await mkdir(join(paths.repos, 'owner%2Frepo.git'), { recursive: true });
  await writeFile(join(paths.repos, 'owner%2Frepo.git', 'config'), '[remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n');
  await mkdir(join(paths.state, 'Owner__Repo'), { recursive: true });
  await writeFile(join(paths.state, 'Owner__Repo', 'pr-7.json'), JSON.stringify({ repo: 'Owner/Repo', pr_number: 7 }));
  await mkdir(join(paths.state, 'empty__directory'), { recursive: true });
  await mkdir(join(root, 'var', 'repos', 'legacy%2Fonly.git'), { recursive: true });
  assert.deepEqual(await discoverManagedRepositories(root), ['owner/repo']);
});
