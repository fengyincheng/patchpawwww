import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git } from './git.ts';
import type { Trace } from '../harness/trace.ts';
import { patchpawPaths } from '../config/paths.ts';
import { withFileLock } from '../platform/lock.ts';

// One GitHub repository = one persistent bare object store under repos; runs get Git
// worktrees, never clones. The cache outlives runs, so it must never live under a run directory.
export function repoCachePath(runtimeHome: string, repo: string) {
  return join(patchpawPaths(runtimeHome).repos, `${encodeURIComponent(repo.toLowerCase())}.git`);
}
export function runWorkspacePath(runtimeHome: string, runId: string) {
  return join(patchpawPaths(runtimeHome).workspaces, runId);
}

const lockTimeoutMs = 600_000;

// Git pathspecs used by read-only evidence tools are repository paths, never host paths.
// Normalize Windows separators for the Git argv while rejecting traversal before a revision:path
// expression is constructed.
export function validateRepoRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Repository path must be relative: ${value}`);
  }
  if (normalized.split('/').includes('..')) throw new Error(`Repository path traversal is not allowed: ${value}`);
  return normalized;
}

// Repo metadata lock: guards operations that mutate the SHARED repository (init, remote
// setup/update, fetch, worktree add/remove/prune). It is held only for metadata operations,
// never during Agent work, so different PR worktrees run concurrently. The portable lock
// reclaims only owner records whose PID is no longer alive.
export async function withRepoLock<T>(cache: string, task: () => Promise<T>): Promise<T> {
  const repoDirectory = dirname(cache);
  await mkdir(repoDirectory, { recursive: true });
  // Keep lock bookkeeping out of the bare repository directory. The portable
  // lock uses a directory sidecar, and placing it beside a cache would make
  // discovery mistake that sidecar for another repository.
  const runtimeHome = dirname(repoDirectory);
  const lockPath = join(runtimeHome, 'locks', 'repos', `${basename(cache)}.lock`);
  return withFileLock(lockPath, 'exclusive', { timeoutMs: lockTimeoutMs, reentrant: false }, task);
}

export async function ensureRepo(root: string, repo: string, cloneUrl: string, trace: Trace) {
  const cache = repoCachePath(root, repo);
  await withRepoLock(cache, async () => {
    const probe = await git(dirname(cache), ['--git-dir', cache, 'rev-parse', '--is-bare-repository'], trace, undefined, true);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
      await git(dirname(cache), ['init', '--bare', cache], trace);
      trace.emit('repo_cache_initialized', { repo, cache, clone_url: cloneUrl });
    }
    // Converge remote and bot identity on EVERY ensure: a crash between the init steps must
    // heal on the next run instead of wedging the cache forever. Recovery never deletes or
    // reclones the shared object store.
    const origin = await git(cache, ['remote', 'get-url', 'origin'], trace, undefined, true);
    if (origin.exitCode !== 0) {
      await git(cache, ['remote', 'add', 'origin', cloneUrl], trace);
      trace.emit('repo_cache_remote_added', { repo, clone_url: cloneUrl });
    } else if (origin.stdout.trim() !== cloneUrl) {
      // Repository transfer/rename: reconcile the URL without recreating anything.
      await git(cache, ['remote', 'set-url', 'origin', cloneUrl], trace);
      trace.emit('repo_cache_remote_updated', { repo, clone_url: cloneUrl });
    }
    await git(cache, ['config', 'user.name', 'patchpawwww[bot]'], trace);
    await git(cache, ['config', 'user.email', 'patchpawwww[bot]@users.noreply.github.com'], trace);
  });
  return cache;
}

// Every run refreshes the shared store before the resume/fresh-workspace decision. No pull,
// no branch checkout: the exact PR head object plus the current target branch tip, forcing the
// remote-tracking ref so a rewound base branch is still reflected. Automatic GC stays off while
// worktrees are active; explicit maintenance is a separate later concern.
export async function fetchPRState(root: string, repo: string, input: { headSha: string; baseRef: string }, trace: Trace, env?: NodeJS.ProcessEnv) {
  const cache = repoCachePath(root, repo);
  return withRepoLock(cache, async () => {
    await git(cache, ['-c', 'gc.auto=0', 'fetch', '--no-tags', 'origin', input.headSha,
      `+refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`], trace, env);
    const currentBaseTipSha = (await git(cache, ['rev-parse', `refs/remotes/origin/${input.baseRef}`], trace)).stdout.trim();
    trace.emit('repo_cache_fetched', { repo, head_sha: input.headSha, base_ref: input.baseRef, current_base_tip_sha: currentBaseTipSha });
    return { baseRef: input.baseRef, currentBaseTipSha };
  });
}

export async function createWorktree(root: string, repo: string, path: string, headSha: string, trace: Trace) {
  const cache = repoCachePath(root, repo);
  await withRepoLock(cache, async () => {
    await mkdir(dirname(path), { recursive: true });
    await git(cache, ['worktree', 'add', '--detach', path, headSha], trace);
    trace.emit('worktree_created', { repo, workspace: path, head_sha: headSha });
  });
}

// Git-aware cleanup: registered worktrees are removed through Git, then metadata is pruned.
// Removal must CONVERGE: if the Git-aware remove fails while the controlled path still exists,
// the directory is removed explicitly and the metadata pruned; a path that still exists at the
// end is an error, never a silent success. Missing paths are tolerated (crash convergence).
// The trace is optional: mechanical lifecycle callers (e.g. /close) journal their own audit facts.
export async function removeWorktree(root: string, repo: string, path: string, trace?: Trace) {
  const cache = repoCachePath(root, repo);
  await withRepoLock(cache, async () => {
    const removed = await git(cache, ['worktree', 'remove', '--force', path], trace, undefined, true);
    if (await stat(path).then(() => true, () => false)) await rm(path, { recursive: true, force: true });
    await git(cache, ['worktree', 'prune'], trace);
    if (await stat(path).then(() => true, () => false)) throw new Error(`Worktree removal did not converge: ${path}`);
    trace?.emit('worktree_removed', { repo, workspace: path, git_removed: removed.exitCode === 0 });
  });
}

// Structural deletion boundary (handoff core invariant: /close and every lifecycle cleanup can
// NEVER touch the shared repository). Disposable paths are exactly:
//   new layout:  <runtimeHome>/workspaces/<workspace-id>          (the workspace root itself)
//   legacy:      <runtimeHome>/runs/<run-id>/workspace             (pre-shared-repo paused clones)
// Everything else — repos/**, data/memory/**, data/state/**, snapshots/**, a run directory
// itself, the runtime home itself, or anything outside — is refused by structured path arithmetic, not by a
// broad prefix match, so a corrupted paused pointer or journal can never aim disposal at them.
export function isDisposableViewspace(runtimeHome: string, workspace: string) {
  if (!isAbsolute(workspace)) return false;
  const target = resolve(workspace);
  const escapes = (rel: string) => rel === '' || rel === '..' || rel.startsWith(`..${sep}`);
  const paths = patchpawPaths(runtimeHome);
  const inWorkspaces = relative(paths.workspaces, target);
  if (!escapes(inWorkspaces) && !inWorkspaces.includes(sep)) return true;
  const inRuns = relative(paths.runs, target);
  if (escapes(inRuns)) return false;
  const parts = inRuns.split(sep);
  return parts.length === 2 && parts[1] === 'workspace';
}

/**
 * Verify that a retained approval workspace is the real, registered linked worktree owned by
 * this repository cache. Lexical path checks alone are insufficient because a path inside
 * workspaces can be replaced by a symlink or an unrelated checkout between runs.
 */
export async function isManagedWorktree(root: string, repo: string, workspace: string, expectedHead?: string, trace?: Trace) {
  if (!isDisposableViewspace(root, workspace)) return false;
  try {
    const target = resolve(workspace);
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const [workspaceRoot, targetReal] = await Promise.all([realpath(patchpawPaths(root).workspaces), realpath(target)]);
    if (targetReal !== target) return false;
    const relativeTarget = relative(workspaceRoot, targetReal);
    if (!relativeTarget || relativeTarget.includes(sep) || relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..') return false;
    const listed = await git(repoCachePath(root, repo), ['worktree', 'list', '--porcelain'], trace, undefined, true);
    if (listed.exitCode !== 0) return false;
    for (const block of listed.stdout.trim().split(/\n\n+/)) {
      const pathLine = block.split('\n').find(line => line.startsWith('worktree '));
      const headLine = block.split('\n').find(line => line.startsWith('HEAD '));
      if (!pathLine || !headLine) continue;
      const listedPath = resolve(pathLine.slice('worktree '.length));
      if (listedPath === targetReal && (!expectedHead || headLine.slice('HEAD '.length).trim() === expectedHead)) return true;
    }
    return false;
  } catch { return false; }
}

// Dispose any PatchPaw-managed workspace path: a linked worktree goes through Git-aware
// removal, a legacy standalone clone or unregistered leftover is removed recursively.
// Enforces the structural workspace boundary and verifies convergence, so callers can never
// claim cleanup while the directory still exists — and never delete the shared repository.
export async function disposeWorkspacePath(root: string, repo: string, workspace: string, trace?: Trace) {
  if (!isDisposableViewspace(root, workspace)) throw new Error(`Refusing to dispose a path outside the workspace boundary: ${workspace}`);
  if (!await stat(workspace).then(() => true, () => false)) return;
  const linked = await stat(join(workspace, '.git')).then(entry => entry.isFile(), () => false);
  if (linked) await removeWorktree(root, repo, workspace, trace);
  else await rm(workspace, { recursive: true, force: true });
  if (await stat(workspace).then(() => true, () => false)) throw new Error(`Workspace disposal did not converge: ${workspace}`);
  trace?.emit('workspace_path_disposed', { repo, workspace, linked });
}
