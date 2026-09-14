import { createTool } from '@mastra/core/tools';
import { ExecutionBudgetExhausted, createTaskSession, templateValuesFromSeed, type TaskOptions } from '../../harness/runtime.ts';
import { z } from 'zod';
import { conflictProposalDraftSchema, type ConflictProposalDraft } from '../../runner/conflict-proposals.ts';
import { HumanHelpRequested } from '../human-help.ts';

export type ConflictAnalysisResult =
  | { status: 'proposal_submitted'; draft: ConflictProposalDraft }
  | { status: 'needs_human'; summary: string }
  | { status: 'budget_exhausted'; summary: string };

const READ_ONLY_CONFLICT_TOOLS = new Set(['read_pr_comments', 'read_ci_evidence', 'git_diff']);

/**
 * Conflict analysis is deliberately a separate read-only task. It may inspect a mechanically
 * prepared merge/index, but the only task-specific write it can perform is submitting a
 * structured proposal to the Harness; it never edits, stages, commits or pushes.
 */
export async function runConflict(options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown): Promise<ConflictAnalysisResult> {
  let draft: ConflictProposalDraft | undefined;
  const session = createTaskSession({ ...options, task: 'conflict', prompt: '', readOnly: true,
    templateValues: templateValuesFromSeed(seed),
    tools: { ...Object.fromEntries(Object.entries(options.tools ?? {}).filter(([name]) => READ_ONLY_CONFLICT_TOOLS.has(name))),
      submit_conflict_proposal: createTool({
        id: 'submit_conflict_proposal',
        description: 'Submit a structured read-only conflict proposal for Harness validation. This does not edit, stage, commit, push, or approve anything.',
        inputSchema: conflictProposalDraftSchema,
        execute: async input => { draft = input; options.trace.emit('conflict_proposal_submitted', { affected_files: input.affected_files, conflicts: input.conflicts.length }); return { status: 'proposal_submitted' }; },
      }),
      // Make schema validation visible to providers that inspect the tool contract directly.
      validate_conflict_proposal: createTool({
        id: 'validate_conflict_proposal',
        description: 'Validate proposal fields without saving or publishing them.',
        inputSchema: z.object({ proposal: conflictProposalDraftSchema }),
        execute: async ({ proposal }) => ({ status: 'valid', affected_files: proposal.affected_files.length }),
      }),
    }, stopWhen: () => draft !== undefined });
  try {
    try { await session.turn(JSON.stringify(seed)); }
    catch (error) {
      if (error instanceof ExecutionBudgetExhausted) return { status: 'budget_exhausted', summary: 'Conflict 只读分析预算耗尽；工作区与已保存证据保留，尚未生成可审批提案。' };
      if (error instanceof HumanHelpRequested) return { status: 'needs_human', summary: error.message };
      throw error;
    }
    if (!draft) return { status: 'needs_human', summary: 'Conflict Agent 未提交结构化 Proposal；工作区保持只读并等待人工处理。' };
    return { status: 'proposal_submitted', draft };
  } finally { await session.close(); }
}
