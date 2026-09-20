import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { closeCompleteBodyFor, closeStartBodyFor } from './close.ts';
import { closeoutMarker } from './closeout-publication.ts';
import { enqueueCommentDelivery, enqueueReviewDelivery } from './outbound.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readState, statePath } from './state.ts';
import { reviewPayloadSchema } from '../tasks/review/result.ts';
import { runNoticeBody, type RunNotice } from './run-notice.ts';

export interface LegacyReconciliationConfig {
  root: string;
  operatorLogin?: string;
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
function numberValue(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function runDir(root: string, runId: string) { return join(patchpawPaths(root).runs, runId); }

const runNoticeSchema = z.object({
  run_id: z.string(),
  head: z.string(),
  status: z.string(),
  phase: z.string(),
  reason: z.string(),
  mentions: z.array(z.string()),
  bot_login: z.string().optional(),
  platform: z.enum(['github', 'gitlab']).optional(),
  failure: z.object({
    code: z.string(), category: z.enum(['provider', 'model', 'scm', 'workspace', 'internal']), retryable: z.boolean(),
    user_action: z.enum(['retry', 'check_configuration', 'human_review', 'inspect_logs']), message: z.string(),
    upstream_status: z.number().optional(), upstream_code: z.union([z.string(), z.number()]).optional(),
    attempts: z.number().optional(), scm_platform: z.enum(['github', 'gitlab']).optional(),
  }).optional(),
}).passthrough();

function parseRunNotice(value: JsonObject): RunNotice {
  return runNoticeSchema.parse(value);
}

async function legacyStatePaths(root: string) {
  const stateRoot = patchpawPaths(root).state;
  let repoKeys: string[];
  try { repoKeys = await readdir(stateRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const paths: string[] = [];
  for (const repoKey of repoKeys) {
    let names: string[];
    try { names = await readdir(join(stateRoot, repoKey)); } catch { continue; }
    for (const name of names.filter(value => /^pr-\d+\.json$/.test(value))) paths.push(join(stateRoot, repoKey, name));
  }
  return paths;
}

/** One migration pass for pre-outbox state artifacts. State JSON is authoritative for repo/PR. */
export async function reconcileLegacyOutbox(config: LegacyReconciliationConfig, botLogin?: string) {
  const runsRoot = patchpawPaths(config.root).runs;
  let runs: string[];
  try { runs = await readdir(runsRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') runs = []; else throw error; }
  for (const runId of runs) {
    const dir = runDir(config.root, runId);
    const manifest = await json(join(dir, 'manifest.json'));
    const repo = stringValue(manifest?.repo);
    const prNumber = numberValue(manifest?.pr_number);
    if (!repo || prNumber === undefined) continue;
    const state = await readState(statePath(patchpawPaths(config.root).state, repo, prNumber));
    const review = await json(join(dir, 'review.json'));
    const publication = await json(join(dir, 'review-publication.json'));
    if (review && !publication && ['review_ready', 'review_publishing'].includes(state?.phase ?? 'review_ready')) {
      const headSha = stringValue(review.head_sha);
      if (!headSha) throw new Error(`Legacy review artifact is missing head_sha: ${dir}`);
      const { head_sha: _headSha, ...reviewPayload } = review;
      const mentions = [stringValue(manifest?.request_author), config.operatorLogin ?? repo.split('/')[0]].filter((value): value is string => !!value);
      await enqueueReviewDelivery({ root: config.root, repo, prNumber, semanticKey: `review:${runId}:${headSha}`,
        headSha, review: reviewPayloadSchema.parse(reviewPayload), mentions, botLogin, runId, allowLegacy: true,
        source: { run_id: runId, head_sha: headSha, recovered: 1 } });
    }
    const noticeRaw = await json(join(dir, 'run-notice.json'));
    const notification = await json(join(dir, 'notification.json'));
    if (noticeRaw && notification?.status !== 'published') {
      const notice = parseRunNotice(noticeRaw);
      await enqueueCommentDelivery({ root: config.root, repo, prNumber, purpose: 'run_notice',
        semanticKey: `run-notice:${notice.run_id}`, body: runNoticeBody(notice), mentions: notice.mentions,
        botLogin: notice.bot_login ?? botLogin,
        legacyMarkers: ['budget_exhausted', 'stopped'].includes(notice.status) ? [closeoutMarker(notice.run_id)] : undefined,
        source: { run_id: notice.run_id, status: notice.status } });
    }
  }

  for (const path of await legacyStatePaths(config.root)) {
    const state = await readState(path);
    if (!state?.repo || !state.pr_number) continue;
    const mentions = state.close_mentions ?? [state.repo.split('/')[0]];
    if (state.completion_notice_status === 'pending' && state.closed_through_comment_id) {
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_completion',
        semanticKey: `close-completion:${state.close_comment_id ?? state.closed_through_comment_id}`, body: closeCompleteBodyFor(state.repo), mentions,
        botLogin, source: { close_comment_id: state.close_comment_id ?? state.closed_through_comment_id } });
    }
    if (state.pending_close_refusal) {
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_refusal',
        semanticKey: `close-refusal:${state.pending_close_refusal.comment_id}`,
        body: '当前任务仍在运行，请先 /stop，再执行 /close。',
        mentions: [state.pending_close_refusal.author ?? state.repo.split('/')[0]], botLogin,
        source: { comment_id: state.pending_close_refusal.comment_id } });
    }
    const journal = await json(`${path}.close.json`);
    if (journal?.status === 'closing' && !journal.start_notice_id) {
      const closeCommentId = typeof journal.close_comment_id === 'string' || typeof journal.close_comment_id === 'number'
        ? journal.close_comment_id : null;
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_start',
        semanticKey: `close-start:${String(closeCommentId ?? '')}`, body: closeStartBodyFor(state.repo), mentions: strings(journal.mentions), botLogin,
        source: { close_comment_id: closeCommentId } });
    }
  }
}
