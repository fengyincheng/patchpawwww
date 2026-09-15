import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server/app.ts';

const origin = 'http://scm-admin.patchpaw.test';
async function request(app: ReturnType<typeof buildServer>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, cookie?: string): Promise<any> {
  return app.inject({ method: method as any, url: `/api/admin${path}`, payload: body === undefined ? undefined : JSON.stringify(body), headers: {
    origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}),
  } });
}

test('SCM admin stores separate protected slots and refuses to expose their contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-scm-admin-'));
  const app = buildServer({ root, snapshotRoot: join(root, 'snapshots'), webhookSecret: 'unused', testRepo: '', adminToken: 'admin', publicOrigin: origin }, undefined, false);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const login = await request(app, 'POST', '/auth/login', { token: 'admin' });
  const cookie = String(login.headers['set-cookie']).split(';', 1)[0];
  const created = await request(app, 'POST', '/scm-connections', { id: 'gitlab-one', kind: 'gitlab', instance_url: 'https://git.example/root', project_ids: ['42'] }, cookie);
  assert.equal(created.statusCode, 200);
  const connection = created.json().data;
  const credential = await request(app, 'PUT', `/scm-connections/${connection.id}/credential`, { secret: 'pat-secret' }, cookie);
  assert.equal(credential.statusCode, 200);
  const webhook = await request(app, 'PUT', `/scm-connections/${connection.id}/webhook-secret`, { secret: 'webhook-secret' }, cookie);
  assert.equal(webhook.statusCode, 200);
  const list = await request(app, 'GET', '/scm-connections', undefined, cookie);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data[0].credential_configured, true);
  assert.equal(list.json().data[0].webhook_secret_configured, true);
  assert.equal(JSON.stringify(list.json()).includes('pat-secret'), false);
  assert.equal(JSON.stringify(list.json()).includes('webhook-secret'), false);
  const slot = await readFile(join(root, 'secrets', 'scm', 'gitlab-one.key'), 'utf8');
  assert.equal(slot, 'pat-secret');
  const removed = await request(app, 'DELETE', `/scm-connections/${connection.id}`, undefined, cookie);
  assert.equal(removed.statusCode, 200);
});
