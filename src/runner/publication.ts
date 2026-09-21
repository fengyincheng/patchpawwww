import { runNoticeBody, type RunNotice } from './run-notice.ts';
import type { ScmAdapter } from '../scm/types.ts';
import type { Trace } from '../harness/trace.ts';
import { safeError } from './outbound.ts';
import {
  deferDelivery,
  deliverImmediately,
  enqueueAndDeliverComment,
  enqueueCommentDelivery,
  type DeliveryAttempt,
} from './outbound.ts';
import { closeoutMarker } from './closeout-publication.ts';

export type TaskPublication = DeliveryAttempt['publication'];

function cleanString(trace: Trace, value: string) {
  const cleaned: unknown = JSON.parse(trace.clean(value));
  if (typeof cleaned !== 'string') throw new Error('Task answer did not remain a string after redaction');
  return cleaned;
}

export interface TaskPublicationInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  status: 'custom_completed' | 'conflict_completed' | 'ci_completed' | 'repair_completed';
  body: string;
  workspaceNotice?: string;
  headSha: string;
  projectId: string;
  mentions: string[];
  botLogin: string;
  adapter: ScmAdapter;
  trace: Trace;
  source?: Record<string, string | number | null | undefined>;
  approvalPlan?: {
    plan_id: string;
    plan_revision: number;
    body_sha256: string;
    source_comment_id: number;
  };
  guard?: () => Promise<void>;
}

/**
 * Publish an opaque task answer after its durable writeback has settled.
 *
 * This boundary owns only communication artifacts and the outbox. It does not decide task status,
 * mutate run state, or retry an Agent. The caller can therefore recover a queued publication by its
 * semantic key without replaying the task or pushing another candidate.
 */
export async function publishTaskAnswer(input: TaskPublicationInput) {
  await input.guard?.();
  const answer = cleanString(input.trace, `${input.workspaceNotice ?? ''}${input.body}`);
  input.trace.save('delivery.json', {
    status: input.status,
    head_sha: input.headSha,
    body: answer,
    ...(input.approvalPlan ? { approval_plan: input.approvalPlan } : {}),
  });
  const publication = (await enqueueAndDeliverComment({
    root: input.root,
    repo: input.repo,
    prNumber: input.prNumber,
    purpose: 'delivery_report',
    semanticKey: `run:${input.runId}:delivery:${input.status}`,
    body: answer,
    mentions: input.mentions,
    botLogin: input.botLogin,
    source: input.source ?? { project_id: input.projectId, run_id: input.runId, status: input.status },
  }, { adapter: input.adapter, botLogin: input.botLogin })).publication;
  input.trace.save('delivery-publication.json', publication);
  await input.guard?.();
  return { answer, publication };
}

export interface RunNoticePublicationInput {
  root: string;
  repo: string;
  prNumber: number;
  projectId: string;
  trace: Trace;
  notice: RunNotice;
  botLogin?: string;
  adapter: ScmAdapter;
}

function notificationArtifact(publication: TaskPublication) {
  if (publication.status === 'published') return publication;
  if (publication.status === 'blocked') {
    return {
      status: 'notification_failed',
      http_status: publication.last_error?.status ?? null,
      last_error: publication.last_error,
    };
  }
  return { ...publication, status: 'notification_pending' };
}

/**
 * Persist and deliver a previously prepared run notice. Installation lookup is deliberately a
 * delivery concern: if it fails, the already-enqueued body remains recoverable by the scheduler.
 */
export async function publishRunNotice(input: RunNoticePublicationInput) {
  try {
    const stored = await enqueueCommentDelivery({
      root: input.root,
      repo: input.repo,
      prNumber: input.prNumber,
      purpose: 'run_notice',
      semanticKey: `run-notice:${input.notice.run_id}`,
      body: runNoticeBody(input.notice),
      mentions: input.notice.mentions,
      botLogin: input.botLogin,
      legacyMarkers: ['budget_exhausted', 'stopped'].includes(input.notice.status)
        ? [closeoutMarker(input.notice.run_id)] : undefined,
      source: { project_id: input.projectId, run_id: input.notice.run_id, status: input.notice.status },
    });
    let publication: TaskPublication;
    try {
      publication = (await deliverImmediately(input.root, stored, { adapter: input.adapter, botLogin: input.botLogin })).publication;
    } catch (error) {
      publication = (await deferDelivery(input.root, stored, error)).publication;
    }
    input.trace.emit('run_notice_published', publication);
    input.trace.save('notification.json', notificationArtifact(publication));
    return publication;
  } catch (error) {
    const failure = {
      status: 'notification_failed',
      http_status: (error as { status?: number }).status ?? null,
      last_error: safeError(error),
    };
    input.trace.emit('run_notice_failed', failure);
    input.trace.save('notification.json', failure);
    return failure;
  }
}
