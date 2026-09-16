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
