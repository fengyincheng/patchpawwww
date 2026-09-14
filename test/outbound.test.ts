import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueCommentDelivery, attemptDelivery, deliverImmediately, drainDueDeliveries, listOutbound, requeueOldestBlockedDelivery } from '../src/runner/outbound.ts';
import { closeCommunicationStore, openCommunicationStore } from '../src/runner/communication-store.ts';

function fakeClient(options: { status?: number; lostAck?: boolean } = {}) {
  const comments: any[] = [];
  let creates = 0;
  let failed = false;
  const client: any = { rest: { issues: {
    listComments: async () => ({ data: comments }),
    createComment: async ({ body }: { body: string }) => {
      creates++;
      if (options.status && !failed) { failed = true; const error: any = new Error('fixture'); error.status = options.status; throw error; }
      const comment = { id: 100 + creates, html_url: `https://github.test/comment/${creates}`, body, user: { login: 'patchpawwww[bot]', type: 'Bot' } };
      comments.push(comment);
      if (options.lostAck && !failed) { failed = true; const error: any = new Error('lost acknowledgement'); error.code = 'ECONNRESET'; throw error; }
      return { data: comment };
    },
  } } };
  return { client, comments, get creates() { return creates; } };
}

const input = (root: string, key: string, body: string) => ({ root, repo: 'owner/repo', prNumber: 7,
  purpose: 'test', semanticKey: key, body, mentions: ['owner'], botLogin: 'patchpawwww[bot]' });

test('outbound persists before POST and adopts a remote comment after a lost acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const remote = fakeClient({ lostAck: true });
  const stored = await enqueueCommentDelivery(input(root, 'one', 'first'));
  assert.equal((await listOutbound(root)).length, 1);
  const first = await attemptDelivery(root, stored, remote);
  assert.equal(first?.item.status, 'pending_retry');
  const second = await attemptDelivery(root, stored, remote, true);
  assert.equal(second?.item.status, 'delivered');
  assert.equal(second?.item.receipt?.remote_adopted, true);
  assert.equal(remote.creates, 1, 'the lost acknowledgement must not create a duplicate');
  assert.match(remote.comments[0].body, /patchpaw:delivery=/);
  const db = await openCommunicationStore(root);
  try { assert.equal((await db.getOutboundByDeliveryId(stored.item.delivery_id))?.item.status, 'delivered'); }
  finally { await closeCommunicationStore(db); }
});

test('transient failures retry and permanent permission failures become durable blocked items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const transient = fakeClient({ status: 503 });
  const pending = await enqueueCommentDelivery(input(root, 'transient', 'retry me'));
  const result = await deliverImmediately(root, pending, transient, [0, 0, 0]);
  assert.equal(result.item.status, 'delivered');
  assert.equal(transient.creates, 2);

  const blockedClient = fakeClient({ status: 403 });
  const blocked = await enqueueCommentDelivery(input(root, 'blocked', 'keep me'));
  const blockedResult = await attemptDelivery(root, blocked, blockedClient);
  assert.equal(blockedResult?.item.status, 'blocked');
  assert.equal(blockedClient.creates, 1);
  assert.equal((await listOutbound(root)).find(value => value.item.semantic_key === 'blocked')?.item.status, 'blocked');
});

test('drain preserves per PR ordering when the oldest item is delayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const first = await enqueueCommentDelivery(input(root, 'first', 'one'));
  const second = await enqueueCommentDelivery(input(root, 'second', 'two'));
  const failing = fakeClient({ status: 503 });
  const delayed = await attemptDelivery(root, first, failing);
  assert.equal(delayed?.item.status, 'pending_retry');
  const success = fakeClient();
  assert.equal(await drainDueDeliveries(root, async () => success), 0, 'a newer item cannot overtake a delayed first item');
  const firstAgain = await attemptDelivery(root, first, success, true);
  assert.equal(firstAgain?.item.status, 'delivered');
  assert.equal((await drainDueDeliveries(root, async () => success) > 0), true);
  assert.deepEqual(success.comments.map(comment => comment.body.includes('one') ? 'one' : 'two'), ['one', 'two']);
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === second.item.delivery_id)?.item.status, 'delivered');
});

test('a blocked oldest item stays in front of newer deliveries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const first = await enqueueCommentDelivery(input(root, 'blocked-first', 'blocked first'));
  const second = await enqueueCommentDelivery(input(root, 'blocked-second', 'blocked second'));
  const blocked = await attemptDelivery(root, first, fakeClient({ status: 403 }));
  assert.equal(blocked?.item.status, 'blocked');
  const success = fakeClient();
  assert.equal(await drainDueDeliveries(root, async () => success), 0);
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === second.item.delivery_id)?.item.status, 'pending');
  assert.equal(success.creates, 0);
});

test('connection acquisition failures use durable retry backoff and Retry-After', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const stored = await enqueueCommentDelivery(input(root, 'connection', 'retry connection'));
  let calls = 0;
  const retry = await drainDueDeliveries(root, async () => {
    calls++;
    const error: any = new Error('installation temporarily unavailable'); error.status = 429; error.retryAfter = 30; throw error;
  });
  assert.equal(retry, 1);
  assert.equal(calls, 1);
  const pending = (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)!.item;
  assert.equal(pending.status, 'pending_retry');
  assert.equal(pending.attempt_count, 1);
  assert.ok(Date.parse(pending.next_attempt_at) - Date.now() > 29_000);
  assert.equal(await drainDueDeliveries(root, async () => { calls++; throw new Error('must not retry early'); }), 0);
  assert.equal(calls, 1);
});

test('permanent connection acquisition failures block the same durable item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const stored = await enqueueCommentDelivery(input(root, 'connection-forbidden', 'do not retry permission failure'));
  let calls = 0;
  const result = await drainDueDeliveries(root, async () => {
    calls++;
    throw Object.assign(new Error('installation forbidden'), { status: 403 });
  });
  assert.equal(result, 1);
  assert.equal(calls, 1);
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id)?.item.status, 'blocked');
});

test('a new human entry requeues exactly the oldest blocked outbound item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-outbound-'));
  const first = await enqueueCommentDelivery(input(root, 'blocked-first', 'blocked first'));
  const second = await enqueueCommentDelivery(input(root, 'blocked-second', 'blocked second'));
  await attemptDelivery(root, first, fakeClient({ status: 403 }));
  const requeued = await requeueOldestBlockedDelivery(root, 'owner/repo', 7);
  assert.equal(requeued?.delivery_id, first.item.delivery_id);
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === first.item.delivery_id)?.item.status, 'pending');
  assert.equal((await listOutbound(root)).find(value => value.item.delivery_id === second.item.delivery_id)?.item.status, 'pending');
  const delivered = await drainDueDeliveries(root, async () => fakeClient(), 1);
  assert.equal(delivered, 1);
});
