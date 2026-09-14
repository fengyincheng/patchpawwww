import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import { reviewResultSchema } from '../tasks/review/result.ts';
import { ReviewStale } from '../github/review-publisher.ts';
import { Trace } from '../harness/trace.ts';
import { writeState, type RunState } from './state.ts';
import { deliverImmediately, enqueueReviewDelivery, OutboundPending } from './outbound.ts';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const reviewArtifactSchema = reviewResultSchema.extend({ head_sha: shaSchema });
const publicationSchema = z.object({
  id: z.number().int().positive(), html_url: z.url(), commit_id: shaSchema, published_at: z.string().min(1),
  run_id: z.string(), kind: z.literal('review'), recovered: z.boolean(), reused: z.boolean(),
});
export async function readArtifact(dir: string, name: string): Promise<any | null> {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function reviewCheckpoint(dir: string) {
  const result = await readArtifact(dir, 'result.json');
  if (result?.status === 'review_completed') return 'review_completed';
  if (result?.status === 'review_stale') return 'review_stale';
  if (await readArtifact(dir, 'review-publication.json')) return 'review_publishing';
  if (await readArtifact(dir, 'review.json')) return 'review_ready';
  return 'review_running';
}
export async function needsReviewRecovery(state: RunState, dir: string) {
  // review-publication.json is written only after confirmed remote evidence. Once it is
  // durable, the publication can never be "lost" again — even if a later /stop overwrote
  // result.json with a stopped terminal state. Such a run is closed; continuation belongs
  // to the retained workspace and an explicit matching /review, not to recovery hijack.
  const settled = await readArtifact(dir, 'review-publication.json');
  if (settled) return state.active || state.waiting_for_ci;
  const point = await reviewCheckpoint(dir);
  return point === 'review_ready' || point === 'review_publishing'
    || (point === 'review_completed' && (state.active || state.phase !== point || state.waiting_for_ci));
}

export interface ReviewLifecycle {
  trace: Trace; state: RunState; path: string; runtimeHome: string; recovered: boolean;
  // Set when this execution resumes a workspace whose prior run already settled the review publication.
  settled_run_id?: string;
  connection: () => Promise<{ client: Octokit; botLogin: string; mentions: string[] }>;
}
async function checkpoint(ctx: ReviewLifecycle, phase: string) {
  ctx.state.phase = phase; ctx.state.waiting_for_ci = false;
  await writeState(ctx.path, ctx.state);
  ctx.trace.emit('phase', { phase, recovered: ctx.recovered });
}

export async function finalizeReview(ctx: ReviewLifecycle, result: Record<string, unknown>) {
  // Result first: death before the state write is recoverable without any remote action.
  ctx.trace.save('result.json', result);
  ctx.state.active = false; // pid is retained only as historical worker identity.
  await checkpoint(ctx, String(result.status));
  return result;
}

export async function ensureReviewPublished(ctx: ReviewLifecycle) {
  const { trace, state } = ctx;
  const review = reviewArtifactSchema.parse(await readArtifact(trace.dir, 'review.json'));
  const saved = await readArtifact(trace.dir, 'review-publication.json');
  if (saved) {
    const publication = publicationSchema.parse(saved);
    // A resumed execution may carry the settled publication of the run it resumes;
    // identity is that run's id, and the commit match still pins it to this review.
    if ((publication.run_id !== state.run_id && publication.run_id !== ctx.settled_run_id) || publication.commit_id !== review.head_sha) {
      throw new Error('Publication artifact does not match run/review identity');
    }
    return { review, publication }; // Confirmed remote evidence: finalization only, zero GitHub actions.
  }
  await checkpoint(ctx, 'review_ready');
  const { client, botLogin, mentions } = await ctx.connection();
  await checkpoint(ctx, 'review_publishing');
  const stored = await enqueueReviewDelivery({ root: ctx.runtimeHome, repo: state.repo, prNumber: state.pr_number,
    semanticKey: `review:${state.run_id}:${review.head_sha}`, headSha: review.head_sha, review, mentions, botLogin,
    runId: state.run_id, allowLegacy: ctx.recovered, source: { run_id: state.run_id, head_sha: review.head_sha, recovered: ctx.recovered ? 1 : 0 } });
  const attempt = await deliverImmediately(ctx.runtimeHome, stored, { client, botLogin });
  if (attempt.item.status !== 'delivered') throw new OutboundPending(attempt.item);
  const published = attempt.item.receipt!;
  const publication = publicationSchema.parse({ ...published, run_id: state.run_id, kind: 'review', recovered: ctx.recovered });
  trace.save('review-publication.json', publication);
  trace.emit('review_published', publication);
  return { review, publication };
}

export async function completeReview(ctx: ReviewLifecycle) {
  const existing = await readArtifact(ctx.trace.dir, 'result.json');
  if (existing?.status === 'review_completed') {
    if (existing.run_id !== ctx.state.run_id || existing.repo !== ctx.state.repo || existing.pr_number !== ctx.state.pr_number) {
      throw new Error('Completed result does not match recovery target');
    }
    ctx.state.current_head_sha = existing.final_head_sha;
    ctx.state.active = false;
    await checkpoint(ctx, 'review_completed');
    return { ...existing, status: 'already_completed' };
  }
  try {
    const { review, publication } = await ensureReviewPublished(ctx);
    ctx.state.current_head_sha = review.head_sha;
    return await finalizeReview(ctx, { status: 'review_completed', run_id: ctx.state.run_id,
      repo: ctx.state.repo, pr_number: ctx.state.pr_number, final_head_sha: review.head_sha,
      recovered: ctx.recovered, review, publication });
  } catch (error) {
    if (error instanceof ReviewStale) {
      const evidence = { expected_head: error.expectedHead, actual_head: error.actualHead, pr_state: error.prState };
      ctx.trace.save('review-stale.json', evidence);
      return await finalizeReview(ctx, { status: 'review_stale', run_id: ctx.state.run_id, repo: ctx.state.repo,
        pr_number: ctx.state.pr_number, final_head_sha: error.expectedHead, recovered: ctx.recovered, ...evidence });
    }
    // Leave the durable model output available for retry, not a terminal Agent failure.
    ctx.state.active = false;
    await checkpoint(ctx, await reviewCheckpoint(ctx.trace.dir));
    ctx.trace.save('publication-error.json', { status: 'publication_interrupted',
      http_status: (error as { status?: number }).status ?? null, error_name: (error as Error).name });
    throw error;
  }
}
