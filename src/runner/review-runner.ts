import { join } from 'node:path';
import type { TaskOptions } from '../harness/runtime.ts';
import { runReview } from '../tasks/review/agent.ts';
import { completeReview, readArtifact, type ReviewLifecycle } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readPaused, savePaused } from './resume.ts';
import { Trace } from '../harness/trace.ts';
import type { RunState } from './state.ts';

type ReviewConnection = ReviewLifecycle['connection'];
type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<unknown>;

export interface ReviewRunInput {
  root: string;
  repo: string;
  prNumber: number;
  trace: Trace;
  state: RunState;
  path: string;
  resumed: { run_id: string } | null;
  currentHead: () => string;
  taskOptions: TaskOptions;
  seed: () => Promise<unknown>;
  workspaceNotice: string;
  writable: boolean;
  hasWorkspaceChanges: () => Promise<boolean>;
  publish: (kind: string) => Promise<void>;
  stopGuard: () => Promise<void>;
  savePausedCompleted: () => Promise<void>;
  beginTask: (name: string) => Promise<void>;
  connection: ReviewConnection;
  mentions: () => string[];
  finish: Finish;
  settleApproval: (phase: 'completed' | 'interrupted') => Promise<void>;
}

export async function runReviewTask(input: ReviewRunInput): Promise<unknown> {
  const { root, repo, prNumber, trace, state, path, resumed, currentHead, taskOptions, seed,
    workspaceNotice, writable, hasWorkspaceChanges, publish, stopGuard, savePausedCompleted, beginTask, connection, mentions, finish, settleApproval } = input;
  await beginTask('review');
  const priorDir = resumed ? join(patchpawPaths(root).runs, resumed.run_id) : null;
  const settledPublication = priorDir ? await readArtifact(priorDir, 'review-publication.json') : null;
  if (settledPublication?.commit_id === currentHead()) {
    if (!priorDir || !resumed) throw new Error('Settled review publication is missing its recovery run');
    const settledReview = await readArtifact(priorDir, 'review.json');
    if (settledReview) {
      trace.save('resume-review.json', settledReview);
      trace.save('resume-review-publication.json', settledPublication);
      trace.save('review.json', settledReview);
      trace.save('review-publication.json', settledPublication);
      trace.emit('review_settled_resume', { previous_run_id: resumed.run_id, commit_id: settledPublication.commit_id });
    }
  }
  const settled = await readArtifact(trace.dir, 'review-publication.json');
  if (!settled) {
    const outcome = await runReview({ ...taskOptions, opaqueOutcome: true }, await seed());
    if (outcome.outcome === 'unfinished') return await finish(outcome.status, { reason: outcome.reason });
    const review = outcome.body;
    await stopGuard();
    const body = workspaceNotice ? workspaceNotice + review : review;
    if (writable && await hasWorkspaceChanges()) await publish('review');
    trace.save('review.json', { head_sha: currentHead(), body });
  }
  await stopGuard();
  await savePausedCompleted();
  const result = await completeReview({ trace, state, path, runtimeHome: root, recovered: false,
    settled_run_id: settled ? resumed?.run_id : undefined,
    connection: async () => ({ ...await connection(), mentions: mentions() }) });
  await stopGuard();
  await settleApproval('completed');
  return result;
}
