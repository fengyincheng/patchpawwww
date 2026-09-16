import { resolveRun, RunResolutionError } from '../src/observability/run-resolver.ts';
import { parseTargetCommandArgs, TARGET_COMMAND_HELP } from '../src/observability/cli-options.ts';
import { readNormalizedTrace, normalizeTraceBatch, readRunResult, readStateForRun } from '../src/observability/run-reader.ts';
import { followTrace } from '../src/observability/trace-follow.ts';
import { DETACHED_MESSAGE, renderMalformed, renderObservableEvent, renderObserverHeader, renderSummary, type RenderMode } from '../src/observability/renderer.ts';
import { summarizeRun } from '../src/observability/run-summary.ts';
import { workerStatus } from '../src/runner/state.ts';

function write(value: string) { process.stdout.write(value + '\n'); }

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function resolveWithWait(target: Parameters<typeof resolveRun>[0], signal: AbortSignal) {
  let announced = false;
  while (!signal.aborted) {
    try { return await resolveRun(target); }
    catch (error) {
      if (!(error instanceof RunResolutionError) || error.code !== 'run_not_found' || !target.repo) throw error;
      if (!announced) { write('No active local run. Waiting for the next PatchPaw run...'); announced = true; }
      await wait(500, signal);
    }
  }
  return null;
}

function renderEvent(event: Parameters<typeof renderObservableEvent>[0], mode: RenderMode) { write(renderObservableEvent(event, mode)); }

async function main() {
  const options = parseTargetCommandArgs(process.argv.slice(2), 'agent:open');
  if (options.help) { write(TARGET_COMMAND_HELP); return; }
  const controller = new AbortController();
  let detached = false;
  const onSignal = () => { detached = true; controller.abort(); };
  process.once('SIGINT', onSignal);
  try {
    const run = options.wait ? await resolveWithWait(options.target, controller.signal) : await resolveRun(options.target);
    if (!run) { if (detached) write(DETACHED_MESSAGE); return; }
    const initial = await readNormalizedTrace(run);
    const allEvents = [...initial.events];
    if (options.mode !== 'json') write(renderObserverHeader(run.runId, options.mode));
    const replay = options.replay === 'all' ? initial.events : options.replay === 0 ? [] : initial.events.slice(-options.replay);
    for (const event of replay) renderEvent(event, options.mode);
    for (const malformed of initial.malformed) write(renderMalformed(malformed.line, malformed.message, malformed.excerpt, options.mode));
    let result = await readRunResult(run);
    let state = await readStateForRun(run.runtimeHome, run.runId) ?? run.state;
    const interrupted = state?.active && workerStatus(state) === 'interrupted';
    if (!result && !interrupted && state?.active !== false && !controller.signal.aborted) {
      for await (const batch of followTrace({ reader: initial.reader, resultPath: run.resultPath, signal: controller.signal,
        isComplete: async () => {
          if (await readRunResult(run)) return true;
          const current = await readStateForRun(run.runtimeHome, run.runId);
          return current?.active === false || !!(current?.active && workerStatus(current) === 'interrupted');
        } })) {
        const normalized = normalizeTraceBatch(run.runId, batch);
        allEvents.push(...normalized.events);
        for (const event of normalized.events) renderEvent(event, options.mode);
        for (const malformed of normalized.malformed) write(renderMalformed(malformed.line, malformed.message, malformed.excerpt, options.mode));
      }
      result = await readRunResult(run);
      state = await readStateForRun(run.runtimeHome, run.runId) ?? state;
    }
    if (detached) { write(DETACHED_MESSAGE); return; }
    if (result || state?.active === false || !!(state?.active && workerStatus(state) === 'interrupted')) {
      const summary = summarizeRun({ runId: run.runId, manifest: run.manifest, result, state, events: allEvents });
      if (options.mode !== 'json') write('');
      write(renderSummary(summary, options.mode));
    }
  } finally { process.removeListener('SIGINT', onSignal); }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
