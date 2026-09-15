import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tryAcquireFileLock } from '../platform/lock.ts';
import { isProcessAlive } from '../platform/process.ts';
import { safeStorageDirectory } from '../scm/identity.ts';

export interface RunState {
  repo: string; pr_number: number; run_id: string; current_head_sha: string;
  phase: string; repair_attempts: number; last_patchpaw_commit: string | null; waiting_for_ci: boolean;
  active: boolean; pid: number;
  handled_comment_ids?: number[];
  execution_id?: number;
  // /close local-generation tombstone facts. closed_through_comment_id is a durable high-water
  // mark: comments retired by /close can never execute again even if GitHub redelivers them
  // after the inbox was cleaned; it survives into the next fresh conversation generation.
  closed_at?: string;
  closed_through_comment_id?: number;
  close_start_notice_id?: number;
  close_comment_id?: number;
  close_mentions?: string[];
  completion_notice_id?: number;
  completion_notice_status?: 'pending' | 'published' | 'failed';
  // Durable outbox for an active-task /close refusal whose notice could not be published yet.
  // The comment itself is retired immediately in handled_comment_ids; only the notice retries.
  pending_close_refusal?: { comment_id: number; author?: string };
  // The latest Conflict Proposal is an index into immutable proposal versions. The proposal
  // files and communication outbox remain the evidence sources; this pointer is never enough
  // to reconstruct a proposal by itself.
  conflict_proposal?: {
    proposal_id: string; proposal_revision: number; proposal_hash: string;
    status: 'draft' | 'publication_pending' | 'published' | 'superseded' | 'stale';
    run_id: string; execution_id: string; workspace_path: string;
    pr_head_sha: string; pr_head_ref?: string; pr_head_repo?: string; current_base_tip_sha: string; base_ref: string;
    workspace_evidence_sha256: string; command_snapshot_id: string; command_snapshot_sha256: string;
    publication_delivery_id?: string; publication_remote_id?: number; publication_remote_url?: string; published_at?: string;
  };
}
export function statePath(root: string, repo: string, number: number) {
  const directory = repo.startsWith('gitlab:') ? safeStorageDirectory(repo) : repo.replace('/', '__');
  return join(root, directory, `pr-${number}.json`);
}
export async function readState(path: string): Promise<RunState | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function writeState(path: string, state: RunState) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n'); await rename(temporary, path);
}
export function workerStatus(state: RunState | null): 'idle' | 'running' | 'interrupted' {
  if (!state?.active) return 'idle';
  return pidAlive(state.pid) ? 'running' : 'interrupted';
}
export function pidAlive(pid: number): boolean {
  return isProcessAlive(pid);
}
export async function claimRun(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const releaseLock = await tryAcquireFileLock(`${lock}.guard`, 'exclusive', { reentrant: false });
  if (!releaseLock) return null;
  try {
    // Respect a still-running worker from the previous PID-file implementation.
    let previous: string | null = null;
    try { previous = await readFile(lock, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== null && pidAlive(Number(previous))) { await releaseLock(); return null; }
    await writeFile(lock, String(process.pid));
  } catch (error) { await releaseLock(); throw error; }
  let released = false;
  return async () => {
    if (released) return; released = true;
    try {
      // Do not remove a marker written by a newer owner if cleanup is delayed.
      const owner = await readFile(lock, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (owner?.trim() === String(process.pid)) await unlink(lock).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    } finally { await releaseLock(); }
  };
}
export async function savePending(path: string, headSha: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pending.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ head_sha: headSha }));
  await rename(temporary, `${path}.pending.json`);
}
export async function takePending(path: string): Promise<string | null> {
  const claimed = `${path}.claimed.${randomUUID()}.json`;
  try {
    await rename(`${path}.pending.json`, claimed);
    const value = JSON.parse(await readFile(claimed, 'utf8'));
    await unlink(claimed); return value.head_sha;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
