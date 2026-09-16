import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { TraceReadBatch } from './types.ts';
import { TraceReader } from './trace-reader.ts';

export interface TraceFollowOptions {
  reader: TraceReader;
  resultPath: string;
  signal?: AbortSignal;
  pollMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  isComplete?: () => Promise<boolean>;
}

async function resultExists(path: string) {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function waitFor(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Follow a trace using local file reads; it never executes tail or controls the worker. */
export async function* followTrace(options: TraceFollowOptions): AsyncGenerator<TraceReadBatch> {
  const isComplete = options.isComplete ?? (() => resultExists(options.resultPath));
  const wait = options.wait ?? waitFor;
  const pollMs = options.pollMs ?? 250;
  while (!options.signal?.aborted) {
    const batch = await options.reader.readAvailable();
    if (batch.records.length || batch.malformed.length) yield batch;
    if (await isComplete()) return;
    await wait(pollMs, options.signal);
  }
}
