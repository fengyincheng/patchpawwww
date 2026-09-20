import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Trace } from '../harness/trace.ts';
import { disposeWorkspacePath } from '../workspace/repo-store.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readApprovalPlan, updateApprovalPlan } from './approval-plans.ts';
import { applyRunPhase } from './phases.ts';
import { readPaused, savePaused } from './resume.ts';
import { readState, statePath, writeState } from './state.ts';
import type { CommunicationStore } from './communication-store.ts';
import type { OutboundConnection, OutboundItem, StoredItem } from './outbound.ts';

export type FinalizationKind =
  | 'stale_review'
  | 'review'
  | 'run_notice'
  | 'approval_plan'
  | 'legacy_conflict_proposal'
  | 'legacy_conflict_repair'
  | 'close_refusal'
  | 'close_completion'
  | 'close_start'
  | 'none';

function sourceRun(item: Pick<OutboundItem, 'source'>) {
  return typeof item.source.run_id === 'string' ? item.source.run_id : undefined;
}

/** Classify only from durable outbox identity; handlers own all I/O and state transitions. */
export function classifyFinalization(item: Pick<OutboundItem, 'kind' | 'status' | 'purpose' | 'source'>): FinalizationKind {
  const runId = sourceRun(item);
  if (item.kind === 'review' && item.status === 'cancelled_stale') return 'stale_review';
  if (item.status !== 'delivered') return 'none';
  if (item.kind === 'review' && runId) return 'review';
  if (runId && item.purpose === 'run_notice') return 'run_notice';
  if (item.purpose === 'approval_plan') return 'approval_plan';
  if (item.purpose === 'conflict_proposal') return 'legacy_conflict_proposal';
  if (item.purpose === 'conflict_repair') return 'legacy_conflict_repair';
  if (item.purpose === 'close_refusal') return 'close_refusal';
  if (item.purpose === 'close_completion') return 'close_completion';
  if (item.purpose === 'close_start') return 'close_start';
  return 'none';
}

export type FinalizationConnection = OutboundConnection | (() => Promise<OutboundConnection>);

export interface FinalizationConfig {
  root: string;
  legacyHome?: string;
  snapshotRoot: string;
}

