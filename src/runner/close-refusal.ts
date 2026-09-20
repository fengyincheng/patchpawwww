import type { HumanReply } from './human-reply.ts';
import { closeRefusalBody } from './close.ts';
import { deliverImmediately, enqueueCommentDelivery, type OutboundConnection } from './outbound.ts';
import { writeState, type RunState } from './state.ts';
import { Trace } from '../harness/trace.ts';

export interface CloseRefusalInput {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  statePath: string;
  state: RunState;
  trace: Trace;
  connection: () => Promise<OutboundConnection>;
  botLogin: string;
  comment: HumanReply;
}

export async function refuseCloseOnActiveTask(input: CloseRefusalInput): Promise<void> {
  const { root, repo, prNumber, runId, state, trace, botLogin, comment } = input;
  state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), comment.comment_id])];
  if (!state.pending_close_refusal) state.pending_close_refusal = { comment_id: comment.comment_id, author: comment.author };
  try { await writeState(input.statePath, state); }
  catch (error) { trace.emit('close_refusal_retire_degraded', { comment_id: comment.comment_id, message: (error as Error).message }); }
  try {
    const stored = await enqueueCommentDelivery({ root, repo, prNumber, purpose: 'close_refusal',
      semanticKey: `close-refusal:${comment.comment_id}`, body: closeRefusalBody, mentions: [comment.author], botLogin,
      source: { comment_id: comment.comment_id, run_id: runId } });
    const delivered = await deliverImmediately(root, stored, { ...await input.connection(), botLogin });
    if (delivered.item.status === 'delivered') {
      state.pending_close_refusal = undefined;
      await writeState(input.statePath, state);
    }
    trace.emit('close_refused_active_task', { comment_id: comment.comment_id });
  } catch (error) {
    trace.emit('close_refusal_notice_pending', { comment_id: comment.comment_id, message: (error as Error).message });
  }
}
