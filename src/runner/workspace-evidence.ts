import { lstat, readFile, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { git } from '../workspace/git.ts';
import type { Trace } from '../harness/trace.ts';
import { readArtifact } from './review-lifecycle.ts';
import { canonicalJson } from '../control-plane/snapshots.ts';

// Hash only Git-visible files; never follow symlinks or persist file contents.
async function snapshot(workspace: string) {
  const paths = (await git(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean);
  const files: Record<string, string> = Object.create(null);
  for (const path of new Set(paths)) {
    try {
      const file = join(workspace, path), stat = await lstat(file);
      if (stat.isDirectory()) continue; // Submodule contents are outside this worktree.
      if (!stat.isFile() && !stat.isSymbolicLink()) { files[path] = `special:${stat.mode}`; continue; }
      const content = stat.isSymbolicLink() ? await readlink(file) : await readFile(file);
      files[path] = `${stat.mode & 0o777}:${createHash('sha256').update(content).digest('hex')}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return files;
}

export interface ConflictWorkspaceEvidenceInput {
  repository: string;
  prNumber: number;
  prHeadSha: string;
  historicalBaseSha: string;
  currentBaseTipSha: string;
  baseRef: string;
  runId: string;
  executionId: string;
  commandSnapshotId: string;
  commandSnapshotSha256: string;
}

export interface ConflictWorkspaceEvidence {
  schema_version: 'patchpaw.workspace-evidence.v1';
  repository: string;
  pr_number: number;
  pr_head_sha: string;
  historical_base_sha: string;
  current_base_tip_sha: string;
  base_ref: string;
  run_id: string;
  execution_id: string;
  command_snapshot_id: string;
  command_snapshot_sha256: string;
  workspace_head: string;
  initial_head: string;
  merge_base: string;
  git_status_porcelain_v2: string;
  git_index: string;
  git_unmerged_index: string;
  merge_head: string | null;
  merge_pending: boolean;
  unresolved_paths: string[];
  pr_diff_paths: string[];
  current_base_affected_paths: string[];
  files: Record<string, string>;
  captured_at: string;
}

export type StoredConflictWorkspaceEvidence = ConflictWorkspaceEvidence & { evidence_sha256?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/** Validate the persisted evidence envelope before approval logic relies on it. */
export function parseStoredConflictWorkspaceEvidence(value: unknown): StoredConflictWorkspaceEvidence | null {
  if (!isRecord(value) || value.schema_version !== 'patchpaw.workspace-evidence.v1') return null;
  const prNumber = value.pr_number;
  const filesValue = value.files;
  if (typeof value.repository !== 'string' || typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber)
      || typeof value.pr_head_sha !== 'string' || typeof value.historical_base_sha !== 'string'
      || typeof value.current_base_tip_sha !== 'string' || typeof value.base_ref !== 'string'
      || typeof value.run_id !== 'string' || typeof value.execution_id !== 'string'
      || typeof value.command_snapshot_id !== 'string' || typeof value.command_snapshot_sha256 !== 'string'
      || typeof value.workspace_head !== 'string' || typeof value.initial_head !== 'string'
      || typeof value.merge_base !== 'string' || typeof value.git_status_porcelain_v2 !== 'string'
      || typeof value.git_index !== 'string' || typeof value.git_unmerged_index !== 'string'
      || (value.merge_head !== null && typeof value.merge_head !== 'string')
      || typeof value.merge_pending !== 'boolean' || !stringArray(value.unresolved_paths)
      || !stringArray(value.pr_diff_paths) || !stringArray(value.current_base_affected_paths)
      || !isRecord(filesValue) || !Object.values(filesValue).every(entry => typeof entry === 'string')
      || typeof value.captured_at !== 'string'
      || (value.evidence_sha256 !== undefined && typeof value.evidence_sha256 !== 'string')) return null;
  const files: Record<string, string> = {};
  for (const [path, digest] of Object.entries(filesValue)) {
    if (typeof digest !== 'string') return null;
    files[path] = digest;
  }
  return {
    schema_version: 'patchpaw.workspace-evidence.v1', repository: value.repository, pr_number: prNumber,
    pr_head_sha: value.pr_head_sha, historical_base_sha: value.historical_base_sha, current_base_tip_sha: value.current_base_tip_sha,
    base_ref: value.base_ref, run_id: value.run_id, execution_id: value.execution_id,
    command_snapshot_id: value.command_snapshot_id, command_snapshot_sha256: value.command_snapshot_sha256,
    workspace_head: value.workspace_head, initial_head: value.initial_head, merge_base: value.merge_base,
    git_status_porcelain_v2: value.git_status_porcelain_v2, git_index: value.git_index, git_unmerged_index: value.git_unmerged_index,
    merge_head: value.merge_head, merge_pending: value.merge_pending, unresolved_paths: value.unresolved_paths,
    pr_diff_paths: value.pr_diff_paths, current_base_affected_paths: value.current_base_affected_paths, files,
    captured_at: value.captured_at, ...(value.evidence_sha256 ? { evidence_sha256: value.evidence_sha256 } : {}),
  };
}

function lines(value: string) { return value.split('\0').filter(Boolean).length ? value.split('\0').filter(Boolean) : value.trim().split('\n').filter(Boolean); }

export function workspaceEvidenceSha256(evidence: ConflictWorkspaceEvidence) {
  return createHash('sha256').update(canonicalJson(evidence), 'utf8').digest('hex');
}

/**
 * Compare the retained checkout with the last durable evidence before a read-only discussion.
 * Run/execution timestamps and the newly captured evidence hash are intentionally excluded: the
 * safety question is whether the checkout's Git/index/content facts changed underneath us.
 */
export function compareConflictWorkspaceEvidence(previous: ConflictWorkspaceEvidence, current: ConflictWorkspaceEvidence) {
  const fields: (keyof ConflictWorkspaceEvidence)[] = [
    'workspace_head', 'initial_head', 'merge_base', 'git_status_porcelain_v2', 'git_index',
    'git_unmerged_index', 'merge_head', 'merge_pending', 'unresolved_paths', 'pr_diff_paths',
    'current_base_affected_paths', 'files',
  ];
  for (const field of fields) {
    if (canonicalJson(previous[field]) !== canonicalJson(current[field])) return { ok: false as const, reason: `workspace_${field}_changed` };
  }
  return { ok: true as const };
}

export async function captureConflictWorkspaceEvidence(workspace: string, input: ConflictWorkspaceEvidenceInput, trace: Trace, artifactName = 'workspace-evidence.json') {
  const [workspaceHead, mergeBase, status, index, unmerged, mergeHead, prDiff, baseDiff, files] = await Promise.all([
    git(workspace, ['rev-parse', 'HEAD'], trace),
    git(workspace, ['merge-base', input.currentBaseTipSha, 'HEAD'], trace),
    git(workspace, ['status', '--porcelain=v2', '--untracked-files=all'], trace),
    git(workspace, ['ls-files', '-s'], trace),
    git(workspace, ['ls-files', '-u'], trace),
    git(workspace, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true),
    git(workspace, ['diff', '--name-only', `${input.currentBaseTipSha}...HEAD`, '-z'], trace),
    git(workspace, ['diff', '--name-only', `${input.historicalBaseSha}..${input.currentBaseTipSha}`, '-z'], trace, undefined, true),
    snapshot(workspace),
  ]);
  const unresolved = lines(unmerged.stdout);
  const evidence: ConflictWorkspaceEvidence = {
    schema_version: 'patchpaw.workspace-evidence.v1', repository: input.repository, pr_number: input.prNumber,
    pr_head_sha: input.prHeadSha, historical_base_sha: input.historicalBaseSha, current_base_tip_sha: input.currentBaseTipSha,
    base_ref: input.baseRef, run_id: input.runId, execution_id: input.executionId,
    command_snapshot_id: input.commandSnapshotId, command_snapshot_sha256: input.commandSnapshotSha256,
    workspace_head: workspaceHead.stdout.trim(), initial_head: input.prHeadSha, merge_base: mergeBase.stdout.trim(),
    git_status_porcelain_v2: status.stdout, git_index: index.stdout, git_unmerged_index: unmerged.stdout,
    merge_head: mergeHead.exitCode === 0 ? mergeHead.stdout.trim() : null, merge_pending: mergeHead.exitCode === 0,
    unresolved_paths: unresolved, pr_diff_paths: lines(prDiff.stdout), current_base_affected_paths: lines(baseDiff.stdout),
    files, captured_at: new Date().toISOString(),
  };
  const hash = workspaceEvidenceSha256(evidence);
  trace.save(artifactName, { ...evidence, evidence_sha256: hash });
  trace.emit('workspace_evidence_captured', { evidence_sha256: hash, unresolved_paths: unresolved, merge_pending: evidence.merge_pending });
  return { evidence, evidenceSha256: hash };
}

export async function captureExecutionBaseline(workspace: string, trace: Trace, conflict?: ConflictWorkspaceEvidenceInput) {
  const files = await snapshot(workspace);
  trace.save('workspace-baseline.json', { execution_id: trace.executionId, files,
    status: (await git(workspace, ['status', '--short'])).stdout });
  return conflict ? captureConflictWorkspaceEvidence(workspace, conflict, trace) : undefined;
}
export async function executionChanges(workspace: string, dir: string) {
  const baseline = await readArtifact(dir, 'workspace-baseline.json');
  if (!baseline) return 'Agent 本轮主动修改：未知（本轮没有文件基线，不能将合并差异归于 Agent）。';
  const current = await snapshot(workspace);
  const changed = [...new Set([...Object.keys(baseline.files), ...Object.keys(current)])]
    .filter(path => baseline.files[path] !== current[path]);
  return `Agent 本轮主动修改：${changed.length} 个文件（按执行开始后的文件净变化统计，含命令或测试产生的变化，不含已撤销修改）。`
    + (changed.length ? `\n${changed.slice(0, 30).map(path => `- ${JSON.stringify(path)}`).join('\n')}` : '');
}
