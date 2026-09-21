import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlPlaneError,
  bootstrapControlPlane,
  closeControlPlaneDb,
  createPrompt,
  deletePrompt,
  getRepositoryByName,
  listPrompts,
  openControlPlaneDb,
  updatePrompt,
} from '../src/control-plane/index.ts';
import { findMarker } from '../src/control-plane/common.ts';
import { buildServer } from '../src/server/app.ts';
import type { GitHubReader } from '../src/github/client.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-identity-'));
  await bootstrapControlPlane({ root, env: { ZAI_MODEL: 'glm-identity-test' }, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(root);
  const repository = (await getRepositoryByName(db, 'owner/lab'))!;
  return { root, db, repository };
}

async function emptyControlPlane() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-identity-empty-'));
  const db = await openControlPlaneDb(root);
  return { root, db };
}

const expectCode = (promise: Promise<unknown>, code: ControlPlaneError['code']) =>
  assert.rejects(promise, error => error instanceof ControlPlaneError && error.code === code);

test('engine-reserved builtin identity is locked while content and title stay editable', async () => {
  const { db, repository } = await fixture();
  try {
    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    const repositoryPlan = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'plan-mode')!;
    for (const asset of [publicPlan, repositoryPlan]) {
      const edited = await updatePrompt(db, asset.id, { content: 'operator edited body' }, { expectedRevision: asset.revision });
      assert.equal(edited.content, 'operator edited body');
      const titled = await updatePrompt(db, edited.id, { title: 'Operator title' }, { expectedRevision: edited.revision });
      assert.equal(titled.title, 'Operator title');

      await expectCode(updatePrompt(db, titled.id, { slug: 'my-plan' }, { expectedRevision: titled.revision }), 'invalid_configuration');
      await expectCode(updatePrompt(db, titled.id, { role: 'other-role' }, { expectedRevision: titled.revision }), 'invalid_configuration');

      const after = (await listPrompts(db, asset.scope === 'public' ? { scope: 'public' } : { scope: 'repository', repositoryId: repository.id }))
        .find(candidate => candidate.id === asset.id)!;
      assert.equal(after.slug, 'plan-mode');
      assert.equal(after.role, 'plan-mode');
      assert.equal(after.content, 'operator edited body');
    }
  } finally { closeControlPlaneDb(db); }
});

test('ordinary non-builtin prompts keep existing slug/role edit behavior', async () => {
  const { db, repository } = await fixture();
  try {
    const custom = await createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'my-custom', title: 'Custom', role: 'custom-role', content: 'body' });
    const renamed = await updatePrompt(db, custom.id, { slug: 'my-renamed', role: 'renamed-role' }, { expectedRevision: custom.revision });
    assert.equal(renamed.slug, 'my-renamed');
    assert.equal(renamed.role, 'renamed-role');
  } finally { closeControlPlaneDb(db); }
});

test('an ordinary prompt cannot adopt a reserved builtin slug or role by half', async () => {
  const { db, repository } = await fixture();
  try {
    // create: ordinary slug + reserved role
    await expectCode(createPrompt(db, { scope: 'public', slug: 'foo', title: 'Foo', role: 'plan-mode', content: 'body' }), 'invalid_configuration');
    // create: reserved slug + wrong role (and null role)
    await expectCode(createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Fake', role: 'other-role', content: 'body' }), 'invalid_configuration');
    await expectCode(createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Fake', role: null, content: 'body' }), 'invalid_configuration');
    // create: repository scope is guarded the same way
    await expectCode(createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'plan-mode', title: 'Fake', role: 'other-role', content: 'body' }), 'invalid_configuration');

    const ordinary = await createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'ordinary', title: 'Ordinary', role: null, content: 'body' });
    // update: ordinary prompt → reserved role but wrong slug
    await expectCode(updatePrompt(db, ordinary.id, { role: 'plan-mode' }, { expectedRevision: ordinary.revision }), 'invalid_configuration');
    // update: ordinary prompt → reserved slug but wrong role
    await expectCode(updatePrompt(db, ordinary.id, { slug: 'plan-mode' }, { expectedRevision: ordinary.revision }), 'invalid_configuration');

    const unchanged = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.id === ordinary.id)!;
    assert.equal(unchanged.slug, 'ordinary');
    assert.equal(unchanged.role, null);
  } finally { closeControlPlaneDb(db); }
});

test('a full reserved slug+role match is an explicit operator override, not a seeded builtin', async () => {
  const { db } = await emptyControlPlane();
  try {
    const created = await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Operator Plan Mode', role: 'plan-mode', content: 'operator body' });
    assert.equal(created.slug, 'plan-mode');
    assert.equal(created.role, 'plan-mode');
    // createPrompt is the operator path, so a full match stays operator-owned; the
    // builtin migration remains the only path that installs a seeded builtin.
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'override');

    await deletePrompt(db, created.id, { expectedRevision: created.revision });
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'tombstone');
    // The guard does not resurrect anything by itself; an explicit operator create
    // after a tombstone is still allowed and re-marks the asset as operator-owned.
    const recreated = await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Operator Plan Mode', role: 'plan-mode', content: 'operator body 2' });
    assert.equal(recreated.role, 'plan-mode');
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'override');
  } finally { closeControlPlaneDb(db); }
});

test('admin prompt DTO exposes builtin identity metadata and rejects locked identity edits', async t => {
  const { root, db } = await fixture();
  closeControlPlaneDb(db);
  const origin = 'http://admin.patchpaw.test';
  const app = buildServer({ root, webhookSecret: 'fixture', snapshotRoot: join(root, 'snapshots'), testRepo: 'owner/lab',
    adminToken: 'admin-token', publicOrigin: origin }, {} as GitHubReader, false);
  t.after(() => app.close());

  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: JSON.stringify({ token: 'admin-token' }),
    headers: { 'content-type': 'application/json', origin } });
  const cookie = String(login.headers['set-cookie']).split(';', 1)[0];
  const headers = { cookie, origin };

  const list = await app.inject({ method: 'GET', url: '/api/admin/prompts/public', headers });
  const prompts = (list.json() as { data: Array<Record<string, unknown>> }).data;
  const plan = prompts.find(prompt => prompt.slug === 'plan-mode')!;
  assert.equal(plan.builtin_key, 'plan-mode');
  assert.equal(plan.builtin_category, 'lifecycle');
  assert.equal(plan.identity_locked, true);
  assert.equal(plan.content_editable, true);
  assert.equal(plan.new_runs, true);

  const rejected = await app.inject({ method: 'PATCH', url: `/api/admin/prompts/public/${String(plan.id)}`,
    payload: JSON.stringify({ slug: 'my-plan', expected_revision: plan.revision }),
    headers: { ...headers, 'content-type': 'application/json' } });
  assert.equal(rejected.statusCode, 422);
  assert.equal((rejected.json() as { error: { code: string; field?: string } }).error.code, 'invalid_configuration');
  assert.equal((rejected.json() as { error: { field?: string } }).error.field, 'slug');
});

test('frontend locks builtin slug/role and keeps the content editor enabled', async () => {
  const source = await readFile(join(process.cwd(), 'web/src/App.tsx'), 'utf8');
  assert.match(source, /const identityLocked = kind === 'prompt' && selected \? \(selected as PromptAsset\)\.identity_locked : false;/);
  assert.match(source, /pattern="\[a-z\]\[a-z0-9-\]\{0,63\}" disabled=\{identityLocked\} required/);
  assert.match(source, /change\('role', event\.target\.value \|\| null\)\} disabled=\{identityLocked\}/);
  assert.match(source, /className="markdown-editor" value=\{draft\.content\}/);
});

