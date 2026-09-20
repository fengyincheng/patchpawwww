import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from '../workspace/git.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import type { Trace } from '../harness/trace.ts';
import { readState, workerStatus } from './state.ts';

export interface PausedWorkspace {
  status: 'budget_exhausted' | 'needs_human' | 'stopped' | 'publication_pending' | 'awaiting_approval' | 'claimed' | 'stale' | 'completed';
  remote_head?: string; pause_phase?: string;
  pause_reason?: 'budget' | 'human_decision' | 'human_stop';
  task: 'custom' | 'conflict' | 'ci' | 'repair' | 'review'; run_id: string; execution_id: number; base_sha: string; base_ref: string;
  local_head: string; workspace: WorkspaceState; reason?: string;
}
export async function readPaused(path: string): Promise<PausedWorkspace | null> {
  try {
    const { verification_inputs, ...value } = JSON.parse(await readFile(`${path}.paused.json`, 'utf8'));
    value.workspace.verificationInputs = verification_inputs ? new Map(verification_inputs.map((v: { path: string; content: string; mode: number }) =>
      [v.path, { content: Buffer.from(v.content, 'base64'), mode: v.mode }])) : undefined;
    return value;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function serializePaused(value: PausedWorkspace) {
  return { ...value, workspace: { ...value.workspace, verificationInputs: undefined },
    verification_inputs: value.workspace.verificationInputs ? [...value.workspace.verificationInputs].map(([path, file]) =>
      ({ path, content: file.content.toString('base64'), mode: file.mode })) : undefined };
}
export async function savePaused(path: string, value: PausedWorkspace) {
  await mkdir(dirname(path), { recursive: true });
  const target = `${path}.paused.json`, temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(serializePaused(value)) + '\n'); await rename(temporary, target);
}

// Caller holds the PR lock throughout freshness checks, claiming, and execution.
// A separate pointer survives intervening read-only conversations and reviews.
// `dispose` releases a rejected candidate's checkout AFTER its stale reason is durable, so a
// stale pause never leaves a permanent workspace behind; PR memory and the candidate's run
// evidence are untouched. Disposal failure is recorded, never fatal to the fresh preparation.
export async function resumeWorkspace(path: string, current: { head: string; base: string; main: string; baseRef: string; ownerRunId?: string; task?: 'custom' | 'conflict' | 'ci' | 'repair' | 'review' }, trace: Trace,
  dispose?: (workspace: string) => Promise<void>, options: { allowApproval?: boolean } = {}) {
  const candidate = await readPaused(path);
  const resumableStatuses = options.allowApproval
    ? ['budget_exhausted', 'needs_human', 'stopped', 'awaiting_approval', 'claimed']
    : ['budget_exhausted', 'needs_human', 'stopped'];
  if (!candidate || !resumableStatuses.includes(candidate.status) || candidate.task !== (current.task ?? 'conflict')) return null;
  trace.emit('resume_candidate_found', { run_id: candidate.run_id, execution_id: candidate.execution_id });
  const reject = async (reason: string) => {
    trace.emit('resume_candidate_rejected', { run_id: candidate.run_id, reason });
    await savePaused(path, { ...candidate, status: 'stale', reason });
    if (dispose) {
      try { await dispose(candidate.workspace.path); trace.emit('stale_workspace_disposed', { workspace: candidate.workspace.path, reason }); }
      catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: candidate.workspace.path, reason, message: (error as Error).message }); }
    }
    return null;
  };
  const owner = await readState(path);
  if (workerStatus(owner) === 'running' && !(owner?.pid === process.pid && owner.run_id === current.ownerRunId)) {
    trace.emit('resume_candidate_rejected', { reason: 'worker_running' });
    throw new Error('Cannot resume a workspace owned by a live worker');
  }
  if ((candidate.remote_head ?? candidate.workspace.initialHead) !== current.head) return reject('pr_head_changed');
  if (candidate.base_sha !== current.base || candidate.workspace.mainSha !== current.main || candidate.base_ref !== current.baseRef) return reject('base_or_main_changed');
  try {
    const ws = candidate.workspace;
    const head = (await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== candidate.local_head) return reject('local_head_changed');
    await git(ws.path, ['fsck', '--connectivity-only', '--no-dangling']);
    await git(ws.path, ['cat-file', '-e', `${ws.initialHead}^{commit}`]);
    await git(ws.path, ['cat-file', '-e', `${ws.mainSha}^{commit}`]);
    await git(ws.path, ['status', '--porcelain']);
    ws.unmerged = (await git(ws.path, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
    const merge = await git(ws.path, ['rev-parse', '--verify', 'MERGE_HEAD'], undefined, undefined, true);
    ws.mergePending = merge.exitCode === 0;
    if (ws.mergePending && merge.stdout.trim() !== ws.mainSha) return reject('merge_head_changed');
    if (!ws.mergePending && candidate.task === 'conflict') await git(ws.path, ['merge-base', '--is-ancestor', ws.mainSha, 'HEAD']);
    const claimed = { ...candidate, status: 'claimed' as const, execution_id: candidate.execution_id + 1 };
    await savePaused(path, claimed);
    trace.emit('workspace_resumed', { workspace: ws.path, previous_run_id: candidate.run_id, execution_id: claimed.execution_id });
    return claimed;
  } catch { return reject('workspace_missing_or_corrupt'); }
}

export async function retainWorkspace(path: string, trace: Trace, input: Omit<PausedWorkspace, 'status' | 'task' | 'local_head'> & { task?: PausedWorkspace['task']; status?: PausedWorkspace['status'] }) {
  const local_head = (await git(input.workspace.path, ['rev-parse', 'HEAD'])).stdout.trim();
  const status = input.status ?? (input.pause_reason === 'human_stop' ? 'stopped' : input.pause_reason === 'human_decision' ? 'needs_human' : 'budget_exhausted');
  const value: PausedWorkspace = { ...input, status, pause_reason: input.pause_reason ?? 'budget', task: input.task ?? 'conflict', local_head };
  trace.save('paused-workspace.json', serializePaused(value));
  await savePaused(path, value);
  trace.emit('execution_paused', { execution_id: value.execution_id, workspace: value.workspace.path });
}
