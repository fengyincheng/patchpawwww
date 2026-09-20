import type { Octokit } from '@octokit/rest';
import { dirname } from 'node:path';
import { runNoticeBody, type RunNotice } from './run-notice.ts';
import { readArtifact } from './review-lifecycle.ts';
import type { Trace } from '../harness/trace.ts';
import { deliverImmediately, enqueueCommentDelivery, type OutboundConnection } from './outbound.ts';

export const closeoutMarker = (runId: string) => `<!-- patchpaw-budget-closeout:${runId} -->`;
const RECOVERABLE_NOTICE_STATUSES = new Set(['budget_exhausted', 'stopped', 'model_output_truncated']);

// The persisted notice is an outbox item. Recovery performs no model call and
// does not modify PR/workspace state, even if a later execution already ran.
export async function publishSavedCloseoutWithConnection(trace: Trace, connection: OutboundConnection, repo: string, number: number, root = dirname(dirname(dirname(trace.dir)))) {
  const saved = await readArtifact(trace.dir, 'notification.json');
  if (saved?.status === 'published') return saved;
  const notice: RunNotice | null = await readArtifact(trace.dir, 'run-notice.json');
  if (!notice || !RECOVERABLE_NOTICE_STATUSES.has(notice.status)) throw new Error('No pending closeout notice');
  const stored = await enqueueCommentDelivery({ root, repo, prNumber: number, purpose: 'run_notice',
    semanticKey: `run-notice:${notice.run_id}`, body: runNoticeBody(notice), mentions: notice.mentions,
    botLogin: notice.bot_login, legacyMarkers: ['budget_exhausted', 'stopped'].includes(notice.status) ? [closeoutMarker(notice.run_id)] : undefined,
    source: { run_id: notice.run_id, status: notice.status } });
  const result = await deliverImmediately(root, stored, { ...connection, botLogin: notice.bot_login ?? connection.botLogin });
  const publication = result.publication;
  trace.save('notification.json', publication.status === 'published' ? publication
    : publication.status === 'blocked' ? { status: 'notification_failed', http_status: publication.last_error?.status ?? null }
    : { ...publication, status: 'notification_pending' });
  trace.emit(publication.status === 'published' ? 'run_notice_published' : 'run_notice_pending', publication);
  return publication;
}

/** Compatibility wrapper for existing GitHub recovery callers. */
export async function publishSavedCloseout(trace: Trace, client: Octokit, repo: string, number: number, root = dirname(dirname(dirname(trace.dir)))) {
  return publishSavedCloseoutWithConnection(trace, { client }, repo, number, root);
}
