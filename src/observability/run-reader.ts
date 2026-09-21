import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedRun } from './run-resolver.ts';
import { normalizeObservableEvent } from './normalize.ts';
import { TraceReader } from './trace-reader.ts';
import type { ObservableEvent, TraceMalformedLine } from './types.ts';
import { readState, type RunState } from '../runner/state.ts';
import { patchpawPaths } from '../config/paths.ts';

export interface NormalizedTrace {
  events: ObservableEvent[];
  malformed: TraceMalformedLine[];
  reader: TraceReader;
}

function normalizeRecords(runId: string, records: unknown[]) {
  return records.flatMap(record => {
    const event = normalizeObservableEvent(record, runId);
    return event ? [event] : [];
  });
}

export async function readNormalizedTrace(run: Pick<ResolvedRun, 'runId' | 'tracePath'>): Promise<NormalizedTrace> {
  const reader = new TraceReader(run.tracePath);
  const batch = await reader.readAvailable();
  return { events: normalizeRecords(run.runId, batch.records), malformed: batch.malformed, reader };
}

export function normalizeTraceBatch(runId: string, batch: Awaited<ReturnType<TraceReader['readAvailable']>>) {
  return { events: normalizeRecords(runId, batch.records), malformed: batch.malformed };
}

export async function readRunResult(run: Pick<ResolvedRun, 'resultPath'>) {
  try {
    const parsed: unknown = JSON.parse(await readFile(run.resultPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface RunArtifact {
  name: string;
  /** absent: the run never wrote it; corrupt: it exists but is unreadable. */
  state: 'present' | 'absent' | 'corrupt';
  value: Record<string, unknown> | null;
  error?: string;
}

export async function readRunArtifact(dir: string, name: string): Promise<RunArtifact> {
  let raw: string;
  try { raw = await readFile(join(dir, name), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name, state: 'absent', value: null };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('artifact is not a JSON object');
    return { name, state: 'present', value: parsed as Record<string, unknown> };
  } catch (error) {
    return { name, state: 'corrupt', value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CommandFacts {
  permission?: string;
  executionType?: string;
  templateType?: string;
  slashName?: string;
  snapshotSha256?: string;
}

/** The immutable Command Snapshot is authoritative for the permission used by a run. */
export async function readCommandFacts(dir: string): Promise<CommandFacts> {
  const artifact = await readRunArtifact(dir, 'command-snapshot.json');
  const snapshot = artifact.value;
  if (!snapshot) return {};
  const command = snapshot.command && typeof snapshot.command === 'object' && !Array.isArray(snapshot.command)
    ? snapshot.command as Record<string, unknown> : {};
  const value = (input: unknown) => typeof input === 'string' ? input : undefined;
  return {
    permission: value(command.permission),
    executionType: value(command.execution_type),
    templateType: value(snapshot.template_type),
    slashName: value(command.slash_name),
    snapshotSha256: value(snapshot.snapshot_sha256),
  };
}

async function stateFiles(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await stateFiles(path));
    else if (entry.isFile() && /^pr-\d+\.json$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function readStateForRun(runtimeHome: string, runId: string): Promise<RunState | null> {
  const files = await stateFiles(patchpawPaths(runtimeHome).state);
  for (const path of files) {
    try {
      const state = await readState(path);
      if (state?.run_id === runId) return state;
    } catch { /* A corrupt state file must not prevent observing another local run. */ }
  }
  return null;
}
