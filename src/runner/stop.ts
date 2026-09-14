import { readHumanReplies } from './human-feedback.ts';
import { parsePRTask } from './command.ts';
import type { HumanReply } from '../github/comments.ts';

export class TaskStopped extends Error {
  constructor(message = '人类请求 /stop：任务已暂停。当前没有可用的 Agent 收尾说明，以下报告由 Harness 可观测证据补充。') { super(message); }
}

// Consume the existing durable comment inbox, avoiding signals to recycled PIDs.
// An /close arriving during an active task must never destroy the workspace underneath it:
// the optional onClose callback lets the owning worker refuse it deterministically (no model).
export function watchStop(path: string, bot: string, handled: () => number[], onClose?: (comment: HumanReply) => Promise<void>) {
  const controller = new AbortController();
  let request: HumanReply | undefined;
  let pending: Promise<void> | undefined;
  let refusing: Promise<void> | undefined;
  const check = async () => {
    if (request) return;
    pending ??= (async () => {
      const replies = await readHumanReplies(path);
      const unhandled = () => replies.filter(c => !handled().includes(c.comment_id));
      request = unhandled().find(c => parsePRTask(c.body, bot) === 'stop');
      if (request) { controller.abort(new TaskStopped()); return; }
      const close = onClose ? unhandled().find(c => parsePRTask(c.body, bot) === 'close') : undefined;
      if (close && onClose && !refusing) refusing = onClose(close).finally(() => { refusing = undefined; });
    })().finally(() => { pending = undefined; });
    await pending;
  };
  const timer = setInterval(() => { void check().catch(() => {}); }, 250);
  timer.unref();
  return { signal: controller.signal, request: () => request, check,
    async guard() { await check(); if (controller.signal.aborted) throw controller.signal.reason; },
    async close() { clearInterval(timer); await pending; await refusing?.catch(() => {}); } };
}
