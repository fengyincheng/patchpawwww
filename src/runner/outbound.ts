import { randomUUID } from 'node:crypto';
import { runtimeHomeFromCommunicationDb } from '../config/paths.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Octokit } from '@octokit/rest';
import type { ReviewPayload as ReviewOutput } from '../tasks/review/result.ts';
import { mentionUsers } from '../github/comments.ts';
import { publishReview } from '../github/review-publisher.ts';
import { ReviewStale } from '../scm/errors.ts';
import { isTransient, providerError, retryAfterMs } from '../harness/retry.ts';
import { closeCommunicationStore, openCommunicationStore, type CommunicationStore } from './communication-store.ts';
import { wakeCommunicationScheduler, registerCommunicationWake } from './communication-wake.ts';
import type {
  CommentPayload, DeliveryReceipt, OutboundItem, OutboundKind, OutboundLifecycleStatus, OutboundStatus,
  ReviewPayload, SafeCommunicationError,
} from './communication-types.ts';
import { LIFECYCLE_PURPOSES } from './communication-types.ts';
import type { ScmAdapter } from '../scm/types.ts';

export { wakeCommunicationScheduler as wakeOutboundScheduler } from './communication-wake.ts';
export { registerCommunicationWake as registerOutboundWake } from './communication-wake.ts';
export { communicationWakePath as outboundWakePath } from './communication-wake.ts';
export type {
  CommentPayload, DeliveryReceipt, OutboundItem, OutboundKind, OutboundLifecycleStatus, OutboundStatus,
  ReviewPayload,
} from './communication-types.ts';

export class OutboundPending extends Error {
  constructor(readonly delivery: OutboundItem) { super('Outbound communication remains pending'); this.name = 'OutboundPending'; }
}

export const OUTBOUND_SENDING_LEASE_MS = 30_000;
export const OUTBOUND_LOCK_BUSY_RETRY_MS = 1_000;

export interface OutboundConnection {
  client?: Octokit;
  adapter?: ScmAdapter;
  botLogin?: string;
}

export interface StoredItem { item: OutboundItem; path: string }

function now() { return new Date().toISOString(); }

export function safeError(error: unknown): SafeCommunicationError {
  const facts = providerError(error);
  const status = facts.status ?? null;
  const category = status === null || status === undefined ? 'transport' : status === 429 || status >= 500 ? 'transient_http' : 'http';
  return { status, code: facts.code ?? null, name: facts.name ?? null, category, retry_after_ms: retryAfterMs(error) ?? null };
}

function terminal(status: OutboundStatus) {
  return status === 'delivered' || status === 'cancelled_stale';
}

function requiresLifecycleFinalization(purpose: string) {
  return LIFECYCLE_PURPOSES.includes(purpose as typeof LIFECYCLE_PURPOSES[number]);
}

function backoffMs(attempt: number) {
  const base = [15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000][Math.min(attempt - 1, 6)];
  return Math.min(60 * 60 * 1000, base + Math.floor(Math.random() * 1_000));
}

function publication(item: OutboundItem) {
  return { status: item.status === 'delivered' ? 'published' : item.status,
    delivery_id: item.delivery_id, sequence: item.sequence, ...(item.receipt ?? {}), last_error: item.last_error };
}

async function withStore<T>(root: string, task: (store: CommunicationStore) => Promise<T>) {
  const store = await openCommunicationStore(root);
  try { return await task(store); } finally { await closeCommunicationStore(store); }
}

function newCommentItem(input: EnqueueCommentInput): Omit<OutboundItem, 'sequence' | 'updated_at'> {
  const created = now();
  const deliveryId = randomUUID();
  const marker = `<!-- patchpaw:delivery=${deliveryId} -->`;
  const visible = `${mentionUsers(input.mentions)}\n\n${input.body}`.trim();
  const lifecycle = requiresLifecycleFinalization(input.purpose);
  return {
    version: 1, delivery_id: deliveryId, semantic_key: input.semanticKey, repo: input.repo, pr_number: input.prNumber,
    kind: 'comment', purpose: input.purpose, created_at: created, status: 'pending',
    payload: { body: `${visible}\n\n${marker}`, mentions: input.mentions, bot_login: input.botLogin, legacy_markers: input.legacyMarkers },
    marker, source: input.source ?? {}, attempt_count: 0, last_attempt_at: null, next_attempt_at: created,
    sending_until_at: null, last_error: null, receipt: null, lifecycle_status: lifecycle ? 'pending' : 'finalized',
    finalized_at: lifecycle ? null : created, finalization_attempt_count: 0, finalization_last_error: null,
    next_finalization_at: lifecycle ? created : null,
  };
}

