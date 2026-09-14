import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeCommunicationStore, communicationDbPath, COMMUNICATION_SCHEMA_VERSION, openCommunicationStore } from '../src/runner/communication-store.ts';
import { enqueueCommentDelivery } from '../src/runner/outbound.ts';

const input = (root: string, key: string) => ({ root, repo: 'owner/repo', prNumber: 7, purpose: 'conversation_reply',
  semanticKey: key, body: key, mentions: ['owner'], botLogin: 'patchpawwww[bot]' });

test('communication schema is idempotent, local WAL is active, and runtime enqueue creates no file queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-'));
  const first = await openCommunicationStore(root);
  assert.equal((await first.execute('PRAGMA journal_mode')).rows[0].journal_mode, 'wal');
  assert.equal(await first.getMeta('schema_version'), COMMUNICATION_SCHEMA_VERSION);
  await first.close();
  const second = await openCommunicationStore(root);
  await second.close();
  await enqueueCommentDelivery(input(root, 'one'));
  const reopened = await openCommunicationStore(root);
  try { assert.equal(reopened.path, communicationDbPath(root)); }
  finally { await reopened.close(); }
  await assert.rejects(readdir(join(root, 'var/outbox')), { code: 'ENOENT' });
});

test('semantic uniqueness and concurrent claims are enforced by SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-'));
  const enqueued = await Promise.all(Array.from({ length: 20 }, () => enqueueCommentDelivery(input(root, 'same'))));
  assert.equal(new Set(enqueued.map(value => value.item.delivery_id)).size, 1);
  assert.equal(enqueued[0].item.sequence, 1);
  const first = await enqueueCommentDelivery({ ...input(root, 'first'), prNumber: 8 });
  const second = await enqueueCommentDelivery({ ...input(root, 'second'), prNumber: 8 });
  const a = await openCommunicationStore(root);
  const b = await openCommunicationStore(root);
  try {
    const results = await Promise.all([
      a.claimOutbound(first.item.delivery_id, new Date().toISOString(), new Date(Date.now() + 30_000).toISOString()),
      b.claimOutbound(first.item.delivery_id, new Date().toISOString(), new Date(Date.now() + 30_000).toISOString()),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await a.claimOutbound(second.item.delivery_id, new Date().toISOString(), new Date(Date.now() + 30_000).toISOString()), undefined,
      'a newer row cannot overtake a sending head');
  } finally { await a.close(); await b.close(); }
});

test('sending lease recovery is deadline based and preserves lost-ACK-safe attempt count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-'));
  const item = await enqueueCommentDelivery(input(root, 'lease'));
  const store = await openCommunicationStore(root);
  try {
    await store.execute(`UPDATE outbound_delivery SET status = 'sending', attempt_count = 1,
      sending_until_at = :until, next_attempt_at = :until WHERE delivery_id = :id`,
      { until: new Date(Date.now() + 30_000).toISOString(), id: item.item.delivery_id });
    assert.equal(await store.recoverExpiredSending(new Date().toISOString()), 0);
    await store.execute(`UPDATE outbound_delivery SET sending_until_at = :until, next_attempt_at = :until WHERE delivery_id = :id`,
      { until: new Date(0).toISOString(), id: item.item.delivery_id });
    assert.equal(await store.recoverExpiredSending(new Date().toISOString()), 1);
    const recovered = await store.getOutboundByDeliveryId(item.item.delivery_id);
    assert.equal(recovered?.item.status, 'pending_retry');
    assert.equal(recovered?.item.attempt_count, 2);
    assert.equal(recovered?.item.last_error?.code, 'sending_lease_expired');
  } finally { await store.close(); }
});

test('head ordering and nearest deadline include only actionable head, finalization, and inbound work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-'));
  const first = await enqueueCommentDelivery(input(root, 'first'));
  const second = await enqueueCommentDelivery(input(root, 'second'));
  const store = await openCommunicationStore(root);
  try {
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.execute(`UPDATE outbound_delivery SET status = 'blocked', next_attempt_at = :future WHERE delivery_id = :id`, { future, id: first.item.delivery_id });
    await store.execute(`UPDATE outbound_delivery SET next_attempt_at = :now WHERE delivery_id = :id`, { now: new Date().toISOString(), id: second.item.delivery_id });
    assert.deepEqual(await store.listDueOutboundHeads(new Date().toISOString()), []);
    const finalization = await enqueueCommentDelivery({ ...input(root, 'final'), purpose: 'close_completion' });
    await store.execute(`UPDATE outbound_delivery SET status = 'delivered', lifecycle_status = 'pending', next_finalization_at = :now WHERE delivery_id = :id`,
      { now: new Date().toISOString(), id: finalization.item.delivery_id });
    const reply = { repo: 'owner/repo', pr_number: 7, installation_id: 1, comment_id: 999, author: 'owner', body: '@patchpawwww hi', url: 'https://github.test/comment/999' };
    await store.insertInbound('delivery-999', reply);
    const deadline = await store.nextCommunicationDeadline();
    assert.ok(deadline && Date.parse(deadline) <= Date.now() + 1_000);
  } finally { await store.close(); }
});