export interface FinalizationContext {
  config: FinalizationConfig;
  stored: StoredItem;
  store: CommunicationStore;
  resolveConnection: () => Promise<OutboundConnection | undefined>;
  done: () => Promise<OutboundItem | undefined>;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function json(path: string): Promise<JsonObject | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isJsonObject(value)) throw new Error(`Expected JSON object at ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined; }

function runDir(root: string, runId: string) { return join(patchpawPaths(root).runs, runId); }

export async function finalizeStaleReview(context: FinalizationContext) {
  const { config, stored, resolveConnection, done } = context;
  const item = stored.item;
  const source = sourceRun(item);
  if (!source) return done();
  const dir = runDir(config.root, source);
  const review = await json(join(dir, 'review.json'));
  if (!review || await json(join(dir, 'review-stale.json'))) return done();
  let actualHead = '';
  let prState = 'unknown';
  try {
    const resolved = await resolveConnection();
    if (!resolved) throw new Error('SCM connection required for stale Review finalization');
    if (resolved.adapter) {
      const projectId = typeof item.source.project_id === 'string' || typeof item.source.project_id === 'number'
        ? String(item.source.project_id) : item.repo.match(/^gitlab:(.+):project:(.+)$/)?.[2];
      if (!projectId) throw new Error('GitLab stale Review is missing its project id');
      const changeRequest = await resolved.adapter.readChangeRequest(projectId, item.pr_number, { allowClosed: true });
      actualHead = changeRequest.source.sha;
      prState = changeRequest.state;
    } else {
      if (!resolved.client) throw new Error('GitHub client required for stale Review finalization');
      const [owner, repo] = item.repo.split('/');
      const { data } = await resolved.client.rest.pulls.get({ owner, repo, pull_number: item.pr_number });
      actualHead = data.head.sha;
      prState = data.state;
    }
  } catch {
    // The cancellation record remains durable if the remote read is unavailable.
  }
  const trace = new Trace(dir);
  trace.save('review-stale.json', { expected_head: String(item.source.head_sha ?? ''), actual_head: actualHead, pr_state: prState });
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const state = await readState(path);
  if (state?.run_id === source) {
    trace.save('result.json', { status: 'review_stale', run_id: source, repo: item.repo, pr_number: item.pr_number,
      final_head_sha: String(item.source.head_sha ?? ''), recovered: true, expected_head: String(item.source.head_sha ?? ''), actual_head: actualHead, pr_state: prState });
    await writeState(path, applyRunPhase({ ...state, active: false }, 'review_stale'));
  }
  return done();
}

export async function finalizeReviewDelivery(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  const source = sourceRun(item);
  if (!source) return done();
  const dir = runDir(config.root, source);
  const review = await json(join(dir, 'review.json'));
  if (!review || await json(join(dir, 'review-publication.json'))) return done();
  const headSha = stringValue(review.head_sha);
  if (!headSha) throw new Error('Review artifact is missing head_sha');
  const publication = { ...(item.receipt ?? {}), run_id: source, kind: 'review', recovered: item.source.recovered === 1, reused: item.receipt?.reused ?? false };
  const trace = new Trace(dir);
  trace.save('review-publication.json', publication);
  const manifest = await json(join(dir, 'manifest.json'));
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const state = await readState(path);
  if (state?.run_id === source) {
    const existing = await json(join(dir, 'result.json'));
    if (!existing || existing.status !== 'review_completed') trace.save('result.json', { status: 'review_completed', run_id: source, repo: item.repo,
      pr_number: item.pr_number, final_head_sha: headSha, recovered: item.source.recovered === 1, review, publication });
    await writeState(path, applyRunPhase({ ...state, active: false, current_head_sha: headSha }, 'review_completed'));
    const workspacePath = stringValue(manifest?.workspace_path);
    if (workspacePath) {
      try { await disposeWorkspacePath(config.root, item.repo, workspacePath, trace); } catch { /* next lifecycle can retry cleanup */ }
    }
    trace.emit('review_delayed_delivery_finalized', { delivery_id: item.delivery_id, run_id: source });
  } else if (manifest) trace.emit('review_delayed_delivery_preserved', { delivery_id: item.delivery_id, run_id: source, current_run_id: state?.run_id });
  return done();
}

export async function finalizeRunNotice(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  const source = sourceRun(item);
  if (!source) return done();
  const dir = runDir(config.root, source);
  if (!await json(join(dir, 'manifest.json')) && !await json(join(dir, 'run-notice.json'))) return done();
  const trace = new Trace(dir);
  trace.save('notification.json', { status: 'published', ...(item.receipt ?? {}), delivery_id: item.delivery_id });
  trace.emit('run_notice_delayed_delivery_finalized', { delivery_id: item.delivery_id });
  return done();
}

export async function finalizeApprovalPlanPublication(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  // A Plan body is published through the durable outbox. If the original run could not
  // confirm the remote receipt, this mechanical finalizer records it here so `/approval`
  // can later verify a real publication. The Agent body is never re-read or re-shaped.
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const revision = Number(item.source.plan_revision);
  const planId = typeof item.source.plan_id === 'string' ? item.source.plan_id : undefined;
  const bodySha256 = typeof item.source.body_sha256 === 'string' ? item.source.body_sha256 : undefined;
  const plan = Number.isSafeInteger(revision) ? await readApprovalPlan(path, revision) : null;
  if (plan && plan.plan_id === planId && plan.body_sha256 === bodySha256 && plan.status === 'publication_pending') {
    const publication = { delivery_id: item.delivery_id, remote_id: item.receipt?.id, remote_url: item.receipt?.html_url,
      published_at: item.receipt?.published_at };
    await updateApprovalPlan(path, revision, { status: 'published', publication });
    const state = await readState(path);
    if (state?.approval_plan?.plan_id === planId && state.approval_plan.plan_revision === revision) {
      await writeState(path, applyRunPhase({ ...state, active: false,
        approval_plan: { ...state.approval_plan, status: 'published', ...publication } }, 'awaiting_approval'));
    }
    const paused = await readPaused(path);
    if (paused?.status === 'publication_pending') {
      await savePaused(path, { ...paused, status: 'awaiting_approval', pause_phase: 'awaiting_approval' });
    }
    new Trace(runDir(config.root, typeof item.source.run_id === 'string' ? item.source.run_id : '')).emit('approval_plan_publication_finalized',
      { delivery_id: item.delivery_id, plan_id: planId, plan_revision: revision, remote_id: item.receipt?.id });
  }
  return done();
}
