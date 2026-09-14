import { readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { readState, writeState, workerStatus, type RunState } from './state.ts';
import { readPaused } from './resume.ts';
import { readHumanReplies } from './human-feedback.ts';
import { disposeWorkspacePath, isDisposableViewspace, runWorkspacePath } from '../workspace/repo-store.ts';
import { prMemoryPath } from '../harness/pr-memory.ts';
import { snapshotPRDir } from '../github/snapshot.ts';
import { cancelOutboundDelivery, deliverImmediately, enqueueAndDeliverComment, enqueueCommentDelivery, finalizeDelivery, listOutbound, type StoredItem } from './outbound.ts';
import { closeCommunicationStore, openCommunicationStore } from './communication-store.ts';
import { patchpawPaths } from '../config/paths.ts';
import { conflictProposalDirectory } from './conflict-proposals.ts';
import { isUnfinishedConflictApproval, listConflictApprovals, updateConflictApproval } from './conflict-approval.ts';

// /close is a mechanical storage-lifecycle command, never an Agent capability: it retires one
// PR's PatchPaw-local generation (workspace, runs, memory, snapshots, inbox, state) while the
// GitHub PR, the shared repository and every other PR stay untouched. No model call, no
// workspace creation, no GitHub PR state change.

// Deterministic refusal for an /close that arrives while a task is active (handoff §14.10-H).
export const closeRefusalBody = '当前任务仍在运行，请先 /stop，再执行 /close。';

// The journal carries everything a crash-resume needs without the inbox: the triggering
// comment id (its file may already be deleted) and the exact mentions of the original close.
// rejected_workspace_paths durably records inventory targets refused by the structural
// workspace boundary (e.g. a poisoned pointer), so a close never silently claims them.
export interface CloseJournal {
  status: 'closing' | 'completed';
  repo: string; pr_number: number;
  close_comment_id: number; start_notice_id: number | null; started_at: string;
  run_ids: string[]; workspace_paths: string[]; rejected_workspace_paths: string[]; mentions: string[];
  last_step: string; last_error: string | null;
}
const journalPath = (path: string) => `${path}.close.json`;

// Windows cannot unlink a database file while SQLite is releasing its last handle.
// The close path already owns the database lifecycle, so a short bounded retry is
// safe here and preserves the journal's failure semantics for a genuinely stuck file.
async function removeMemoryFile(path: string) {
  const attempts = process.platform === 'win32' ? 30 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '');
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function readJournal(path: string): Promise<CloseJournal | null> {
  try { return JSON.parse(await readFile(journalPath(path), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function saveJournal(path: string, journal: CloseJournal) {
  const target = journalPath(path), temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(journal) + '\n'); await rename(temporary, target);
}

export const closeStartBody = '## PatchPaw：开始清理本 PR 的本地会话\n\n已收到 `/close`。现在开始清理本 PR 在 PatchPaw 本地保存的会话记忆、相关 run 记录和工作区。\n\nGitHub PR 本身不会被关闭；共享仓库不会被删除；其他 PR 不受影响。';
export const closeCompleteBody = '## PatchPaw：本地会话已清除\n\n本 PR 在 PatchPaw 本地保存的会话记忆、相关 run 记录和工作区已清理完成。\n\nGitHub PR 本身未关闭；共享仓库仍保留；其他 PR 未受影响。\n以后再次 @patchpawwww 时，会从新的空白本地会话开始。';
export const closeFailedBody = (step: string) => `## PatchPaw：本地清理尚未完成\n\n\`/close\` 已开始，但本地清理在 \`${step}\` 阶段未完成。GitHub PR 未关闭，共享仓库未删除。\nPatchPaw 已保存清理进度；再次执行 \`/close\` 时应从剩余步骤继续，而不是重新创建会话或工作区。`;

// Runs are indexed by exact manifest ownership, never by path/filename heuristics.
async function ownedRunIds(root: string, repo: string, number: number) {
  const runsRoot = patchpawPaths(root).runs;
  let names: string[];
  try { names = await readdir(runsRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const owned: string[] = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(await readFile(join(runsRoot, name, 'manifest.json'), 'utf8'));
      if (manifest?.repo === repo && manifest?.pr_number === number) owned.push(name);
    } catch { /* missing or corrupt manifest: not positively owned, never deleted by guessing */ }
  }
  return owned;
}

export interface ClosePreparation {
  journal: CloseJournal;
  runIds: string[];
  start?: StoredItem;
  closedThrough: number;
  memoryFile: string;
  snapshots: string;
}

// /close retires the local approval lifecycle before deleting the artifacts that a delivered
// conflict proposal/repair delivery would otherwise need after their artifacts are deleted. A
// delivered report keeps its remote receipt and is finalized locally; an unpublished delivery is
// cancelled. An in-flight sender is a hard retry boundary: close waits for it instead of racing
// a remote POST that could lose its receipt. Marking the approval interrupted/stale first makes a
// late scheduler pass a harmless tombstone no-op.
async function retireConflictApprovalLifecycle(root: string, repo: string, number: number, path: string, strictSending = true) {
  for (const approval of await listConflictApprovals(path)) {
    if (isUnfinishedConflictApproval(approval)) {
      await updateConflictApproval(path, approval.approval_id, {
        status: 'stale', phase: 'interrupted', rejection_code: 'approval_after_close',
      });
    }
  }
  for (const stored of await listOutbound(root, { repo, prNumber: number })) {
    if (!['conflict_proposal', 'conflict_repair'].includes(stored.item.purpose) || stored.item.lifecycle_status !== 'pending') continue;
    if (stored.item.status === 'sending') {
      if (strictSending) throw new Error('Conflict delivery is currently sending; close will retry after its remote POST settles');
      continue;
    }
    if (stored.item.status === 'pending_retry' && stored.item.last_error?.code === 'sending_lease_expired') continue;
    if (stored.item.status === 'delivered' || stored.item.status === 'cancelled_stale') await finalizeDelivery(root, stored);
    else {
      const cancelled = await cancelOutboundDelivery(root, stored, `${stored.item.purpose}_closed`);
      if (cancelled?.status === 'sending' && strictSending) throw new Error('Conflict delivery started while close was retiring it; close will retry after its remote POST settles');
    }
  }
}

// This is deliberately local-only. It records the close intent, deletion inventory and
// start notice before any installation or App metadata request is attempted.
export async function prepareCloseStart(config: { root: string; snapshotRoot: string; legacyHome?: string }, repo: string, number: number, path: string,
  input: { comment_id: number; mentions: string[]; bot_login?: string }): Promise<ClosePreparation> {
  const state = await readState(path);
  const previousJournal = await readJournal(path);
  const replies = await readHumanReplies(path);
  const communication = await openCommunicationStore(config.root, config.legacyHome);
  let inboundHighWater = 0;
  try { inboundHighWater = await communication.maxInboundCommentId(repo, number); }
  finally { await closeCommunicationStore(communication); }
  const closedThrough = Math.max(input.comment_id, previousJournal?.close_comment_id ?? 0,
    state?.closed_through_comment_id ?? 0, inboundHighWater, ...replies.map(c => c.comment_id));
  const paused = await readPaused(path);
  const runIds = [...new Set([...previousJournal?.run_ids ?? [], ...await ownedRunIds(config.root, repo, number)])];
  const candidates = [...new Set([paused?.workspace.path, ...runIds.map(run => runWorkspacePath(config.root, run))]
    .filter((candidate): candidate is string => !!candidate))];
  const workspacePaths = candidates.filter(candidate => isDisposableViewspace(config.root, candidate));
  const rejectedPaths = candidates.filter(candidate => !isDisposableViewspace(config.root, candidate));
  const memoryFile = prMemoryPath(patchpawPaths(config.root).memory, repo, number);
  const snapshots = snapshotPRDir(config.snapshotRoot, repo, number);
  const journal: CloseJournal = previousJournal?.status === 'closing' ? previousJournal
    : { status: 'closing', repo, pr_number: number, close_comment_id: input.comment_id, start_notice_id: null,
      started_at: new Date().toISOString(), run_ids: runIds, workspace_paths: workspacePaths,
      rejected_workspace_paths: [], mentions: input.mentions, last_step: 'preflight', last_error: null };
  journal.run_ids = runIds; journal.workspace_paths = workspacePaths;
  journal.rejected_workspace_paths = [...new Set([...journal.rejected_workspace_paths ?? [], ...rejectedPaths])];
  await saveJournal(path, journal);
  // Retire any older conflict delivery before enqueueing the close-start notice. This prevents
  // strict per-PR outbox ordering from deadlocking close behind an unpublished proposal. If a
  // remote POST is already in flight, leave it untouched; the next close retry will reconcile it
  // after the sender's atomic status settles.
  await retireConflictApprovalLifecycle(config.root, repo, number, path, false);
  const start = journal.start_notice_id ? undefined : await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'close_start',
    semanticKey: `close-start:${journal.close_comment_id}`, body: closeStartBody, mentions: journal.mentions,
    botLogin: input.bot_login, source: { close_comment_id: journal.close_comment_id, closed_through: closedThrough,
      memory_file: memoryFile, snapshot_dir: snapshots } });
  return { journal, runIds, start, closedThrough, memoryFile, snapshots };
}

export async function preparePendingCloseStart(config: { root: string; snapshotRoot: string; legacyHome?: string }, repo: string, number: number,
  path: string, botLogin?: string) {
  const journal = await readJournal(path);
  if (!journal || journal.status !== 'closing') return undefined;
  return prepareCloseStart(config, repo, number, path, { comment_id: journal.close_comment_id, mentions: journal.mentions, bot_login: botLogin });
}

export async function runClose(config: { root: string; snapshotRoot: string; legacyHome?: string }, repo: string, number: number, path: string,
  input: { comment_id: number; client: Octokit; mentions: string[]; bot_login?: string }) {
  const state = await readState(path);
  // Defensive: routing already refuses active workers; never delete underneath a live task.
  if (workerStatus(state) === 'running' && state?.pid !== process.pid) return { status: 'close_refused_active_worker' };

  const prepared = await prepareCloseStart(config, repo, number, path, input);
  const { journal, runIds, closedThrough, memoryFile, snapshots } = prepared;

  // C. The machine-authored start comment is the human's external audit marker and must be
  // published BEFORE the first destructive operation; if it cannot be published, abort.
  if (!journal.start_notice_id) {
    try {
      if (!prepared.start) throw new Error('Close start outbox item was not prepared');
      const result = await deliverImmediately(config.root, prepared.start,
        { client: input.client, botLogin: input.bot_login });
      if (result.item.status !== 'delivered') {
        journal.last_step = 'start_notice'; journal.last_error = result.item.last_error?.name ?? result.item.status;
        await saveJournal(path, journal);
        return { status: 'close_start_unpublished', run_ids: runIds.length, publication: result.publication };
      }
      journal.start_notice_id = result.item.receipt?.id ?? null; journal.last_step = 'start_published';
      await saveJournal(path, journal);
    } catch (error) {
      journal.last_step = 'start_notice'; journal.last_error = (error as Error).message;
      await saveJournal(path, journal);
      return { status: 'close_start_unpublished', run_ids: runIds.length };
    }
  }

  // E. Cleanup in the mandated order: workspace → refs → memory → runs → snapshots → inbox →
  // tombstone. The shared repository itself is never a deletion target. Workspace disposal
  // converges or throws: a close can never claim completion while a controlled path survives.
  const steps: [string, () => Promise<void>][] = [
    ['conflict_approval', async () => { await retireConflictApprovalLifecycle(config.root, repo, number, path); }],
    ['workspace', async () => {
      for (const workspace of journal.workspace_paths) await disposeWorkspacePath(config.root, repo, workspace);
      await rm(`${path}.paused.json`, { force: true });
    }],
    // No PR-scoped refs exist in the P0 repo-store (exact-SHA fetches only); the step remains
    // explicit so a future refs/patchpaw/pr/<n>/… design has a sequenced home.
    ['refs', async () => {}],
    ['memory', async () => { for (const suffix of ['', '-wal', '-shm']) await removeMemoryFile(`${memoryFile}${suffix}`); }],
    ['runs', async () => { for (const run of journal.run_ids) await rm(join(patchpawPaths(config.root).runs, run), { recursive: true, force: true }); }],
    ['proposals', async () => { await rm(conflictProposalDirectory(path), { recursive: true, force: true }); }],
    ['snapshots', async () => { await rm(snapshots, { recursive: true, force: true }); }],
    ['inbox', async () => {
      await rm(`${path}.comments`, { recursive: true, force: true });
      await rm(`${path}.pending.json`, { force: true });
      const prefix = `${basename(path)}.claimed.`;
      for (const name of await readdir(dirname(path)).catch(() => [] as string[])) {
        if (name.startsWith(prefix)) await rm(join(dirname(path), name), { force: true });
      }
    }],
    ['tombstone', async () => {
      const tombstone: RunState = { repo, pr_number: number, run_id: '', current_head_sha: '',
        phase: 'closed', repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false,
        active: false, pid: process.pid, handled_comment_ids: [],
        closed_at: new Date().toISOString(), closed_through_comment_id: closedThrough,
        close_start_notice_id: journal.start_notice_id ?? undefined, close_comment_id: journal.close_comment_id,
        close_mentions: input.mentions,
        completion_notice_status: 'pending' };
      await writeState(path, tombstone);
    }],
  ];
  for (const [step, run] of steps) {
    try { await run(); journal.last_step = step; journal.last_error = null; await saveJournal(path, journal); }
    catch (error) {
      // G. Resources already deleted stay deleted; the journal records where cleanup stopped.
      journal.last_step = step; journal.last_error = (error as Error).message;
      await saveJournal(path, journal);
      try { await enqueueAndDeliverComment({ root: config.root, repo, prNumber: number, purpose: 'close_failure',
        semanticKey: `close-failure:${journal.close_comment_id}:${step}`, body: closeFailedBody(step), mentions: input.mentions,
        botLogin: input.bot_login, source: { close_comment_id: journal.close_comment_id, step } }, { client: input.client, botLogin: input.bot_login }); } catch { /* durable item remains */ }
      return { status: 'close_incomplete', step };
    }
  }

  // F. Deterministic completion comment after the tombstone is durable. If it cannot be
  // published, the local close remains CLOSED with a pending notice for a later retry.
  try {
    const result = await enqueueAndDeliverComment({ root: config.root, repo, prNumber: number, purpose: 'close_completion',
      semanticKey: `close-completion:${journal.close_comment_id}`, body: closeCompleteBody, mentions: input.mentions,
      botLogin: input.bot_login, source: { close_comment_id: journal.close_comment_id } }, { client: input.client, botLogin: input.bot_login });
    if (result.item.status !== 'delivered') {
      journal.status = 'completed'; journal.last_step = 'completion_notice_pending'; await saveJournal(path, journal);
      return { status: 'closed', completion_notice_status: 'pending', run_ids: journal.run_ids.length };
    }
    const publication = { id: result.item.receipt?.id!, html_url: result.item.receipt?.html_url! };
    const tombstone = await readState(path);
    await writeState(path, { ...tombstone!, completion_notice_status: 'published', completion_notice_id: publication.id });
    journal.status = 'completed'; journal.last_step = 'completed'; await saveJournal(path, journal);
    return { status: 'closed', start_notice_id: journal.start_notice_id, completion_notice_id: publication.id, run_ids: journal.run_ids.length };
  } catch {
    journal.status = 'completed'; journal.last_step = 'completion_notice_pending'; await saveJournal(path, journal);
    return { status: 'closed', completion_notice_status: 'pending', run_ids: journal.run_ids.length };
  }
}

// Durable completion-notice retry: once local cleanup succeeded, the PR stays CLOSED forever and
// no deleted data is ever restored. A later PatchPaw entry retries the missing "本地会话已清除"
// notice BEFORE starting a new generation or recovery, never re-publishes the start notice, and
// flips the durable marker to published on success. Failure keeps the pending marker for the
// next entry; it never blocks the new generation.
export async function retryPendingCloseCompletion(path: string, repo: string, number: number, clientOrFactory: Octokit | (() => Promise<Octokit>),
  root = dirname(dirname(dirname(path))), botLogin?: string) {
  const state = await readState(path);
  if (state?.completion_notice_status !== 'pending') return false;
  try {
    // The exact completion payload is durable before resolving an installation client. This
    // keeps a transient connection failure from losing the only owed close notice.
    const stored = await enqueueCommentDelivery({ root, repo, prNumber: number, purpose: 'close_completion',
      semanticKey: `close-completion:${state.close_comment_id ?? state.closed_through_comment_id ?? 'unknown'}`, body: closeCompleteBody,
      mentions: state.close_mentions ?? [], botLogin, source: { close_comment_id: state.close_comment_id ?? state.closed_through_comment_id ?? null } });
    const client = typeof clientOrFactory === 'function' ? await clientOrFactory() : clientOrFactory;
    const result = await deliverImmediately(root, stored, { client, botLogin });
    if (result.item.status !== 'delivered') return false;
    await writeState(path, { ...state, completion_notice_status: 'published', completion_notice_id: result.item.receipt?.id });
    return true;
  } catch { return false; }
}

// Crash-recovery window: a journal left in `closing` means destructive steps may already have
// run (workspace/memory/runs/snapshots/inbox deleted) while the tombstone was never written and
// the original /close comment may be gone with the inbox. Any later PatchPaw entry must finish
// this close mechanically BEFORE recovery, run allocation, model or workspace work.
export async function hasPendingClose(path: string) {
  return (await readJournal(path))?.status === 'closing';
}
export async function resumePendingClose(config: { root: string; snapshotRoot: string; legacyHome?: string }, repo: string, number: number, path: string, client: Octokit, botLogin?: string) {
  const journal = await readJournal(path);
  if (!journal || journal.status !== 'closing') return undefined;
  return runClose(config, repo, number, path, { comment_id: journal.close_comment_id, client, mentions: journal.mentions, bot_login: botLogin });
}
