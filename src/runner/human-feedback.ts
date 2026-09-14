import { mkdir, readFile, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HumanReply } from '../github/comments.ts';
import { readState } from './state.ts';

export async function saveHumanReply(path: string, reply: HumanReply) {
  await mkdir(`${path}.comments`, { recursive: true });
  const temporary = join(`${path}.comments`, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(reply) + '\n');
  try {
    // Publish complete JSON atomically and never overwrite a redelivered comment.
    await link(temporary, join(`${path}.comments`, `${reply.comment_id}.json`));
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  finally { await unlink(temporary); }
}
export async function readHumanReplies(path: string): Promise<HumanReply[]> {
  let names: string[];
  try { names = await readdir(`${path}.comments`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const replies = await Promise.all(names.filter(n => /^\d+\.json$/.test(n)).map(async n =>
    JSON.parse(await readFile(join(`${path}.comments`, n), 'utf8')) as HumanReply));
  return replies.sort((a, b) => a.comment_id - b.comment_id);
}
export async function hasHumanReplies(path: string) {
  const state = await readState(path);
  const handled = new Set(state?.handled_comment_ids ?? []);
  // Comments retired by /close stay retired even if GitHub redelivers them after cleanup.
  const retired = state?.closed_through_comment_id ?? 0;
  return (await readHumanReplies(path)).some(reply => reply.comment_id > retired && !handled.has(reply.comment_id));
}

export async function humanFeedback(path: string, runsRoot: string, oneComment = false) {
  const previous = await readState(path);
  const retired = previous?.closed_through_comment_id ?? 0;
  const comments = await readHumanReplies(path);
  const pending = comments.filter(c => c.comment_id > retired && !previous?.handled_comment_ids?.includes(c.comment_id));
  const fresh = oneComment ? pending.slice(0, 1) : pending;
  const visible = comments.filter(c => c.comment_id > retired && (!pending.includes(c) || fresh.includes(c)));
  // A closed local generation has no previous run context: its runs were deleted by /close,
  // so the next mention starts fresh instead of resurrecting a deleted run id as history.
  const closed = previous?.phase === 'closed';
  let previousResult: { status: string; reason?: string; message?: string } | undefined;
  if (fresh.length && previous && !closed) {
    try { previousResult = JSON.parse(await readFile(join(runsRoot, previous.run_id, 'result.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { handledIds: [...new Set([...(previous?.handled_comment_ids ?? []), ...fresh.map(c => c.comment_id)])],
    context: fresh.length ? { previous_run_id: closed ? undefined : previous?.run_id, previous_result: previousResult, comments: visible,
      new_comment_ids: fresh.map(c => c.comment_id),
      instruction: 'Respond to the new_comment_ids in context. A human mention is not automatically a request to repair code. This PR has a persistent conversation thread. Only Harness decides whether a paused Conflict workspace is safe to resume; use the supplied workspace and current Git facts.' } : undefined };
}
