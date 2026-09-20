import { runConversation } from '../tasks/conversation/agent.ts';
import type { TaskOptions } from '../harness/runtime.ts';
import type { ScmAdapter } from '../scm/types.ts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { excerpt } from '../harness/context/policy.ts';
import { Trace } from '../harness/trace.ts';

type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<unknown>;
type DeliverComment = (purpose: string, semanticKey: string, body: string, mentions: string[], source?: Record<string, string | number | null | undefined>) => Promise<{ publication: unknown }>;

function cleanString(trace: Trace, value: string) {
  const cleaned: unknown = JSON.parse(trace.clean(value));
  if (typeof cleaned !== 'string') throw new Error('Conversation answer did not remain a string after redaction');
  return cleaned;
}

export interface ConversationRunInput {
  repo: string;
  prNumber: number;
  runId: string;
  trace: Trace;
  scm: ScmAdapter;
  projectId: string;
  taskOptions: TaskOptions;
  seed: () => Promise<unknown>;
  beginTask: (name: string) => Promise<void>;
  deliverComment: DeliverComment;
  recipients: () => string[];
  finish: Finish;
}

export async function runConversationReply(input: ConversationRunInput): Promise<unknown> {
  const { prNumber, runId, trace, scm, projectId, taskOptions, seed, beginTask, deliverComment, recipients, finish } = input;
  await beginTask('conversation');
  const conversationTools = {
    read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior PR conversation comments for context, paginated oldest first.',
      inputSchema: z.object({ page: z.number().int().positive().default(1) }),
      execute: async ({ page }: { page: number }) => {
        const comments = await scm.listComments(projectId, prNumber);
        return excerpt(JSON.stringify(comments.slice((page - 1) * 20, page * 20)));
      } }),
  };
  const conversation = await runConversation({ ...taskOptions, tools: { ...conversationTools } }, await seed());
  trace.save('conversation.json', conversation);
  if (conversation.kind !== 'reply') {
    return finish('needs_human', { reason: '当前 canonical conversation runner 不会在没有可验证 Conflict Proposal 绑定时发布讨论修订。' });
  }
  const body = cleanString(trace, conversation.body);
  const publication = (await deliverComment('conversation_reply', 'run:' + runId + ':conversation', body, recipients(), { run_id: runId })).publication;
  trace.save('conversation-publication.json', publication);
  trace.emit('conversation_reply_published', publication as object);
  return finish('conversation_completed', { answer: body, publication });
}