test('legacy JSON queue import preserves per-PR order and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-migrate-'));
  const dir = join(root, 'var/outbox', 'owner%2Frepo', 'pr-7');
  await mkdir(dir, { recursive: true });
  const base = (sequence: number, key: string) => ({ version: 1, delivery_id: `legacy-${sequence}`, semantic_key: key,
    repo: 'owner/repo', pr_number: 7, sequence, kind: 'comment', purpose: 'conversation_reply', created_at: `2026-09-09T00:00:0${sequence}.000Z`,
    status: 'pending', payload: { body: `${key}\n\n<!-- patchpaw:delivery=legacy-${sequence} -->`, mentions: ['owner'], bot_login: 'patchpawwww[bot]' },
    marker: `<!-- patchpaw:delivery=legacy-${sequence} -->`, source: {}, attempt_count: 0, last_attempt_at: null,
    next_attempt_at: new Date().toISOString(), last_error: null, receipt: null });
  await writeFile(join(dir, '000000000001-legacy-1.json'), JSON.stringify(base(1, 'one')) + '\n');
  await writeFile(join(dir, '000000000002-legacy-2.json'), JSON.stringify(base(2, 'two')) + '\n');
  const first = await openCommunicationStore(root);
  try { assert.deepEqual((await first.listOutbound()).map(value => value.item.semantic_key), ['one', 'two']); }
  finally { await first.close(); }
  const second = await openCommunicationStore(root);
  try { assert.equal((await second.listOutbound()).length, 2); assert.ok(await second.getMeta('file_queue_import_v1')); }
  finally { await second.close(); }
});

test('legacy inbound import preserves durable verification state and retry facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-inbound-migrate-'));
  const dir = join(root, 'var/inbound', 'owner%2Flab', 'pr-7');
  await mkdir(dir, { recursive: true });
  const created = '2026-09-09T00:00:00.000Z', updated = '2026-09-09T00:01:00.000Z';
  const record = { version: 1, delivery_id: 'legacy-inbound', reply: {
    repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 101, author: 'owner',
    body: '@patchpawwww hi', url: 'https://github.test/comment/101' }, status: 'rejected', attempt_count: 3,
    next_attempt_at: '2026-09-09T01:00:00.000Z', last_error: { status: 503, code: null, name: 'Error', category: 'transient_http' },
    rejected_reason: 'verification_failed', created_at: created, updated_at: updated };
  await writeFile(join(dir, 'comment-101.json'), JSON.stringify(record) + '\n');
  const store = await openCommunicationStore(root);
  try {
    const imported = await store.getInbound('owner/lab', 7, 101);
    assert.equal(imported?.record.status, 'rejected');
    assert.equal(imported?.record.attempt_count, 3);
    assert.equal(imported?.record.next_attempt_at, record.next_attempt_at);
    assert.deepEqual(imported?.record.last_error, record.last_error);
    assert.equal(imported?.record.rejected_reason, record.rejected_reason);
    assert.equal(imported?.record.created_at, created);
    assert.equal(imported?.record.updated_at, updated);
  } finally { await store.close(); }
});

test('interrupted legacy import restarts without its marker and converges under UNIQUE constraints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-store-migrate-restart-'));
  const dir = join(root, 'var/outbox', 'owner%2Frepo', 'pr-7');
  await mkdir(dir, { recursive: true });
  const item = (sequence: number, status = 'pending') => ({ version: 1, delivery_id: `restart-${sequence}`, semantic_key: `restart-${sequence}`,
    repo: 'owner/repo', pr_number: 7, sequence, kind: 'comment', purpose: 'conversation_reply', created_at: `2026-09-09T00:00:0${sequence}.000Z`,
    status, payload: { body: `restart ${sequence}`, mentions: ['owner'], bot_login: 'patchpawwww[bot]' }, marker: `<!-- restart-${sequence} -->`,
    source: {}, attempt_count: 0, last_attempt_at: null, next_attempt_at: new Date().toISOString(), last_error: null, receipt: null });
  await writeFile(join(dir, '000000000001-restart-1.json'), JSON.stringify(item(1)) + '\n');
  await writeFile(join(dir, '000000000002-restart-2.json'), JSON.stringify(item(2, 'invalid-interruption-state')) + '\n');

  await assert.rejects(openCommunicationStore(root));
  const failedDb = await openCommunicationStore(root).catch(() => undefined);
  await failedDb?.close();
  await writeFile(join(dir, '000000000002-restart-2.json'), JSON.stringify(item(2)) + '\n');

  const restarted = await openCommunicationStore(root);
  try {
    assert.equal(await restarted.getMeta('file_queue_import_v1') !== undefined, true);
    assert.deepEqual((await restarted.listOutbound()).map(value => value.item.delivery_id), ['restart-1', 'restart-2']);
  } finally { await restarted.close(); }
});
