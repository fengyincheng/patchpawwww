import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapControlPlane,
  closeControlPlaneDb,
  getRepositoryByName,
  listCommands,
  listPrompts,
  newRunBuiltinPrompts,
  openControlPlaneDb,
  publicBuiltinPrompts,
} from '../src/control-plane/index.ts';
import { loadOperationSource, operationSourceName } from '../src/operation/load.ts';

test('fresh bootstrap enumerates builtin Prompts from the registry, not the operation directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-registry-'));
  const operationRoot = await mkdtemp(join(tmpdir(), 'patchpaw-registry-op-'));
  const sourceRoot = join(process.cwd(), 'operation');
  for (const entry of await readdir(sourceRoot)) await copyFile(join(sourceRoot, entry), join(operationRoot, entry));
  await writeFile(join(operationRoot, 'rogue-builtin.md'), '# Rogue\n\nAn unregistered file.\n');

  await bootstrapControlPlane({ root, env: { ZAI_MODEL: 'glm-registry-test' }, operationRoot, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(root);
  try {
    const publicPrompts = await listPrompts(db, { scope: 'public' });
    const slugs = publicPrompts.map(asset => asset.slug);
    assert.equal(slugs.includes('rogue-builtin'), false, 'an unregistered operation file must not become a builtin');
    assert.deepEqual([...slugs].sort(), publicBuiltinPrompts().map(definition => definition.slug).sort());

    for (const definition of publicBuiltinPrompts()) {
      const asset = publicPrompts.find(candidate => candidate.slug === definition.slug)!;
      assert.equal(asset.role, definition.role, `registered role for ${definition.slug}`);
      assert.equal(asset.enabled, true);
    }
  } finally { closeControlPlaneDb(db); }
});

test('builtin seed loading follows definition.source, not the slug', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-source-seam-'));
  await writeFile(join(root, 'renamed-seed.md'), '# Renamed\n\nSOURCE_SEAM_MARKER\n');
  await writeFile(join(root, 'plan-mode.md'), '# Slug file\n\nSLUG_DERIVED_MARKER\n');

  // A definition whose seed file name differs from its slug: the loader must
  // read the declared source, never `${slug}.md`.
  const definition = { slug: 'plan-mode', source: 'operation/renamed-seed.md' };
  assert.equal(operationSourceName(definition.source), 'renamed-seed');
  const content = loadOperationSource(definition.source, root);
  assert.match(content, /SOURCE_SEAM_MARKER/);
  assert.doesNotMatch(content, /SLUG_DERIVED_MARKER/);
});

test('bootstrap and the builtin migration load seed content through definition.source', async () => {
  const bootstrap = await readFile(join(process.cwd(), 'src/control-plane/bootstrap.ts'), 'utf8');
  const migrations = await readFile(join(process.cwd(), 'src/control-plane/builtin-migrations.ts'), 'utf8');
  assert.match(bootstrap, /loadOperationSource\(definition\.source/);
  assert.match(migrations, /loadOperationSource\(definition\.source/);
  assert.doesNotMatch(bootstrap, /definition\.slug\}\.md/);
  assert.doesNotMatch(migrations, /definition\.slug\}\.md/);
});

test('fresh bootstrap keeps legacy-only builtins out of repository scope and new-run bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-registry-legacy-'));
  await bootstrapControlPlane({ root, env: { ZAI_MODEL: 'glm-registry-legacy' }, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(root);
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const publicSlugs = (await listPrompts(db, { scope: 'public' })).map(asset => asset.slug);
    const repositoryPrompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const repoSlugs = repositoryPrompts.map(asset => asset.slug);
    assert.equal(publicSlugs.includes('review-json-retry'), true, 'a legacy asset stays publicly readable for compatibility');
    assert.equal(repoSlugs.includes('review-json-retry'), false, 'a legacy asset is not installed for new runs');
    assert.deepEqual([...repoSlugs].sort(), newRunBuiltinPrompts().map(definition => definition.slug).sort());

    const newRunSlugs = new Set(newRunBuiltinPrompts().map(definition => definition.slug));
    const promptsById = new Map(repositoryPrompts.map(asset => [asset.id, asset]));
    for (const command of await listCommands(db, repository.id)) {
      for (const binding of command.promptBindings) {
        const asset = promptsById.get(binding.assetId);
        assert.ok(asset, `command /${command.slashName} binds a missing asset`);
        assert.equal(newRunSlugs.has(asset.slug), true, `command /${command.slashName} must not bind legacy asset ${asset.slug}`);
      }
    }
  } finally { closeControlPlaneDb(db); }
});