export interface EnqueueCommentInput {
  root: string; repo: string; prNumber: number; purpose: string; semanticKey: string; body: string; mentions: string[];
  botLogin?: string; legacyMarkers?: string[]; source?: Record<string, string | number | null | undefined>;
}

export async function enqueueCommentDelivery(input: EnqueueCommentInput): Promise<StoredItem> {
  return withStore(input.root, async store => {
    const item = await store.enqueueOutbound(newCommentItem(input));
    if (!item) throw new Error('Communication store failed to return an enqueued outbound item');
    wakeCommunicationScheduler(input.root);
    return item;
  });
}

export interface EnqueueReviewInput {
  root: string; repo: string; prNumber: number; purpose?: string; semanticKey: string; headSha: string; review: ReviewOutput;
  mentions: string[]; botLogin?: string; runId: string; allowLegacy?: boolean;
  source?: Record<string, string | number | null | undefined>;
}

export async function enqueueReviewDelivery(input: EnqueueReviewInput): Promise<StoredItem> {
  return withStore(input.root, async store => {
    const created = now();
    const deliveryId = randomUUID();
    const marker = `<!-- patchpaw:delivery=${deliveryId} -->`;
    const item: Omit<OutboundItem, 'sequence' | 'updated_at'> = {
      version: 1, delivery_id: deliveryId, semantic_key: input.semanticKey, repo: input.repo, pr_number: input.prNumber,
      kind: 'review', purpose: input.purpose ?? 'pr_review', created_at: created, status: 'pending',
      payload: { head_sha: input.headSha, review: input.review, mentions: input.mentions, bot_login: input.botLogin,
        run_id: input.runId, allow_legacy: input.allowLegacy }, marker,
      source: input.source ?? { run_id: input.runId, head_sha: input.headSha }, attempt_count: 0, last_attempt_at: null,
      next_attempt_at: created, sending_until_at: null, last_error: null, receipt: null, lifecycle_status: 'pending',
      finalized_at: null, finalization_attempt_count: 0, finalization_last_error: null, next_finalization_at: created,
    };
    const stored = await store.enqueueOutbound(item);
    if (!stored) throw new Error('Communication store failed to return an enqueued outbound item');
    wakeCommunicationScheduler(input.root);
    return stored;
  });
}

export async function listOutbound(root: string, filters?: { repo?: string; prNumber?: number }) {
  return withStore(root, store => store.listOutbound(filters));
}

async function listExistingComment(client: Octokit, repo: string, number: number, botLogin: string, markers: string[]) {
  const [owner, name] = repo.split('/');
  for (let page = 1; ; page++) {
    const { data } = await client.rest.issues.listComments({ owner, repo: name, issue_number: number, per_page: 100, page });
    const existing = data.find(comment => comment.user?.type === 'Bot'
      && comment.user.login.toLowerCase() === botLogin.toLowerCase() && markers.some(marker => comment.body?.includes(marker)));
    if (existing) return existing;
    if (data.length < 100) return undefined;
  }
}

