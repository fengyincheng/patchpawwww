import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapControlPlane } from '../src/control-plane/bootstrap.ts';
import { buildServer } from '../src/server/app.ts';
import type { GitHubReader } from '../src/github/client.ts';

const ORIGIN = 'http://admin.patchpaw.test';
const ENV = { ZAI_BASE_URL: 'https://provider.test/v1', ZAI_MODEL: 'glm-admin-fixture' };
const github = {} as GitHubReader;

function url(path: string) { return `/api/admin${path}`; }

async function send(app: ReturnType<typeof buildServer>, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, cookie?: string, origin = ORIGIN): Promise<any> {
  return app.inject({ method: method as any, url: url(path), payload: body === undefined ? undefined : JSON.stringify(body), headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}),
  } });
}

function json(response: Awaited<ReturnType<typeof send>>) { return response.json() as any; }

test('authenticated admin API closes the configuration and resolver loop without exposing credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-admin-api-'));
  await bootstrapControlPlane({ root, env: ENV, repositories: [{ fullName: 'Owner/Repo' }] });
  const app = buildServer({ root, webhookSecret: 'fixture', snapshotRoot: join(root, 'snapshots'), testRepo: 'owner/repo',
    adminToken: 'admin-token', publicOrigin: ORIGIN, bootstrapEnv: ENV }, github, false);
  t.after(() => app.close());

  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  const setup = await app.inject({ method: 'GET', url: '/api/setup' });
  assert.equal(setup.statusCode, 200);
  assert.deepEqual(setup.json().data, {
    public_origin: ORIGIN,
    webhook_url: `${ORIGIN}/github/webhook`,
    https_enabled: false,
    admin_auth_configured: true,
  });
  assert.equal(setup.body.includes('admin-token'), false);
  assert.equal((await send(app, 'GET', '/repositories', undefined, undefined, '')).statusCode, 401);
  assert.equal((await send(app, 'POST', '/auth/login', { token: 'admin-token' }, undefined, '')).statusCode, 403);
  const badLogin = await send(app, 'POST', '/auth/login', { token: 'wrong-token' });
  assert.equal(badLogin.statusCode, 401);
  assert.equal(JSON.stringify(json(badLogin)).includes('wrong-token'), false);
  const login = await send(app, 'POST', '/auth/login', { token: 'admin-token' });
  assert.equal(login.statusCode, 200);
  assert.equal(JSON.stringify(json(login)).includes('admin-token'), false);
  const setCookie = login.headers['set-cookie'];
  assert.ok(setCookie);
  const cookie = String(setCookie).split(';', 1)[0];
  assert.match(String(setCookie), /HttpOnly/);
  assert.match(String(setCookie), /SameSite=Strict/);
  assert.equal(json(await send(app, 'GET', '/auth/session', undefined, cookie)).data.authenticated, true);

  const repositories = json(await send(app, 'GET', '/repositories', undefined, cookie));
  assert.equal(repositories.data.length, 1);
  assert.equal(repositories.data[0].full_name, 'owner/repo');
  const repo = encodeURIComponent('owner/repo');
  assert.equal(json(await send(app, 'GET', `/repositories/${repo}`, undefined, cookie)).data.id, repositories.data[0].id);

  const publicPromptResponse = await send(app, 'POST', '/prompts/public', {
    slug: 'admin-custom', title: 'Admin custom', role: null, content: 'Custom {{repository}} prompt', enabled: true,
  }, cookie);
  assert.equal(publicPromptResponse.statusCode, 200);
  const publicPrompt = json(publicPromptResponse).data;
  assert.equal(publicPrompt.scope, 'public');
  const copiedPromptResponse = await send(app, 'POST', `/repositories/${repo}/prompts/copy-public/${publicPrompt.id}`, {}, cookie);
  assert.equal(copiedPromptResponse.statusCode, 200);
  const copiedPrompt = json(copiedPromptResponse).data;
  assert.equal(copiedPrompt.repository_id, repositories.data[0].id);
  assert.equal(copiedPrompt.source_public_id, publicPrompt.id);
  const promptPatch = await send(app, 'PATCH', `/repositories/${repo}/prompts/${copiedPrompt.id}`, { expected_revision: 1, content: 'changed {{repository}}' }, cookie);
  assert.equal(promptPatch.statusCode, 200);
  assert.equal(json(promptPatch).data.revision, 2);
  const stalePrompt = await send(app, 'PATCH', `/repositories/${repo}/prompts/${copiedPrompt.id}`, { expected_revision: 1, content: 'lost update' }, cookie);
  assert.equal(stalePrompt.statusCode, 409);
  assert.equal(json(stalePrompt).error.code, 'revision_conflict');
  assert.equal(json(stalePrompt).error.details.current_revision, 2);
  const promptReplaceBase = json(await send(app, 'GET', `/repositories/${repo}`, undefined, cookie)).data;
  const replacedPrompt = await send(app, 'POST', `/repositories/${repo}/prompts/copy-public/${publicPrompt.id}`, {
    replace: true, expected_repository_revision: promptReplaceBase.revision,
  }, cookie);
  assert.equal(replacedPrompt.statusCode, 200);
  assert.equal(json(replacedPrompt).data.id, copiedPrompt.id);
  const deletedPublicPrompt = await send(app, 'DELETE', `/prompts/public/${publicPrompt.id}`, undefined, cookie);
  assert.equal(deletedPublicPrompt.statusCode, 200);
  const copiedPromptAfterSourceDelete = json(await send(app, 'GET', `/repositories/${repo}/prompts/${copiedPrompt.id}`, undefined, cookie)).data;
  assert.equal(copiedPromptAfterSourceDelete.source_status, 'deleted');

  const publicSkill = json(await send(app, 'POST', '/skills/public', { slug: 'admin-skill', title: 'Admin skill', description: 'Fixture', content: '# Skill' }, cookie)).data;
  const copiedSkill = json(await send(app, 'POST', `/repositories/${repo}/skills/copy-public/${publicSkill.id}`, {}, cookie)).data;
  assert.equal(copiedSkill.scope, 'repository');
  const skillReplaceBase = json(await send(app, 'GET', `/repositories/${repo}`, undefined, cookie)).data;
  const replacedSkill = await send(app, 'POST', `/repositories/${repo}/skills/copy-public/${publicSkill.id}`, {
    replace: true, expected_repository_revision: skillReplaceBase.revision,
  }, cookie);
  assert.equal(replacedSkill.statusCode, 200);
  assert.equal(json(replacedSkill).data.id, copiedSkill.id);
  const deletedPublicSkill = await send(app, 'DELETE', `/skills/public/${publicSkill.id}`, undefined, cookie);
  assert.equal(deletedPublicSkill.statusCode, 200);
  const copiedSkillAfterSourceDelete = json(await send(app, 'GET', `/repositories/${repo}/skills/${copiedSkill.id}`, undefined, cookie)).data;
  assert.equal(copiedSkillAfterSourceDelete.source_status, 'deleted');

  const providers = json(await send(app, 'GET', '/providers', undefined, cookie)).data;
  const provider = providers[0];
  assert.ok(provider.models.length >= 1);
  const model = provider.models[0];
  const secondModel = json(await send(app, 'POST', `/providers/${provider.id}/models`, { model_identifier: 'glm-admin-second', display_name: 'Second model' }, cookie)).data;
  assert.equal(secondModel.provider_id, provider.id);
  const credential = await send(app, 'PUT', `/providers/${provider.id}/credential`, { credential: 'fixture-secret-value', expected_revision: provider.revision }, cookie);
  assert.equal(credential.statusCode, 200);
  assert.deepEqual(json(credential).data, { configured: true, credential_ref: `slot:provider/${provider.id}` });
  assert.equal(JSON.stringify(json(credential)).includes('fixture-secret-value'), false);
  const providerAfterCredential = json(await send(app, 'GET', `/providers/${provider.id}`, undefined, cookie)).data;
  assert.equal(providerAfterCredential.credential_configured, true);
  assert.equal(JSON.stringify(providerAfterCredential).includes('fixture-secret-value'), false);
  const staleCredential = await send(app, 'PUT', `/providers/${provider.id}/credential`, { credential: 'stale-secret', expected_revision: provider.revision }, cookie);
  assert.equal(staleCredential.statusCode, 409);
  assert.equal(json(staleCredential).error.code, 'revision_conflict');
  const unsafeProvider = await send(app, 'POST', '/providers', { type: 'deepseek', display_name: 'Unsafe', base_url: 'https://user:pass@example.test/v1?token=leak' }, cookie);
  assert.equal(unsafeProvider.statusCode, 422);
  assert.equal(JSON.stringify(json(unsafeProvider)).includes('pass'), false);

  const command = json(await send(app, 'POST', `/repositories/${repo}/commands`, {
    slash_name: 'admin-command', display_name: 'Admin command', description: 'Fixture', execution_type: 'review', permission: 'read_only',
    provider_model_id: model.id, prompt_bindings: [{ asset_id: copiedPrompt.id, position: 1, enabled: true, binding_kind: 'main' }],
    skill_bindings: [{ asset_id: copiedSkill.id, position: 1, enabled: true }],
  }, cookie)).data;
  assert.equal(command.slash_name, 'admin-command');
  const boundDelete = await send(app, 'DELETE', `/repositories/${repo}/prompts/${copiedPrompt.id}`, undefined, cookie);
  assert.equal(boundDelete.statusCode, 409);
  assert.equal(json(boundDelete).error.code, 'referenced_resource');

  const commands = json(await send(app, 'GET', `/repositories/${repo}/commands`, undefined, cookie)).data;
  const review = commands.find((value: any) => value.slash_name === 'review');
  assert.ok(review);
  const reviewUpdate = await send(app, 'PATCH', `/repositories/${repo}/commands/${review.id}`, {
    expected_revision: review.revision, provider_model_id: secondModel.id, description: 'Updated through API',
  }, cookie);
  assert.equal(reviewUpdate.statusCode, 200);
  assert.equal(json(reviewUpdate).data.provider_model_id, secondModel.id);
  const effective = await send(app, 'GET', `/repositories/${repo}/commands/${review.id}/effective`, undefined, cookie);
  assert.equal(effective.statusCode, 200);
  const effectiveData = json(effective).data;
  assert.equal(effectiveData.model.id, secondModel.id);
  assert.equal(effectiveData.permission, 'read_only');
  assert.ok(effectiveData.parts.some((part: any) => part.role === 'review'));
  assert.equal(JSON.stringify(effectiveData).includes('fixture-secret-value'), false);

  const profile = json(await send(app, 'GET', `/repositories/${repo}/conversation-profile`, undefined, cookie)).data;
  assert.equal(profile.permission, 'read_only');
  const profilePatch = await send(app, 'PATCH', `/repositories/${repo}/conversation-profile`, {
    expected_revision: profile.revision, display_name: 'Conversation from API',
  }, cookie);
  assert.equal(profilePatch.statusCode, 200);
  assert.equal(json(profilePatch).data.display_name, 'Conversation from API');
  const profileEffective = await send(app, 'GET', `/repositories/${repo}/conversation-profile/effective`, undefined, cookie);
  assert.equal(profileEffective.statusCode, 200);
  assert.equal(json(profileEffective).data.permission, 'read_only');

  const csrf = await send(app, 'POST', `/providers/${provider.id}/models`, { model_identifier: 'csrf-model' }, cookie, '');
  assert.equal(csrf.statusCode, 403);
  const logout = await send(app, 'POST', '/auth/logout', {}, cookie);
  assert.equal(logout.statusCode, 200);
  assert.equal((await send(app, 'GET', '/repositories', undefined, cookie)).statusCode, 401);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await send(app, 'POST', '/auth/login', { token: `wrong-${attempt}` })).statusCode, 401);
  const limited = await send(app, 'POST', '/auth/login', { token: 'wrong-final' });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
});
