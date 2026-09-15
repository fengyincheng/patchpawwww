import { git, command, gitAuth } from './git.ts';
import type { Trace } from '../harness/trace.ts';
import { bounded } from '../harness/trace.ts';
import { captureVerificationInputs, changedVerificationInputs, type VerificationInputs } from './verification-inputs.ts';
import { hostShell } from '../platform/shell.ts';
import { workspaceCommandEnvironment } from '../platform/command-environment.ts';

export interface WorkspaceState { path: string; initialHead: string; mainSha: string; unmerged: string[]; mergePending: boolean; verificationInputs?: VerificationInputs }
// The workspace already exists as a worktree of the shared repo (repo-store.createWorktree)
// detached at headSha, with the exact head and current base ref fetched (repo-store.fetchPRState).
// Preparation here is purely local merge/index state — no clone, no network, no credentials.
export async function prepareWorkspace(input: { path: string; headSha: string; baseRef: string; mergeBase?: boolean }, trace: Trace): Promise<WorkspaceState> {
  const head = (await git(input.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
  if (head !== input.headSha) throw new Error('Workspace HEAD does not match the requested PR head');
  const mainSha = (await git(input.path, ['rev-parse', `origin/${input.baseRef}`], trace)).stdout.trim();
  const merge = input.mergeBase === false ? { exitCode: 0 } : await git(input.path, ['merge', '--no-commit', '--no-ff', mainSha], trace, undefined, true);
  const unmerged = (await git(input.path, ['diff', '--name-only', '--diff-filter=U'], trace)).stdout.trim().split('\n').filter(Boolean);
  if (merge.exitCode !== 0 && !unmerged.length) throw new Error('Merge failed without content conflicts');
  const mergePending = (await git(input.path, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true)).exitCode === 0;
  return { path: input.path, initialHead: input.headSha, mainSha, unmerged, mergePending,
    verificationInputs: await captureVerificationInputs(input.path, trace) };
}
export async function workspaceChangesSince(ws: WorkspaceState, startHead: string, trace: Trace) {
  const head = (await git(ws.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
  const dirty = !!(await git(ws.path, ['status', '--porcelain'], trace)).stdout.trim();
  const mergePending = (await git(ws.path, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true)).exitCode === 0;
  return { start_head: startHead, head, dirty, merge_pending: mergePending,
    has_changes: head !== startHead || dirty || mergePending };
}

export async function validateWorkspace(ws: WorkspaceState, tests: string[], trace: Trace, startHead?: string, signal?: AbortSignal) {
  const validation = [];
  const shell = hostShell();
  const commandEnv = workspaceCommandEnvironment();
  for (const test of tests) {
    const result = await command(ws.path, shell.executable, shell.args(test), commandEnv, undefined, signal);
    // The validation artifact keeps full command output; the trace event stays bounded.
    const stdout = bounded(result.stdout), stderr = bounded(result.stderr);
    trace.emit('validation', { command: test, exitCode: result.exitCode, timedOut: result.timedOut,
      stdout_chars: stdout.chars, stdout: stdout.excerpt, stderr_chars: stderr.chars, stderr: stderr.excerpt });
    validation.push({ command: test, ...result });
  }
  const changedInputs = ws.verificationInputs ? await changedVerificationInputs(ws.path, ws.verificationInputs) : [];
  // Validate the actual state after tests too: validation commands may alter files.
  const unmerged = await git(ws.path, ['ls-files', '-u'], trace);
  const unstaged = await git(ws.path, ['diff', '--check'], trace, undefined, true);
  const staged = await git(ws.path, ['diff', '--cached', '--check'], trace, undefined, true);
  const changes = startHead ? await workspaceChangesSince(ws, startHead, trace) : null;
  // Check the full candidate, including committed edits AND subsequent working-tree corrections.
  const candidate = startHead ? await git(ws.path, ['diff', '--check', startHead], trace, undefined, true) : null;
  const checks = [unstaged, staged, candidate].filter(check => check !== null);
  if (checks.some(check => check.timedOut || check.exitCode > 2)) throw new Error('Harness diff-check execution failed');
  const warnings = [...new Set(checks.filter(check => check.exitCode !== 0).map(check => check.stdout.split('\n')
    .filter(line => !/: leftover conflict marker$/.test(line) && !/^\+[<=>]{7}/.test(line)).join('\n').trim()).filter(Boolean))];
  // git diff --check also detects added conflict markers: those remain a real conflict,
  // unlike whitespace formatting warnings. The unmerged index alone misses staged markers.
  const conflictMarkers = checks.flatMap(check => check.stdout.split('\n').filter(line => /: leftover conflict marker$/.test(line)));
  const failures = [
    ...validation.filter(t => t.exitCode !== 0 || t.timedOut).map(t => `测试失败：${t.command}（exit ${t.exitCode}${t.timedOut ? '，超时' : ''}）`),
    ...(unmerged.stdout.trim() ? ['Git index 仍有未解决冲突'] : []),
    ...conflictMarkers,
  ];
  return { ok: changes?.has_changes !== false && !failures.length,
    unmerged: unmerged.stdout, unstaged, staged, candidate, validation, warnings, failures,
    verification_input_changes: changedInputs,
    repair_changes: changes, reason: changes?.has_changes === false ? 'No changes since this repair started; cannot declare repaired. Explain why no repair is needed or request human help.' : null };
}
export async function commitRepair(ws: WorkspaceState, kind: string, trace: Trace, startHead: string) {
  await git(ws.path, ['add', '-A'], trace);
  const changes = await workspaceChangesSince(ws, startHead, trace);
  if (!changes.has_changes) throw new Error('No changes since this repair started; refusing a no-op repair');
  const needsCommit = changes.dirty || changes.merge_pending;
  if (needsCommit) await git(ws.path, ['commit', '-m', `fix: PatchPaw ${kind} repair`], trace);
  const sha = (await git(ws.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
  const status = (await git(ws.path, ['status', '--porcelain'], trace)).stdout;
  const merge = await git(ws.path, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true);
  if (status.trim() || merge.exitCode === 0) throw new Error('Repair commit did not leave a clean resolved workspace');
  trace.emit('repair_commit', { kind, sha, start_head: startHead, source: needsCommit ? 'harness' : 'agent' });
  return sha;
}
export async function pushRepair(ws: WorkspaceState, branch: string, token: string, trace: Trace) {
  return git(ws.path, ['push', 'origin', `HEAD:refs/heads/${branch}`], trace, gitAuth(token));
}
export async function includesBase(ws: WorkspaceState, trace: Trace) {
  return (await git(ws.path, ['merge-base', '--is-ancestor', ws.mainSha, 'HEAD'], trace, undefined, true)).exitCode === 0;
}