async function send(stored: StoredItem, connection: OutboundConnection) {
  const { item } = stored;
  if (connection.adapter) {
    const adapter = connection.adapter;
    const projectId = typeof item.source.project_id === 'string' || typeof item.source.project_id === 'number'
      ? String(item.source.project_id) : item.repo.match(/^gitlab:.+:project:(.+)$/)?.[1];
    if (!projectId) throw new Error('SCM delivery is missing its remote project id');
    if (item.kind === 'comment') {
      const payload = item.payload as CommentPayload;
      const receipt = await adapter.publishComment(projectId, item.pr_number, payload.body, [item.marker, ...(payload.legacy_markers ?? [])]);
      return { id: receipt.id, html_url: receipt.htmlUrl, published_at: receipt.publishedAt, reused: receipt.reused, remote_adopted: receipt.remoteAdopted };
    }
    const payload = item.payload as ReviewPayload;
    const receipt = await adapter.publishReview(projectId, item.pr_number, payload.head_sha, payload.review, payload.mentions, item.marker);
    return { id: receipt.id, html_url: receipt.htmlUrl, commit_id: receipt.commitId ?? payload.head_sha, published_at: receipt.publishedAt, reused: receipt.reused, remote_adopted: receipt.remoteAdopted };
  }
  if (!connection.client) throw new Error('GitHub delivery is missing its client');
  if (item.kind === 'comment') {
    const payload = item.payload as CommentPayload;
    if (item.attempt_count > 1 || payload.legacy_markers?.length) {
      const botLogin = payload.bot_login ?? connection.botLogin;
      const existing = botLogin ? await listExistingComment(connection.client, item.repo, item.pr_number, botLogin,
        [item.marker, ...(payload.legacy_markers ?? [])]) : undefined;
      if (existing) return { id: existing.id, html_url: existing.html_url, reused: true, remote_adopted: true };
    }
    const [owner, repo] = item.repo.split('/');
    const { data } = await connection.client.rest.issues.createComment({ owner, repo, issue_number: item.pr_number, body: payload.body });
    return { id: data.id, html_url: data.html_url, reused: false, remote_adopted: false };
  }
  const payload = item.payload as ReviewPayload;
  const botLogin = payload.bot_login ?? connection.botLogin;
  if (!botLogin) throw new Error('GitHub App bot identity is unavailable for Review delivery');
  const published = await publishReview(connection.client, item.repo, item.pr_number, payload.head_sha, payload.review,
    payload.mentions, { runId: payload.run_id, botLogin, allowLegacy: payload.allow_legacy }, item.marker);
  return { ...published, commit_id: published.commit_id ?? undefined, remote_adopted: published.reused };
}

export interface DeliveryAttempt { item: OutboundItem; publication: ReturnType<typeof publication> }
type ConnectionSource = OutboundConnection | (() => Promise<OutboundConnection>);

export async function attemptDelivery(root: string, stored: StoredItem, source: ConnectionSource, force = false): Promise<DeliveryAttempt | undefined> {
  return withStore(root, async store => {
    let current = await store.getOutboundByDeliveryId(stored.item.delivery_id);
    if (!current) return undefined;
    if (terminal(current.item.status) || current.item.status === 'blocked') return { item: current.item, publication: publication(current.item) };
    if (current.item.status === 'sending') {
      const lease = Date.parse(current.item.sending_until_at ?? current.item.next_attempt_at);
      if (!Number.isFinite(lease) || lease > Date.now()) return undefined;
      await store.recoverExpiredSending(now());
      current = await store.getOutboundByDeliveryId(stored.item.delivery_id);
      if (!current) return undefined;
    }
    if (!force && current.item.next_attempt_at > now()) return undefined;
    const claimed = await store.claimOutbound(current.item.delivery_id, now(), new Date(Date.now() + OUTBOUND_SENDING_LEASE_MS).toISOString(), force);
    if (!claimed) {
      const latest = await store.getOutboundByDeliveryId(current.item.delivery_id);
      return latest ? { item: latest.item, publication: { status: 'queued', delivery_id: latest.item.delivery_id,
        sequence: latest.item.sequence, last_error: latest.item.last_error } } : undefined;
    }
    current = claimed;
    let connection: OutboundConnection;
    try { connection = typeof source === 'function' ? await source() : source; }
    catch (error) {
      const updated = isTransient(error)
        ? await store.markOutboundRetry(current.item.delivery_id, safeError(error),
          new Date(Date.now() + (retryAfterMs(error) ?? backoffMs(current.item.attempt_count))).toISOString())
        : await store.markOutboundBlocked(current.item.delivery_id, safeError(error));
      if (!updated) return undefined;
      return { item: updated.item, publication: publication(updated.item) };
    }
    try {
      const receipt = await send(current, connection);
      const updated = await store.markOutboundDelivered(current.item.delivery_id, receipt);
      if (!updated) return undefined;
      return { item: updated.item, publication: publication(updated.item) };
    } catch (error) {
      if (error instanceof ReviewStale) {
        await store.markOutboundStale(current.item.delivery_id, safeError(error));
        throw error;
      }
      const updated = isTransient(error)
        ? await store.markOutboundRetry(current.item.delivery_id, safeError(error), new Date(Date.now() + (retryAfterMs(error) ?? backoffMs(current.item.attempt_count))).toISOString())
        : await store.markOutboundBlocked(current.item.delivery_id, safeError(error));
      if (!updated) return undefined;
      if (current.item.kind === 'review' && /Ambiguous legacy/.test((error as Error).message ?? '')) throw error;
      return { item: updated.item, publication: publication(updated.item) };
    }
  });
}

