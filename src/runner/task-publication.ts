import type { Trace } from '../harness/trace.ts';
import type { ScmAdapter } from '../scm/types.ts';
import { publishTaskAnswer, type TaskPublicationInput } from './publication.ts';
import { readPaused, savePaused } from './resume.ts';
import type { GenericApprovalBinding } from './approval-plan-execution.ts';

type Finish = (status: string, extra?: { reason?: string; message?: string; [key: string]: unknown }) => Promise<unknown>;

export interface TaskPublicationInputWithLifecycle {
  root: string;
  repo: string;
  prNumber: number;
  runId: string;
  path: string;
  workspacePath: string;
  status: TaskPublicationInput['status'];
  body: string;
  workspaceNotice: string;
  headSha: string;
  projectId: string;
  mentions: string[];
  botLogin: string;
  adapter: ScmAdapter;
  trace: Trace;
  approvalPlan?: GenericApprovalBinding;
  guard: () => Promise<void>;
  finish: Finish;
}

export async function publishTaskWithLifecycle(input: TaskPublicationInputWithLifecycle): Promise<unknown> {
  await input.guard();
  const paused = await readPaused(input.path);
  if (paused?.workspace.path === input.workspacePath) await savePaused(input.path, { ...paused, status: 'completed' });
  const published = await publishTaskAnswer({
    root: input.root, repo: input.repo, prNumber: input.prNumber, runId: input.runId, status: input.status,
    body: input.body, workspaceNotice: input.workspaceNotice, headSha: input.headSha, projectId: input.projectId, mentions: input.mentions,
    botLogin: input.botLogin, adapter: input.adapter, trace: input.trace,
    source: { project_id: input.projectId, run_id: input.runId, status: input.status }, approvalPlan: input.approvalPlan,
    guard: input.guard,
  });
  return input.finish(input.status, published);
}
