import { runConflict } from '../tasks/conflict/agent.ts';
import type { TaskOptions } from '../harness/runtime.ts';
import type { ScmAdapter } from '../scm/types.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { excerpt } from '../harness/context/policy.ts';
import { Trace } from '../harness/trace.ts';

type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<unknown>;
type Deliver = (status: 'conflict_completed', body: string) => Promise<unknown>;

export interface ConflictRunInput {
  repo: string;
  prNumber: number;
  scm: ScmAdapter;
  projectId: string;
  baseSha: string;
  baseRef: string;
  taskOptions: TaskOptions;
  seed: () => Promise<unknown>;
  trace: Trace;
  workspace: WorkspaceState;
  path: string;
  runId: string;
  beginTask: (name: string) => Promise<void>;
  retainWorkspace: (input: { run_id: string; execution_id: number; task: 'conflict'; workspace: WorkspaceState; base_sha: string; base_ref: string; pause_reason: 'human_decision' | 'budget' }) => Promise<void>;
  executionId: number;
  writebackEnabled: boolean;
  hasWorkspaceChanges: () => Promise<boolean>;
  publish: (kind: string) => Promise<void>;
  deliver: Deliver;
  finish: Finish;
  currentHead: () => string;
}

export async function runConflictTask(input: ConflictRunInput): Promise<unknown> {
  const { prNumber, scm, projectId, baseSha, baseRef, taskOptions, seed, trace, workspace, path, runId, beginTask, retainWorkspace,
    executionId, writebackEnabled, hasWorkspaceChanges, publish, deliver, finish, currentHead } = input;
  await beginTask('conflict');
  const analysis = await runConflict({ ...taskOptions, opaqueOutcome: true, tools: {
    read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior PR conversation comments for conflict context, paginated oldest first.',
      inputSchema: z.object({ page: z.number().int().positive().default(1) }),
      execute: async ({ page }: { page: number }) => {
        const comments = await scm.listComments(projectId, prNumber);
        return excerpt(JSON.stringify(comments.slice((page - 1) * 20, page * 20)));
      } }),
  } }, await seed());
  trace.save('conflict-result.json', analysis);
  if (analysis.status !== 'completed') {
    await retainWorkspace({ run_id: runId, execution_id: executionId, task: 'conflict', workspace,
      base_sha: baseSha, base_ref: baseRef,
      pause_reason: analysis.status === 'needs_human' ? 'human_decision' : 'budget' });
    return finish(analysis.status, { reason: analysis.summary });
  }
  if (!writebackEnabled || !await hasWorkspaceChanges()) return deliver('conflict_completed', analysis.body);
  await publish('conflict');
  const tick = String.fromCharCode(96);
  return deliver('conflict_completed', '## Conflict 修复完成\n\n' + analysis.body + '\n\n提交：' + tick + currentHead() + tick);
}
