import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createTaskSession, renderRuntimePrompt, templateValuesFromSeed, type TaskOptions } from '../../harness/runtime.ts';
import { conflictProposalDraftSchema, type ConflictProposalDraft } from '../../runner/conflict-proposals.ts';

type Decision = { kind: 'reply'; body: string } | { kind: 'proposal_revision'; draft: ConflictProposalDraft };

// A human mention is a conversation, not implicit permission to modify the PR.
export async function runConversation(options: Omit<TaskOptions, 'task' | 'prompt' | 'readOnly'>, seed: unknown) {
  let decision: Decision | undefined;
  const session = createTaskSession({ ...options, task: 'conversation', readOnly: true,
    prompt: '',
    templateValues: templateValuesFromSeed(seed),
    tools: { ...options.tools,
      reply_to_pr: createTool({ id: 'reply_to_pr', description: 'Submit your conversational answer or question to be published on this PR, then end without repair, tests, commit or push.',
        inputSchema: z.object({ body: z.string().trim().min(1) }),
        execute: async ({ body }) => { decision ??= { kind: 'reply', body }; return { status: 'reply_submitted' }; } }),
      ...(options.conflictDiscussion ? {
        submit_conflict_proposal: createTool({
          id: 'submit_conflict_proposal',
          description: 'Submit a revised structured Conflict Proposal for Harness validation. Discussion remains read-only and this does not authorize repair.',
          inputSchema: conflictProposalDraftSchema,
          execute: async draft => { decision ??= { kind: 'proposal_revision', draft }; return { status: 'proposal_revision_submitted' }; },
        }),
      } : {}),
    }, stopWhen: () => decision !== undefined });
  try {
    await session.turn(JSON.stringify(seed));
    if (!decision) {
      const retry = renderRuntimePrompt(options, 'conversation-retry', templateValuesFromSeed(seed), true);
      if (retry) await session.turn(retry);
      else options.trace.emit('prompt_role_unavailable', { task: 'conversation', role: 'conversation-retry' });
    }
    if (!decision) throw new Error('Conversation ended without a reply or task handoff');
    return decision;
  } finally { await session.close(); }
}
