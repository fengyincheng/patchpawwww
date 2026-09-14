import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapControlPlane } from '../src/control-plane/bootstrap.ts';
import { buildServer } from '../src/server/app.ts';
import { adminApi, ApiError } from '../web/src/api.ts';

const ORIGIN = 'http://patchpaw.test';
const ENV = { ZAI_BASE_URL: 'https://provider.test/v1', ZAI_MODEL: 'glm-frontend-primary' };

test('typed frontend client edits assets and credentials through the real admin API without readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-frontend-api-'));
  await bootstrapControlPlane({ root, env: ENV, repositories: [{ fullName: 'owner/repo' }] });
  const app = buildServer({ root, webhookSecret: 'fixture', snapshotRoot: join(root, 'snapshots'), testRepo: 'owner/repo',
    publicOrigin: ORIGIN, adminToken: 'frontend-admin-token', bootstrapEnv: ENV }, {} as import('../src/github/client.ts').GitHubReader);
  let cookie = '';
  const requests: Array<{ method: string; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    headers.set('origin', ORIGIN);
    if (cookie) headers.set('cookie', cookie);
    const method = (init?.method ?? 'GET') as 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT' | 'OPTIONS';
    requests.push({ method, url });
    const reply = await app.inject({ method, url, headers: Object.fromEntries(headers.entries()), payload: init?.body as string | undefined });
    const setCookie = (reply.headers as unknown as Record<string, string | undefined>)['set-cookie'];
    if (setCookie) cookie = setCookie.split(';', 1)[0] ?? cookie;
    return new Response(reply.body, { status: reply.statusCode, headers: Object.fromEntries(Object.entries(reply.headers).filter(([key]) => key !== 'set-cookie') as Array<[string, string]>) });
  }) as typeof fetch;
  try {
    await app.ready();
    const setup = await adminApi.setup();
    assert.deepEqual(setup, {
      public_origin: ORIGIN,
      webhook_url: `${ORIGIN}/github/webhook`,
      https_enabled: false,
      admin_auth_configured: true,
    });
    const session = await adminApi.login('frontend-admin-token');
    assert.equal(session.authenticated, true);
    const repository = (await adminApi.repositories())[0]!;
    const created = await adminApi.createPublicPrompt({ slug: 'frontend-review', title: 'Frontend review', role: 'frontend-api', content: '# Review', enabled: true });
    const copied = await adminApi.copyPublicPrompt(repository.full_name, created.id);
    assert.equal(copied.source_public_id, created.id);
    const copiedUpdate = await adminApi.updateRepositoryPrompt(repository.full_name, copied, { slug: copied.slug, title: 'Repository review', role: copied.role, content: '# Repository Review', enabled: true });
    assert.equal(copiedUpdate.content, '# Repository Review');
    const updated = await adminApi.updatePublicPrompt(created, { slug: created.slug, title: 'Frontend review v2', role: created.role, content: '# Review v2', enabled: true });
    assert.equal(updated.revision, created.revision + 1);
    await assert.rejects(
      adminApi.updatePublicPrompt(created, { slug: created.slug, title: 'Stale update', role: created.role, content: '# Stale', enabled: true }),
      error => error instanceof ApiError && error.code === 'revision_conflict',
    );
    await adminApi.deletePublicPrompt(updated);

    const provider = (await adminApi.providers()).find(candidate => candidate.type === 'zhipu')!;
    const credentialResult = await adminApi.setCredential(provider, 'fixture-secret-never-returned');
    assert.equal(credentialResult.configured, true);
    const configuredProvider = (await adminApi.providers()).find(candidate => candidate.id === provider.id)!;
    assert.equal(configuredProvider.credential_configured, true);
    assert.equal(JSON.stringify(configuredProvider).includes('fixture-secret-never-returned'), false);
    const primaryModel = configuredProvider.models?.[0]!;
    const secondaryModel = await adminApi.createModel(configuredProvider, { model_identifier: 'glm-frontend-secondary', display_name: 'Secondary model', enabled: true });
    const commands = await adminApi.commands(repository.full_name);
    const review = commands.find(command => command.slash_name === 'review')!;
    const ci = commands.find(command => command.slash_name === 'ci')!;
    assert.ok(review.prompt_bindings.some(binding => binding.binding_kind === 'auxiliary'));
    const reviewUpdate = await adminApi.updateCommand(repository.full_name, review, { slash_name: review.slash_name, display_name: review.display_name,
      description: review.description, execution_type: review.execution_type, permission: review.permission, provider_model_id: primaryModel.id, enabled: review.enabled,
      prompt_bindings: review.prompt_bindings, skill_bindings: review.skill_bindings });
    const ciUpdate = await adminApi.updateCommand(repository.full_name, ci, { slash_name: ci.slash_name, display_name: ci.display_name,
      description: ci.description, execution_type: ci.execution_type, permission: ci.permission, provider_model_id: secondaryModel.id, enabled: ci.enabled,
      prompt_bindings: ci.prompt_bindings, skill_bindings: ci.skill_bindings });
    assert.notEqual(reviewUpdate.provider_model_id, ciUpdate.provider_model_id);
    assert.equal((await adminApi.effectiveCommand(repository.full_name, ciUpdate)).model.id, secondaryModel.id);
    const profile = await adminApi.profile(repository.full_name);
    assert.equal(profile.permission, 'read_only');
    const savedProfile = await adminApi.saveProfile(repository.full_name, profile, { display_name: 'Frontend conversation', provider_model_id: secondaryModel.id,
      enabled: profile.enabled, prompt_bindings: profile.prompt_bindings, skill_bindings: profile.skill_bindings });
    assert.equal(savedProfile.permission, 'read_only');
    assert.equal((await adminApi.effectiveProfile(repository.full_name)).permission, 'read_only');
    const clearResult = await adminApi.clearCredential(configuredProvider);
    assert.equal(clearResult.configured, false);
    assert.ok(requests.some(request => request.method === 'PUT' && request.url.endsWith(`/api/admin/providers/${provider.id}/credential`)));
    assert.ok(requests.some(request => request.method === 'DELETE' && request.url.includes('expected_revision=')));
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
