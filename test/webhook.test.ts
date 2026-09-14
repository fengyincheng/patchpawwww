import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server/app.ts';

const secret = 'local-test-secret';
const signature = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('HTTP health works; webhook verifies raw bytes before parsing JSON', async t => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'patchpaw-http-'));
  const app = buildServer({ webhookSecret: secret, snapshotRoot, testRepo: 'owner/lab' }, {
    async readPullRequest() { throw new Error('Unsupported events must not call GitHub'); },
  });
  t.after(async () => { await app.close(); await rm(snapshotRoot, { recursive: true, force: true }); });
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().service, 'patchpaw');
  assert.ok(health.json().version);
  assert.ok(health.json().time);

  const send = (body: string, sig: string) => app.inject({
    method: 'POST', url: '/github/webhook', payload: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'ping', 'x-github-delivery': 'delivery-1' },
  });
  assert.equal((await send('{bad json', 'sha256=bad')).statusCode, 401);
  const raw = '{ "zen": "keep it simple" }';
  assert.equal((await send(raw, signature(raw))).json().status, 'ignored');
  assert.equal((await send(raw.trim() + '\n', signature(raw))).statusCode, 401);
  assert.equal((await send('{bad json', signature('{bad json'))).statusCode, 400);
});

test('opened PR saves exact webhook SHAs; subsequent deliveries never overwrite history', async t => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'patchpaw-snapshots-'));
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const payload = {
    action: 'opened', installation: { id: 42 },
    repository: { full_name: 'owner/lab', id: 10, private: true },
    pull_request: {
      number: 7, title: 'Real event fixture', html_url: 'https://github.com/owner/lab/pull/7',
      base: { ref: 'main', sha: base }, head: { ref: 'feature', sha: head, repo: { full_name: 'owner/lab' } },
    },
  };
  const app = buildServer({ webhookSecret: secret, snapshotRoot, testRepo: 'owner/lab' }, {
    async readPullRequest() {
      return {
        repository: payload.repository,
        pullRequest: { number: 7, base: { sha: base, repo: { id: 10 } }, head: { sha: head } },
      };
    },
  }, false, async () => { throw new Error('Passive PR events must never dispatch an agent'); });
  t.after(async () => { await app.close(); await rm(snapshotRoot, { recursive: true, force: true }); });
  const send = (delivery: string) => {
    const raw = JSON.stringify(payload);
    return app.inject({ method: 'POST', url: '/github/webhook', payload: raw, headers: {
      'content-type': 'application/json', 'x-hub-signature-256': signature(raw),
      'x-github-event': 'pull_request', 'x-github-delivery': delivery,
    } });
  };
  const first = await send('delivery-opened');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().verification, 'matched');
  const folder = join(snapshotRoot, 'owner__lab', 'pr-7');
  const original = await readFile(join(folder, 'delivery-opened.json'), 'utf8');
  const snapshot = JSON.parse(original);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.installation_id, 42);
  assert.equal(snapshot.repository.private, true);
  assert.equal(snapshot.base.sha, base);
  assert.equal(snapshot.head.sha, head);
  assert.equal(snapshot.head.repo.full_name, 'owner/lab');
  assert.ok(snapshot.received_at);

  payload.action = 'synchronize';
  payload.pull_request.head.sha = 'c'.repeat(40);
  const second = await send('delivery-synchronize');
  assert.equal(second.json().verification, 'stale');
  assert.equal(await readFile(join(folder, 'delivery-opened.json'), 'utf8'), original);
  const newer = JSON.parse(await readFile(join(folder, 'delivery-synchronize.json'), 'utf8'));
  assert.equal(newer.head.sha, 'c'.repeat(40)); // Never replace event SHA with current API SHA.
  assert.equal((await send('delivery-synchronize')).json().duplicate, true);
  const names = await readdir(folder);
  assert.equal(names.filter(n => !n.includes('.verification.')).length, 2);
  for (const name of names) {
    assert.ok(!(await readFile(join(folder, name), 'utf8')).includes(secret));
  }
});

test('API failure preserves reopened snapshot and excludes credential-bearing SDK errors', async t => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'patchpaw-failure-'));
  const app = buildServer({ webhookSecret: secret, snapshotRoot, testRepo: 'owner/lab' }, {
    async readPullRequest() { throw Object.assign(new Error('authorization: secret-token-do-not-log'), { status: 403 }); },
  });
  t.after(async () => { await app.close(); await rm(snapshotRoot, { recursive: true, force: true }); });
  const payload = { action: 'reopened', installation: { id: 42 },
    repository: { full_name: 'owner/lab', id: 10, private: true },
    pull_request: { number: 8, title: 'Reopened', html_url: 'https://github.com/owner/lab/pull/8',
      base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'topic', sha: 'b'.repeat(40), repo: null } },
  };
  const raw = JSON.stringify(payload);
  const response = await app.inject({ method: 'POST', url: '/github/webhook', payload: raw, headers: {
    'content-type': 'application/json', 'x-hub-signature-256': signature(raw),
    'x-github-event': 'pull_request', 'x-github-delivery': 'delivery-reopened',
  } });
  assert.equal(response.statusCode, 502);
  assert.ok(!response.body.includes('secret-token-do-not-log'));
  const folder = join(snapshotRoot, 'owner__lab', 'pr-8');
  const snapshot = JSON.parse(await readFile(join(folder, 'delivery-reopened.json'), 'utf8'));
  assert.equal(snapshot.action, 'reopened');
  assert.equal(snapshot.head.repo, null);
  for (const name of await readdir(folder)) {
    const contents = await readFile(join(folder, name), 'utf8');
    assert.ok(!contents.includes('secret-token-do-not-log'));
    if (name.includes('.verification.')) assert.equal(JSON.parse(contents).http_status, 403);
  }
});
