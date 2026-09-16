import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredRuntimeHome, patchpawPaths } from '../config/paths.ts';
import { readState, statePath, workerStatus, type RunState } from '../runner/state.ts';
import { readStateForRun } from './run-reader.ts';

export type RunManifest = Record<string, unknown>;
export type RunResult = Record<string, unknown>;

export interface ResolvedRun {
  runId: string;
  runtimeHome: string;
  dir: string;
  tracePath: string;
  resultPath: string;
  manifestPath: string;
  manifest: RunManifest;
  result: RunResult | null;
  state: RunState | null;
  worker: ReturnType<typeof workerStatus> | 'unknown';
  source: 'run' | 'state' | 'scan';
}

export interface RunTarget {
  runId?: string;
  repo?: string;
  changeNumber?: number;
  runtimeHome?: string;
}

export interface ListedRun {
  runId?: string;
  manifest?: RunManifest;
  result?: RunResult | null;
  manifestPath: string;
  error?: string;
  startedAt?: string;
}

export class RunResolutionError extends Error {
  constructor(readonly code: 'invalid_run_id' | 'invalid_target' | 'run_not_found' | 'manifest_mismatch', message: string) {
    super(message);
    this.name = 'RunResolutionError';
  }
}

export function isSafeRunId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readObject(path: string, optional: boolean) {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const value = object(parsed);
    if (!value) throw new Error('JSON artifact is not an object');
    return value;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function manifestMatches(manifest: RunManifest, repo: string, number: number) {
  const names = [manifest.repo, manifest.repository, manifest.repository_path, manifest.path_with_namespace, manifest.full_name]
    .filter((value): value is string => typeof value === 'string');
  return names.includes(repo) && Number(manifest.pr_number) === number;
}

function stateMatches(state: RunState | null, repo: string, number: number) {
  return state?.repo === repo && Number(state.pr_number) === number;
}

async function loadResolvedRun(runtimeHome: string, runId: string, state: RunState | null, source: ResolvedRun['source'], expected?: { repo: string; changeNumber: number }): Promise<ResolvedRun> {
  if (!isSafeRunId(runId)) throw new RunResolutionError('invalid_run_id', `Unsafe run id: ${runId}`);
  const dir = join(patchpawPaths(runtimeHome).runs, runId);
  const manifestPath = join(dir, 'manifest.json');
  let manifest: RunManifest | null;
  try { manifest = await readObject(manifestPath, false); }
  catch { throw new RunResolutionError('manifest_mismatch', `Run manifest is unreadable for ${runId}.`); }
  if (!manifest) throw new RunResolutionError('manifest_mismatch', `Run manifest is missing for ${runId}.`);
  if (manifest.run_id !== runId) throw new RunResolutionError('manifest_mismatch', `Run manifest does not identify ${runId}.`);
  if (expected && !manifestMatches(manifest, expected.repo, expected.changeNumber)) {
    throw new RunResolutionError('manifest_mismatch', `Run ${runId} does not match ${expected.repo}#${expected.changeNumber}.`);
  }
  const result = await readObject(join(dir, 'result.json'), true);
  return { runId, runtimeHome, dir, tracePath: join(dir, 'trace.jsonl'), resultPath: join(dir, 'result.json'), manifestPath,
    manifest, result, state, worker: state ? workerStatus(state) : result ? 'idle' : 'unknown', source };
}

function targetValid(repo: string, changeNumber: number) {
  return /^(?:gitlab:[A-Za-z0-9][A-Za-z0-9_.:-]*:project:[^/]+|[\w.-]+(?:\/[\w.-]+)+)$/.test(repo)
    && !repo.split('/').some(part => part === '.' || part === '..')
    && Number.isSafeInteger(changeNumber) && changeNumber > 0;
}

export async function listRunManifests(runtimeHome?: string): Promise<ListedRun[]> {
  const runs = patchpawPaths(configuredRuntimeHome(runtimeHome)).runs;
  let entries;
  try { entries = await readdir(runs, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const listed: ListedRun[] = [];
  for (const entry of entries.filter(value => value.isDirectory())) {
    const manifestPath = join(runs, entry.name, 'manifest.json');
    try {
      const manifest = await readObject(manifestPath, false);
      if (!manifest) throw new Error('Run manifest is missing');
      if (manifest.run_id !== entry.name) throw new Error('Run manifest id does not match its directory');
      const result = await readObject(join(runs, entry.name, 'result.json'), true);
      listed.push({ runId: entry.name, manifest, result, manifestPath,
        startedAt: typeof manifest.started_at === 'string' ? manifest.started_at : undefined });
    } catch (error) {
      listed.push({ manifestPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return listed.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')));
}

export async function resolveRun(target: RunTarget): Promise<ResolvedRun> {
  const runtimeHome = configuredRuntimeHome(target.runtimeHome);
  const paths = patchpawPaths(runtimeHome);
  if (target.runId !== undefined) return loadResolvedRun(paths.home, target.runId, await readStateForRun(paths.home, target.runId), 'run');
  if (target.repo === undefined || target.changeNumber === undefined || !targetValid(target.repo, target.changeNumber)) {
    throw new RunResolutionError('invalid_target', 'Expected --run <run-id> or <repo> <positive PR/MR number>.');
  }
  const stateFile = statePath(paths.state, target.repo, target.changeNumber);
  let state: RunState | null = null;
  try { state = await readState(stateFile); }
  catch { /* A corrupt shortcut state is recoverable by scanning manifests below. */ }
  if (!stateMatches(state, target.repo, target.changeNumber)) state = null;
  if (typeof state?.run_id === 'string' && state.run_id) {
    try { return await loadResolvedRun(paths.home, state.run_id, state, 'state', { repo: target.repo, changeNumber: target.changeNumber }); }
    catch (error) {
      if (!(error instanceof RunResolutionError) || !['manifest_mismatch', 'invalid_run_id'].includes(error.code)) throw error;
    }
  }
  const listed = await listRunManifests(paths.home);
  const match = listed.find(item => item.manifest && !item.error && manifestMatches(item.manifest, target.repo!, target.changeNumber!));
  if (!match?.runId) throw new RunResolutionError('run_not_found', `No local Run matches ${target.repo}#${target.changeNumber}.`);
  const matchedState = state?.run_id === match.runId ? state : await readStateForRun(paths.home, match.runId);
  return loadResolvedRun(paths.home, match.runId, matchedState, 'scan', { repo: target.repo, changeNumber: target.changeNumber });
}
