import type { GitHubReader } from '../github/client.ts';
import type { HumanReply } from '../github/comments.ts';
import { isTransient, providerError, retryAfterMs } from '../harness/retry.ts';
import { readState, statePath } from './state.ts';
import { openCommunicationStore, closeCommunicationStore, type CommunicationStore } from './communication-store.ts';
import { communicationWakePath, wakeCommunicationScheduler } from './communication-wake.ts';
import type { InboundRecord, InboundStatus, SafeCommunicationError } from './communication-types.ts';
import { patchpawPaths } from '../config/paths.ts';
import type { InboundScmComment, ScmInboundReader } from '../scm/types.ts';

export { communicationWakePath as inboundWakePath };
export type { InboundRecord, InboundStatus } from './communication-types.ts';

export interface InboundStored { record: InboundRecord; path: string }

function errorRecord(error: unknown): SafeCommunicationError {
  const facts = providerError(error);
  return { status: facts.status ?? null, code: facts.code ?? null, name: facts.name ?? null,
    category: facts.status !== undefined && (facts.status >= 500 || facts.status === 429) ? 'transient_http' : 'verification',
    classification: isTransient(error) ? 'retryable' : 'permanent',
    message: facts.message ?? null, documentation_url: facts.documentation_url ?? null,
    request_id: facts.request_id ?? null,
    retry_after_ms: retryAfterMs(error) ?? null };
}

function retryDelay(attempt: number) {
  const base = [15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000][Math.min(attempt - 1, 6)];
  return Math.min(60 * 60_000, base + Math.floor(Math.random() * 1_000));
}

async function withStore<T>(root: string, task: (store: CommunicationStore) => Promise<T>) {
  const store = await openCommunicationStore(root);
  try { return await task(store); } finally { await closeCommunicationStore(store); }
}

export async function persistInboundComment(root: string, deliveryId: string, reply: HumanReply): Promise<InboundStored> {
  const stored = await withStore(root, store => store.insertInbound(deliveryId, reply));
  if (!stored) throw new Error('Communication store failed to return an inbound record');
  wakeCommunicationScheduler(root);
  return stored;
}

export async function listInbound(root: string, filters?: { repo?: string; prNumber?: number }) {
  return withStore(root, store => store.listInbound(filters));
}

function identityMatches(record: InboundRecord, current: Awaited<ReturnType<GitHubReader['readPullRequest']>>) {
  return current.repository.full_name.toLowerCase() === record.repo.toLowerCase()
    && current.pullRequest.number === record.pr_number
    && current.pullRequest.base.repo.id === current.repository.id;
}

async function isRetired(root: string, record: InboundRecord) {
  const path = statePath(patchpawPaths(root).state, record.repo, record.pr_number);
  const state = await readState(path);
  return (state?.closed_through_comment_id ?? 0) >= record.comment_id;
}

const processing = new Set<string>();

async function processOne(root: string, stored: InboundStored, github: GitHubReader | undefined, onVerified: (reply: HumanReply) => Promise<void>, scmReader?: ScmInboundReader | ((connectionId: string) => ScmInboundReader | undefined)) {
  const key = `${root}\u0000${stored.record.repo}\u0000${stored.record.pr_number}\u0000${stored.record.comment_id}`;
  if (processing.has(key)) return 'deferred';
  processing.add(key);
  try {
    const current = await withStore(root, store => store.getInbound(stored.record.repo, stored.record.pr_number, stored.record.comment_id));
    if (!current) return 'deferred';
    const record = current.record;
    if (record.status === 'dispatched' || record.status === 'rejected' || record.status === 'retired') return 'settled';
    if (record.next_attempt_at > new Date().toISOString()) return 'deferred';
    if (record.status === 'pending_verification') {
      try {
        if (record.reply.platform === 'gitlab') {
          const reader = typeof scmReader === 'function' ? scmReader(record.reply.connection_id!) : scmReader;
          if (!reader) throw Object.assign(new Error('GitLab verification adapter is unavailable'), { status: 503 });
          const authorization = await reader.verifyInboundComment({ platform: 'gitlab', connectionId: record.reply.connection_id!, projectId: record.reply.project_id!,
            changeRequestNumber: record.pr_number, remoteId: record.comment_id, authorId: record.reply.author_id!, authorLogin: record.reply.author,
            body: record.reply.body, url: record.reply.url, createdAt: record.reply.created_at, sourceEventId: record.reply.source_event_id!, storageKey: record.repo, repositoryPath: record.reply.repository_path ?? record.repo });
          if (!authorization.canExecute) throw Object.assign(new Error('GitLab actor is not authorized'), { status: 403 });
        } else {
          if (!github) throw Object.assign(new Error('GitHub verification adapter is unavailable'), { status: 503 });
          const verified = await github.readPullRequest(record.reply.installation_id!, record.repo, record.pr_number);
          if (!identityMatches(record, verified)) {
            await withStore(root, store => store.markInboundRejected(record.repo, record.pr_number, record.comment_id, 'installation_repository_mismatch'));
            return 'rejected';
          }
        }
        await withStore(root, store => store.markInboundVerified(record.repo, record.pr_number, record.comment_id));
      } catch (error) {
        const attempt = record.attempt_count + 1;
        if (isTransient(error)) {
          const delay = retryAfterMs(error) ?? retryDelay(attempt);
          await withStore(root, store => store.markInboundRetry(record.repo, record.pr_number, record.comment_id,
            errorRecord(error), new Date(Date.now() + delay).toISOString()));
          return 'pending';
        }
        await withStore(root, store => store.markInboundRejected(record.repo, record.pr_number, record.comment_id, 'verification_failed', errorRecord(error)));
        return 'rejected';
      }
    }
    const latest = await withStore(root, store => store.getInbound(record.repo, record.pr_number, record.comment_id));
    if (!latest || latest.record.status !== 'verified') return 'deferred';
    if (await isRetired(root, latest.record)) {
      await withStore(root, store => store.markInboundRetired(record.repo, record.pr_number, record.comment_id));
      return 'retired';
    }
    try {
      await onVerified(latest.record.reply);
    } catch (error) {
      const delay = retryAfterMs(error) ?? retryDelay(latest.record.attempt_count + 1);
      await withStore(root, store => store.markInboundRetry(record.repo, record.pr_number, record.comment_id,
        errorRecord(error), new Date(Date.now() + delay).toISOString()));
      return 'pending';
    }
    await withStore(root, store => store.markInboundDispatched(record.repo, record.pr_number, record.comment_id));
    return 'dispatched';
  } finally { processing.delete(key); }
}

export async function verifyInboundNow(root: string, stored: InboundStored, github: GitHubReader | undefined,
  onVerified: (reply: HumanReply) => Promise<void>, scmReader?: ScmInboundReader | ((connectionId: string) => ScmInboundReader | undefined)) {
  return processOne(root, stored, github, onVerified, scmReader);
}

/** Compatibility entry point. Production now starts the unified communication scheduler. */
export function startInboundVerifier(config: { root: string }, github: GitHubReader,
  onVerified: (reply: HumanReply) => Promise<void>) {
  let service: { ready: Promise<void>; stop(): void } | undefined;
  const ready = import('./communication-scheduler.ts').then(({ startCommunicationScheduler }) => {
    service = startCommunicationScheduler({ root: config.root, appId: 1, privateKey: '', snapshotRoot: patchpawPaths(config.root).snapshots, wakeTransport: 'memory' }, github, onVerified);
    return service.ready;
  }).then(() => undefined);
  return { ready, stop() { service?.stop(); } };
}

export function wakeInboundVerifier(root: string) {
  wakeCommunicationScheduler(root);
}
