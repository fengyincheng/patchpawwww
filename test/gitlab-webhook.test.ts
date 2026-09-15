import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeNoteHook, verifyLegacyToken, verifyStandardSignature } from '../src/scm/gitlab/webhook.ts';
import { buildServer } from '../src/server/app.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const payload = () => ({ object_kind: 'note', event_type: 'note', user: { id: 17, username: 'developer' }, project: { id: 88, path_with_namespace: 'group/subgroup/repo', web_url: 'https://git.example/group/subgroup/repo' },
  object_attributes: { id: 501, note: '@patchpaw /review', noteable_type: 'MergeRequest', action: 'create', system: false, created_at: '2026-09-15T00:00:00Z', url: 'https://git.example/group/subgroup/repo/-/merge_requests/3#note_501' },
  merge_request: { iid: 3, web_url: 'https://git.example/group/subgroup/repo/-/merge_requests/3' } });

test('GitLab note hook only normalizes newly created ordinary MR notes and isolates the project identity', () => {
  const note = normalizeNoteHook(payload(), 'self-hosted', 'hook-1', '99', 'patchpaw');
  assert.equal(note?.storageKey, 'gitlab:self-hosted:project:88');
  assert.equal(note?.repositoryPath, 'group/subgroup/repo');
  assert.equal(note?.changeRequestNumber, 3);
  const system = payload(); system.object_attributes.system = true;
  assert.equal(normalizeNoteHook(system, 'self-hosted', 'hook-2'), null);
  const inline = payload(); (inline.object_attributes as any).position = { old_path: 'x' };
  assert.equal(normalizeNoteHook(inline, 'self-hosted', 'hook-3'), null);
  const bot = payload(); bot.user.id = 17;
  assert.equal(normalizeNoteHook(bot, 'self-hosted', 'hook-4', '17'), null);
  assert.equal(normalizeNoteHook(payload(), 'self-hosted', 'hook-5', undefined, 'other-bot'), null);
  assert.equal(normalizeNoteHook(payload(), 'self-hosted', 'hook-6', '900', 'patchpaw')?.remoteId, 501);
});

test('GitLab legacy and Standard Webhooks authentication are explicit and replay bounded', () => {
  const body = Buffer.from(JSON.stringify(payload()));
  assert.equal(verifyLegacyToken('secret', 'secret'), true);
  assert.equal(verifyLegacyToken('secret', 'other'), false);
  const key = Buffer.alloc(32, 7), secret = `whsec_${key.toString('base64')}`;
  const id = 'msg-1', timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const signature = `v1,${digest}`;
  assert.equal(verifyStandardSignature({ body, webhookId: id, timestamp, signature, secret }), true);
  assert.equal(verifyStandardSignature({ body, webhookId: id, timestamp, signature: `v1,wrong ${signature}`, secret }), true);
  assert.equal(verifyStandardSignature({ body: Buffer.from(`${body}!`), webhookId: id, timestamp, signature, secret }), false);
  assert.equal(verifyStandardSignature({ body, webhookId: 'other', timestamp, signature, secret }), false);
  assert.equal(verifyStandardSignature({ body, webhookId: id, timestamp: String(Number(timestamp) - 301), signature, secret }), false);
  assert.throws(() => verifyStandardSignature({ body, webhookId: id, timestamp, signature, secret: 'signing-secret' }), /whsec_/);
  assert.throws(() => verifyStandardSignature({ body, webhookId: id, timestamp, signature, secret: 'whsec_not-base64!!!' }), /base64/);
  assert.throws(() => verifyStandardSignature({ body, webhookId: id, timestamp, signature, secret: `whsec_${Buffer.alloc(31).toString('base64')}` }), /32 bytes/);
});

test('GitLab webhook route persists a normalized note under its connection storage key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-gitlab-webhook-'));
  const app = buildServer({ root, snapshotRoot: join(root, 'snapshots'), webhookSecret: 'unused', testRepo: '', gitlabWebhooks: [{ connectionId: 'self-hosted', projectIds: ['88'], webhookMode: 'secret', webhookSecret: 'secret', botUserId: '900', botLogin: 'patchpaw' }] }, undefined, false, async () => {});
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const raw = JSON.stringify(payload());
  const response = await app.inject({ method: 'POST', url: '/gitlab/webhook/self-hosted', payload: raw, headers: { 'content-type': 'application/json', 'x-gitlab-token': 'secret', 'webhook-id': 'hook-1' } });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().comment_id, 501);
});