export async function deliverImmediately(root: string, stored: StoredItem, connection: OutboundConnection,
  delays = [0, 2_000, 5_000]): Promise<DeliveryAttempt> {
  let current = (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id) ?? stored;
  if (current.item.status === 'blocked') {
    await withStore(root, async store => { await store.requeueOldestBlocked(current.item.repo, current.item.pr_number); });
    current = (await listOutbound(root)).find(value => value.item.delivery_id === stored.item.delivery_id) ?? current;
  }
  let result: DeliveryAttempt | undefined;
  for (let index = 0; index < delays.length; index++) {
    if (index) await sleep(delays[index]);
    result = await attemptDelivery(root, current, connection, true);
    if (!result) continue;
    current = (await listOutbound(root)).find(value => value.item.delivery_id === current.item.delivery_id) ?? current;
    if (result.item.status === 'delivered' || result.item.status === 'blocked' || result.item.status === 'cancelled_stale') return result;
    if (result.publication.status === 'queued') return result;
  }
  return result ?? { item: current.item, publication: publication(current.item) };
}

export async function enqueueAndDeliverComment(input: EnqueueCommentInput, connection: OutboundConnection) {
  const stored = await enqueueCommentDelivery(input);
  return deliverImmediately(input.root, stored, connection);
}

export async function deferDelivery(root: string, stored: StoredItem, error: unknown): Promise<DeliveryAttempt> {
  const updated = await withStore(root, async store => {
    const current = await store.getOutboundByDeliveryId(stored.item.delivery_id);
    if (!current) return undefined;
    const retry = retryAfterMs(error) ?? backoffMs(Math.max(1, current.item.attempt_count + 1));
    return store.recordOutboundFailure(current.item.delivery_id, safeError(error),
      isTransient(error) ? new Date(Date.now() + retry).toISOString() : undefined);
  });
  const item = updated?.item ?? stored.item;
  return { item, publication: publication(item) };
}

export async function recoverInFlightDeliveries(root: string) {
  return withStore(root, store => store.recoverExpiredSending(now()));
}

export async function finalizeDelivery(root: string, stored: StoredItem): Promise<OutboundItem | undefined> {
  return withStore(root, async store => (await store.markFinalized(stored.item.delivery_id))?.item);
}

/** Cancel an unpublished semantic item without creating a replacement or contacting GitHub. */
export async function cancelOutboundDelivery(root: string, stored: StoredItem, reason: string) {
  return withStore(root, async store => {
    const current = await store.getOutboundByDeliveryId(stored.item.delivery_id);
    if (!current || terminal(current.item.status)) return current?.item;
    const cancelled = await store.cancelOutboundStale(current.item.delivery_id, {
      status: null, code: reason, name: 'OutboundSuperseded', category: 'stale', retry_after_ms: null,
    });
    if (cancelled?.item.status === 'cancelled_stale') return (await store.markFinalized(current.item.delivery_id))?.item;
    return cancelled?.item;
  });
}

export async function deferFinalization(stored: StoredItem, error: unknown, root = stored.path): Promise<OutboundItem | undefined> {
  const retry = retryAfterMs(error) ?? backoffMs((stored.item.finalization_attempt_count ?? 0) + 1);
  const actualRoot = root === stored.path ? runtimeHomeFromCommunicationDb(root) : root;
  return withStore(actualRoot, async store =>
    (await store.deferFinalization(stored.item.delivery_id, safeError(error), new Date(Date.now() + retry).toISOString()))?.item);
}

export async function requeueOldestBlockedDelivery(root: string, repo: string, number: number) {
  return withStore(root, async store => {
    const item = await store.requeueOldestBlocked(repo, number);
    if (item) wakeCommunicationScheduler(root);
    return item;
  });
}

export async function drainDueDeliveries(root: string, connectionFor: (item: OutboundItem) => Promise<OutboundConnection>, limit = 25) {
  const store = await openCommunicationStore(root);
  try {
    await store.recoverExpiredSending(now());
    const due = await store.listDueOutboundHeads(now(), limit);
    let attempted = 0;
    for (const stored of due) {
      try { await attemptDelivery(root, stored, () => connectionFor(stored.item)); }
      catch (error) { if (!(error instanceof ReviewStale)) throw error; }
      attempted++;
    }
    return attempted;
  } finally { await closeCommunicationStore(store); }
}
