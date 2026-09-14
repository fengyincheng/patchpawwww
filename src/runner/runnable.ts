import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasHumanReplies } from './human-feedback.ts';
import { readState, statePath } from './state.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readUnfinishedConflictApproval } from './conflict-approval.ts';

async function json(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// One wake predicate for PR-local mechanical work. Pure outbound retries are
// handled by the outbox scheduler, while this predicate lets legacy review,
// notice and close recovery run without requiring another human comment.
export async function hasRunnableWork(root: string, repo: string, number: number) {
  const path = statePath(patchpawPaths(root).state, repo, number);
  if (await hasHumanReplies(path)) return true;
  const state = await readState(path);
  if (!state) return false;
  // An approval claim/repair is durable work even after the source comment has been
  // marked handled. This lets a webhook redelivery or a later human entry wake the
  // mechanical recovery path without consuming the approval a second time.
  if (await readUnfinishedConflictApproval(path)) return true;
  if (state.completion_notice_status === 'pending' || state.pending_close_refusal) return true;
  const journal = await json(`${path}.close.json`);
  if (journal?.status === 'closing') return true;
  const runDir = join(patchpawPaths(root).runs, state.run_id);
  const review = await json(join(runDir, 'review.json'));
  const publication = await json(join(runDir, 'review-publication.json'));
  if (review && !publication && ['review_ready', 'review_publishing'].includes(state.phase)) return true;
  const notice = await json(join(runDir, 'run-notice.json'));
  const notification = await json(join(runDir, 'notification.json'));
  return !!notice && notification?.status !== 'published';
}
