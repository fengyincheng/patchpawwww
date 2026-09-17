import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TraceReader } from '../src/observability/trace-reader.ts';
import { Trace } from '../src/harness/trace.ts';
import { normalizeObservableEvent } from '../src/observability/normalize.ts';
import { followTrace } from '../src/observability/trace-follow.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import { statePath } from '../src/runner/state.ts';
import { listRunManifests, resolveRun } from '../src/observability/run-resolver.ts';
import { summarizeRun } from '../src/observability/run-summary.ts';
import { renderObservableEvent, renderObserverNotice, renderRunList, renderSummary } from '../src/observability/renderer.ts';
import { parseTargetCommandArgs, parseRunsArgs, TARGET_COMMAND_HELP } from '../src/observability/cli-options.ts';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ObserverProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  get stdout(): string;
  get stderr(): string;
  waitFor(fragment: string): Promise<void>;
  finish(): Promise<{ code: number | null; stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

function startObserver(home: string, args: string[], testContext?: TestContext): ObserverProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-open.ts', ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PATCHPAW_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stop = () => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const done = () => { child.off('close', done); child.off('error', done); resolve(); };
    child.once('close', done);
    child.once('error', done);
    child.kill('SIGKILL');
  });
  const finish = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let timedOut = false;
    const cleanup = () => { clearTimeout(timer); child.off('error', onError); child.off('close', onClose); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = (code: number | null) => {
      cleanup();
      if (timedOut) reject(new Error(`observer did not exit; stdout=${stdout}; stderr=${stderr}`));
      else resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    child.once('error', onError);
    child.once('close', onClose);
  });
  const observer: ObserverProcess = {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitFor(fragment) {
      if (stdout.includes(fragment)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          void stop().then(() => reject(new Error(`observer output did not contain ${fragment}; stdout=${stdout}; stderr=${stderr}`)));
        }, 10_000);
        const check = () => {
          if (!stdout.includes(fragment)) return;
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off('data', check);
          child.off('close', onClose);
        };
        const onClose = () => {
          cleanup();
          reject(new Error(`observer exited before output ${fragment}; stdout=${stdout}; stderr=${stderr}`));
        };
        child.stdout.on('data', check);
        child.once('close', onClose);
        check();
      });
    },
    finish,
    stop,
  };
  if (testContext) testContext.after(() => observer.stop());
  return observer;
}

async function observerHome(testContext: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-cli-'));
  testContext.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function runState(repo: string, changeNumber: number, runId: string, active: boolean) {
  return { repo, pr_number: changeNumber, run_id: runId, current_head_sha: 'head-sha', phase: active ? 'review_running' : 'review_completed',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active, pid: process.pid, execution_id: 1 };
}

async function createCliRun(home: string, runId: string, options: { repo?: string; changeNumber?: number; trace?: string; result?: Record<string, unknown>; active?: boolean }) {
  const repo = options.repo ?? 'owner/repo';
  const changeNumber = options.changeNumber ?? 123;
  const paths = patchpawPaths(home);
  const directory = join(paths.runs, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ run_id: runId, repo, pr_number: changeNumber,
    started_at: '2026-09-17T00:00:00.000Z', task_chain: ['review'], execution_id: 1 }) + '\n');
  await writeFile(join(directory, 'trace.jsonl'), options.trace ?? '');
  if (options.result) await writeFile(join(directory, 'result.json'), JSON.stringify(options.result) + '\n');
  const stateFile = statePath(paths.state, repo, changeNumber);
  await mkdir(join(stateFile, '..'), { recursive: true });
  await writeFile(stateFile, JSON.stringify(runState(repo, changeNumber, runId, options.active ?? false)) + '\n');
  const workspaceMarker = join(paths.workspaces, runId, 'marker.txt');
  await mkdir(join(workspaceMarker, '..'), { recursive: true });
  await writeFile(workspaceMarker, 'observer-fixture');
  return { directory, tracePath: join(directory, 'trace.jsonl'), resultPath: join(directory, 'result.json'), statePath: stateFile, workspaceMarker };
}

async function hashFile(path: string) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function artifactSnapshot(paths: { directory: string; tracePath: string; resultPath: string; statePath: string; workspaceMarker: string }) {
  return JSON.stringify(await Promise.all([join(paths.directory, 'manifest.json'), paths.tracePath, paths.resultPath, paths.statePath, paths.workspaceMarker]
    .map(async path => [path, await hashFile(path)])));
}

test('TraceReader replays complete JSONL and waits for a partial trailing line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-observer-reader-'));
  const path = join(root, 'trace.jsonl');
  await writeFile(path, '{"event":"phase","phase":"inspect"}\n{"event":"tool_start","tool":"read"}\n');
  const reader = new TraceReader(path);

  const first = await reader.readAvailable();
  assert.deepEqual(first.records, [
    { event: 'phase', phase: 'inspect' },
    { event: 'tool_start', tool: 'read' },
  ]);
  assert.equal(first.pending, false);
  assert.ok(first.offset > 0);

  await appendFile(path, '{"event":"tool_end","tool":"read"}');
  const partial = await reader.readAvailable();
  assert.deepEqual(partial.records, []);
  assert.equal(partial.pending, true);
  assert.deepEqual(partial.malformed, []);

  await appendFile(path, '\n');
  const completed = await reader.readAvailable();
  assert.deepEqual(completed.records, [{ event: 'tool_end', tool: 'read' }]);
  assert.equal(completed.pending, false);
});

test('TraceReader reports a malformed complete line without losing neighboring records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-observer-reader-'));
  const path = join(root, 'trace.jsonl');
  await writeFile(path, '{"event":"phase","phase":"inspect"}\nnot-json\n{"event":"phase","phase":"workspace"}\n');
  const batch = await new TraceReader(path).readAvailable();
  assert.deepEqual(batch.records, [
    { event: 'phase', phase: 'inspect' },
    { event: 'phase', phase: 'workspace' },
  ]);
  assert.equal(batch.malformed.length, 1);
  assert.equal(batch.malformed[0]?.line, 2);
  assert.equal(batch.malformed[0]?.excerpt, 'not-json');
});

test('normalization exposes bounded facts and never invents reasoning', () => {
  const event = normalizeObservableEvent({ event: 'tool_end', time: '2026-09-16T00:00:00.000Z', execution_id: 2,
    tool: 'read_file', args: { path: 'README.md' }, output_excerpt: 'ok', duration_ms: 42 }, 'run-1');
  assert.deepEqual(event, { time: '2026-09-16T00:00:00.000Z', runId: 'run-1', executionId: 2, sourceEvent: 'tool_end',
    kind: 'tool', title: 'TOOL RESULT read_file', detail: { tool: 'read_file', args: { path: 'README.md' }, output_excerpt: 'ok', duration_ms: 42 } });
  const model = normalizeObservableEvent({ event: 'model_step', time: '2026-09-16T00:00:00.000Z', task: 'review' }, 'run-1');
  assert.equal(model?.kind, 'model');
  assert.equal(model?.title, 'MODEL STEP');
  assert.equal(normalizeObservableEvent({ event: 'tool_start', prompt: 'private thought' }, 'run-1')?.kind, 'tool');
  assert.equal(normalizeObservableEvent({ event: 'model_step', thinking: null }, 'run-1')?.kind, 'model');
  assert.equal(normalizeObservableEvent({ event: 'model_step', thinking: 'deliberate next step' }, 'run-1')?.kind, 'thinking');
  assert.equal(normalizeObservableEvent({ event: 'validation', command: 'npm test', exitCode: 0 }, 'run-1')?.kind, 'validation');
  assert.equal(normalizeObservableEvent({ event: 'future_event', message: 'new schema' }, 'run-1')?.kind, 'warning');
  assert.equal(normalizeObservableEvent({ event: 'stale_workspace_disposed', workspace: '/tmp/ws' }, 'run-1')?.kind, 'workspace');
});

test('Trace and observer redaction remove registered and named secrets', async () => {
  const trace = new Trace(await mkdtemp(join(tmpdir(), 'patchpaw-observer-redaction-')));
  trace.secret('provider-secret');
  const clean = JSON.parse(trace.clean({ authorization: 'provider-secret', nested: 'ghp_example_token', output: 'safe provider-secret' }));
  assert.deepEqual(clean, { authorization: '[REDACTED]', nested: '[REDACTED]', output: 'safe [REDACTED]' });
  const event = normalizeObservableEvent({ event: 'tool_end', tool: 'x', output_excerpt: 'Bearer abc.def' }, 'run-1');
  assert.equal(event?.detail?.output_excerpt, '[REDACTED]');
  const providerKey = normalizeObservableEvent({ event: 'tool_end', tool: 'x', output_excerpt: 'sk-proj-abcdefghijklmnop' }, 'run-1');
  assert.equal(providerKey?.detail?.output_excerpt, '[REDACTED]');
  assert.equal(JSON.parse(trace.clean({ token: 'opaque-secret', secret: 'opaque-secret' })).token, '[REDACTED]');
  const jsonTypes = JSON.parse(trace.clean({ date: new Date('2026-09-16T00:00:00.000Z'), bytes: Buffer.from('ok') }));
  assert.equal(jsonTypes.date, '2026-09-16T00:00:00.000Z');
  assert.deepEqual(jsonTypes.bytes, { type: 'Buffer', data: [111, 107] });
});

test('followTrace drains appended records and does not emit a partial line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-observer-follow-'));
  const path = join(root, 'trace.jsonl');
  const resultPath = join(root, 'result.json');
  await writeFile(path, '{"event":"phase","phase":"inspect"}\n');
  const reader = new TraceReader(path);
  let waits = 0;
  const batches = [] as Array<{ records: unknown[]; malformed: unknown[] }>;
  for await (const batch of followTrace({ reader, resultPath, isComplete: async () => waits >= 2,
    wait: async () => {
      waits++;
      await appendFile(path, waits === 1 ? '{"event":"tool_start","tool":"read"}' : '\n{"event":"tool_end","tool":"read"}\n');
    } })) batches.push(batch);
  assert.deepEqual(batches.map(batch => batch.records), [
    [{ event: 'phase', phase: 'inspect' }],
    [{ event: 'tool_start', tool: 'read' }, { event: 'tool_end', tool: 'read' }],
  ]);
  assert.equal(waits, 2);
  assert.deepEqual(batches.flatMap(batch => batch.malformed), []);
});

async function writeRun(home: string, runId: string, manifest: Record<string, unknown>, result?: Record<string, unknown>) {
  const dir = join(patchpawPaths(home).runs, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ run_id: runId, ...manifest }) + '\n');
  if (result) await writeFile(join(dir, 'result.json'), JSON.stringify(result) + '\n');
}

test('local resolver trusts exact state/manifest identity instead of the newest unrelated run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-resolver-'));
  await writeRun(home, 'owner-run', { repo: 'owner/repo', pr_number: 7, started_at: '2026-09-16T10:00:00.000Z' }, { status: 'review_completed' });
  await writeRun(home, 'other-run', { repo: 'other/repo', pr_number: 7, started_at: '2026-09-16T11:00:00.000Z' }, { status: 'custom_completed' });
  const state = { repo: 'owner/repo', pr_number: 7, run_id: 'owner-run', current_head_sha: '', phase: 'review_completed',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: false, pid: process.pid };
  const stateFile = statePath(patchpawPaths(home).state, 'owner/repo', 7);
  await mkdir(join(stateFile, '..'), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state) + '\n');

  const resolved = await resolveRun({ runtimeHome: home, repo: 'owner/repo', changeNumber: 7 });
  assert.equal(resolved.runId, 'owner-run');
  assert.equal(resolved.result?.status, 'review_completed');
});

test('local resolver scans exact manifest matches when state is absent and lists corrupt runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-resolver-'));
  await writeRun(home, 'older-match', { repo: 'owner/repo', pr_number: 7, started_at: '2026-09-16T10:00:00.000Z' });
  await writeRun(home, 'newer-match', { repo: 'owner/repo', pr_number: 7, started_at: '2026-09-16T11:00:00.000Z' });
  await writeRun(home, 'unrelated-run', { repo: 'other/repo', pr_number: 7, started_at: '2026-09-16T12:00:00.000Z' });
  const staleStatePath = statePath(patchpawPaths(home).state, 'owner/repo', 7);
  await mkdir(join(staleStatePath, '..'), { recursive: true });
  await writeFile(staleStatePath, JSON.stringify({ repo: 'owner/repo', pr_number: 7, run_id: 'unrelated-run', current_head_sha: '', phase: 'custom',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: -1 }) + '\n');
  const corrupt = join(patchpawPaths(home).runs, 'corrupt-run');
  await mkdir(corrupt, { recursive: true });
  await writeFile(join(corrupt, 'manifest.json'), '{bad json\n');
  const mismatched = join(patchpawPaths(home).runs, 'directory-run');
  await mkdir(mismatched, { recursive: true });
  await writeFile(join(mismatched, 'manifest.json'), JSON.stringify({ run_id: 'other-directory', repo: 'owner/repo', pr_number: 7 }) + '\n');

  const resolved = await resolveRun({ runtimeHome: home, repo: 'owner/repo', changeNumber: 7 });
  assert.equal(resolved.runId, 'newer-match');
  assert.equal(resolved.state, null);
  const listed = await listRunManifests(home);
  assert.equal(listed.some(item => item.error && item.manifestPath.endsWith('corrupt-run/manifest.json')), true);
  assert.equal(listed.some(item => item.error && item.manifestPath.endsWith('directory-run/manifest.json')), true);
});

test('local resolver accepts a canonical GitLab path from a storage-key manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-resolver-'));
  await writeRun(home, 'gitlab-run', { repo: 'gitlab:private:project:42', repository: 'group/sub/project', pr_number: 3 }, { status: 'review_completed' });
  const resolved = await resolveRun({ runtimeHome: home, repo: 'group/sub/project', changeNumber: 3 });
  assert.equal(resolved.runId, 'gitlab-run');
});

test('run resolver rejects unsafe or incomplete targets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-resolver-'));
  await assert.rejects(() => resolveRun({ runtimeHome: home, runId: '../escape' }),
    (error: any) => error?.code === 'invalid_run_id');
  await assert.rejects(() => resolveRun({ repo: 'owner/repo', changeNumber: 0 }),
    (error: any) => error?.code === 'invalid_target');
  await assert.rejects(() => resolveRun({ runtimeHome: home, repo: 'owner/../repo', changeNumber: 7 }),
    (error: any) => error?.code === 'invalid_target');
});

test('resolver falls back from a stale state run to an exact manifest match', async () => {
  const home = await mkdtemp(join(tmpdir(), 'patchpaw-observer-resolver-'));
  await writeRun(home, 'new-match', { repo: 'owner/repo', pr_number: 7, started_at: '2026-09-16T11:00:00.000Z' }, { status: 'review_completed' });
  const stateFile = statePath(patchpawPaths(home).state, 'owner/repo', 7);
  await mkdir(join(stateFile, '..'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ repo: 'owner/repo', pr_number: 7, run_id: 'stale-run', active: false }) + '\n');

  const resolved = await resolveRun({ runtimeHome: home, repo: 'owner/repo', changeNumber: 7 });
  assert.equal(resolved.runId, 'new-match');
  assert.equal(resolved.source, 'scan');
  assert.equal(resolved.result?.status, 'review_completed');
});

test('summary reduces normalized events into activity, counters, and durable result facts', () => {
  const events = [
    normalizeObservableEvent({ event: 'execution_started', time: '2026-09-16T00:00:00.000Z', execution_id: 1 }, 'run-1')!,
    normalizeObservableEvent({ event: 'model_request', time: '2026-09-16T00:00:01.000Z', provider: 'zhipu', model: 'glm', request: 1 }, 'run-1')!,
    normalizeObservableEvent({ event: 'provider_attempt', time: '2026-09-16T00:00:02.000Z', request: 1, attempt: 1 }, 'run-1')!,
    normalizeObservableEvent({ event: 'tool_start', time: '2026-09-16T00:00:03.000Z', index: 4, tool: 'read_file' }, 'run-1')!,
    normalizeObservableEvent({ event: 'tool_end', time: '2026-09-16T00:00:04.000Z', index: 4, tool: 'read_file', exit_code: 0, duration_ms: 1 }, 'run-1')!,
    normalizeObservableEvent({ event: 'provider_retry', time: '2026-09-16T00:00:05.000Z', request: 1, attempt: 2 }, 'run-1')!,
    normalizeObservableEvent({ event: 'repair_commit', time: '2026-09-16T00:00:06.000Z', sha: 'abc1234' }, 'run-1')!,
    normalizeObservableEvent({ event: 'repair_push', time: '2026-09-16T00:00:07.000Z', sha: 'abc1234' }, 'run-1')!,
    normalizeObservableEvent({ event: 'repair_push_confirmed', time: '2026-09-16T00:00:08.000Z', sha: 'abc1234' }, 'run-1')!,
  ];
  const summary = summarizeRun({ runId: 'run-1', manifest: { execution_id: 1, started_at: events[0]!.time, task_chain: ['custom'] },
    result: { status: 'custom_completed' }, events });
  assert.equal(summary.status, 'custom_completed');
  assert.equal(summary.requests, 1);
  assert.equal(summary.attempts, 1);
  assert.equal(summary.retries, 1);
  assert.equal(summary.tools, 1);
  assert.equal(summary.commits, 1);
  assert.equal(summary.pushes, 1);
  assert.equal(summary.remoteConfirmations, 1);
  assert.equal(summary.lastCommit, 'abc1234');
  assert.equal(summary.currentActivity, 'terminal');
});

test('summary exposes an unmatched tool as current activity and an active dead worker as interrupted', () => {
  const event = normalizeObservableEvent({ event: 'tool_start', time: '2026-09-16T00:00:00.000Z', index: 1, tool: 'execute_command' }, 'run-1')!;
  const summary = summarizeRun({ runId: 'run-1', state: { repo: 'owner/repo', pr_number: 7, run_id: 'run-1', current_head_sha: '', phase: 'custom',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: -1 }, events: [event] });
  assert.equal(summary.worker, 'interrupted');
  assert.equal(summary.currentActivity, 'running tool execute_command');
});

test('summary closes numeric provider requests after a response', () => {
  const events = [
    normalizeObservableEvent({ event: 'model_request', request: 1, provider: 'zhipu', model: 'glm' }, 'run-1')!,
    normalizeObservableEvent({ event: 'provider_attempt', request: 1, attempt: 1 }, 'run-1')!,
    normalizeObservableEvent({ event: 'model_response', request: 1, status: 200 }, 'run-1')!,
  ];
  const summary = summarizeRun({ runId: 'run-1', state: { repo: 'owner/repo', pr_number: 7, run_id: 'run-1', current_head_sha: '', phase: 'custom',
    repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid }, events });
  assert.equal(summary.currentActivity, 'MODEL RESPONSE');
});

test('renderer keeps readable details bounded and provides compact/json modes', () => {
  const event = normalizeObservableEvent({ event: 'tool_end', time: '2026-09-16T00:00:00.000Z', tool: 'read_file', exit_code: 0,
    output_excerpt: 'secret ghp_example_token', output_truncated: true }, 'run-1')!;
  const readable = renderObservableEvent(event);
  assert.match(readable, /TOOL RESULT read_file/);
  assert.doesNotMatch(readable, /ghp_example_token/);
  assert.match(renderObservableEvent(event, 'compact'), /^00:00:00 TOOL RESULT read_file/);
  assert.match(renderObservableEvent(event, 'verbose'), /output_excerpt=/);
  const json = JSON.parse(renderObservableEvent(event, 'json'));
  assert.equal(json.kind, 'tool');
  assert.equal(json.detail.output_excerpt, 'secret [REDACTED]');
  const failed = normalizeObservableEvent({ event: 'tool_end', time: '2026-09-16T00:00:00.000Z', tool: 'execute_command', exit_code: 1, error: 'failed' }, 'run-1')!;
  assert.equal(failed.title, 'TOOL ERROR execute_command');
  assert.match(renderObservableEvent(failed), /✖/);
});

test('summary renderer presents status without exposing a raw credential', () => {
  const output = renderSummary(summarizeRun({ runId: 'run-1', result: { status: 'failed', token: 'ghp_example_token' }, events: [] }));
  assert.match(output, /PatchPaw Agent Status/);
  assert.match(output, /Status     failed/);
  assert.doesNotMatch(output, /ghp_example_token/);
});

test('observer JSON projections do not dump full run artifacts', () => {
  const listed = renderRunList([{
    runId: 'run-1', manifestPath: 'run-1/manifest.json', startedAt: '2026-09-16T00:00:00.000Z',
    manifest: { repo: 'owner/repo', pr_number: 7, task_chain: ['review'], huge_prompt: 'x'.repeat(20_000) },
    result: { status: 'review_completed', answer: 'x'.repeat(20_000) },
  }], 'json');
  const json = JSON.parse(listed[0]!);
  assert.equal(json.repo, 'owner/repo');
  assert.equal(json.status, 'review_completed');
  assert.equal(json.huge_prompt, undefined);
  assert.equal(json.answer, undefined);
  const summary = renderSummary(summarizeRun({ runId: 'run-1', result: { status: 'failed', answer: 'x'.repeat(20_000) }, events: [] }), 'json');
  const summaryJson = JSON.parse(summary);
  assert.equal(summaryJson.result.answer, undefined);
});

test('observer notices remain one-line JSON records in JSON mode', () => {
  const waiting = JSON.parse(renderObserverNotice('waiting', 'json'));
  assert.deepEqual(waiting, { kind: 'observer', title: 'WAITING', message: 'No active local run. Waiting for the next PatchPaw run...' });
  const detached = JSON.parse(renderObserverNotice('detached', 'json'));
  assert.equal(detached.title, 'DETACHED');
  assert.match(detached.message, /not stopped/);
});

test('agent:open CLI replays a completed run and leaves runtime artifacts unchanged', async (t) => {
  const home = await observerHome(t);
  const paths = await createCliRun(home, 'completed-cli-run', {
    trace: JSON.stringify({ event: 'execution_started', time: '2026-09-17T00:00:00.000Z', execution_id: 1 }) + '\n'
      + JSON.stringify({ event: 'tool_end', time: '2026-09-17T00:00:01.000Z', tool: 'completed_tool', exit_code: 0 }) + '\n',
    result: { status: 'review_completed', run_id: 'completed-cli-run', final_head_sha: 'head-sha' },
  });
  const before = await artifactSnapshot(paths);
  const observer = startObserver(home, ['--run', 'completed-cli-run', '--all', '--compact'], t);
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.match(finished.stdout, /TOOL RESULT completed_tool/);
  assert.match(finished.stdout, /review_completed/);
  assert.equal(await artifactSnapshot(paths), before);
});

test('agent:open CLI follows a live run once without duplicating appended events', async (t) => {
  const home = await observerHome(t);
  const paths = await createCliRun(home, 'live-cli-run', {
    active: true,
    trace: JSON.stringify({ event: 'phase', time: '2026-09-17T00:00:00.000Z', phase: 'inspect' }) + '\n',
  });
  const observer = startObserver(home, ['--run', 'live-cli-run', '--all', '--compact'], t);
  await observer.waitFor('PHASE inspect');
  await appendFile(paths.tracePath, JSON.stringify({ event: 'tool_start', time: '2026-09-17T00:00:01.000Z', tool: 'live_tool' }) + '\n');
  await observer.waitFor('TOOL live_tool');
  await appendFile(paths.tracePath, JSON.stringify({ event: 'tool_end', time: '2026-09-17T00:00:02.000Z', tool: 'live_tool', exit_code: 0 }) + '\n');
  await observer.waitFor('TOOL RESULT live_tool');
  await writeFile(paths.resultPath, JSON.stringify({ status: 'review_completed', run_id: 'live-cli-run' }) + '\n');
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal((finished.stdout.match(/TOOL live_tool/g) ?? []).length, 1);
  assert.equal(finished.stdout.split('\n').filter(line => /^\d{2}:\d{2}:\d{2} TOOL RESULT live_tool/.test(line)).length, 1);
  assert.match(finished.stdout, /review_completed/);
});

test('agent:open CLI waits for a partial JSONL line until its newline arrives', async (t) => {
  const home = await observerHome(t);
  const paths = await createCliRun(home, 'partial-cli-run', {
    active: true,
    trace: JSON.stringify({ event: 'tool_start', time: '2026-09-17T00:00:00.000Z', tool: 'partial_tool' }),
  });
  const observer = startObserver(home, ['--run', 'partial-cli-run', '--all', '--compact'], t);
  await observer.waitFor('PatchPaw Agent Observer');
  assert.doesNotMatch(observer.stdout, /TOOL partial_tool/);
  await appendFile(paths.tracePath, '\n');
  await observer.waitFor('TOOL partial_tool');
  await writeFile(paths.resultPath, JSON.stringify({ status: 'review_completed', run_id: 'partial-cli-run' }) + '\n');
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal((finished.stdout.match(/TOOL partial_tool/g) ?? []).length, 1);
});

test('agent:open --wait attaches immediately to an exact active repo run', async (t) => {
  const home = await observerHome(t);
  const paths = await createCliRun(home, 'active-wait-run', {
    active: true,
    trace: JSON.stringify({ event: 'phase', time: '2026-09-17T00:00:00.000Z', phase: 'active_wait' }) + '\n',
  });
  const observer = startObserver(home, ['owner/repo', '123', '--wait', '--compact'], t);
  await observer.waitFor('PHASE active_wait');
  await writeFile(paths.resultPath, JSON.stringify({ status: 'review_completed', run_id: 'active-wait-run' }) + '\n');
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.match(finished.stdout, /active_wait/);
  assert.match(finished.stdout, /review_completed/);
});

test('agent:open --wait skips an old terminal run and attaches only to a new exact run', async (t) => {
  const home = await observerHome(t);
  await createCliRun(home, 'old-terminal-run', {
    trace: JSON.stringify({ event: 'tool_end', time: '2026-09-17T00:00:00.000Z', tool: 'old_tool', exit_code: 0 }) + '\n',
    result: { status: 'review_completed', run_id: 'old-terminal-run' },
  });
  await createCliRun(home, 'foreign-active-run', {
    repo: 'other/repo',
    active: true,
    trace: JSON.stringify({ event: 'tool_end', time: '2026-09-17T00:00:00.500Z', tool: 'foreign_tool', exit_code: 0 }) + '\n',
  });
  const observer = startObserver(home, ['owner/repo', '123', '--wait', '--compact'], t);
  await observer.waitFor('Waiting for the next PatchPaw run...');
  assert.doesNotMatch(observer.stdout, /old_tool/);
  const paths = await createCliRun(home, 'new-active-run', {
    active: true,
    trace: JSON.stringify({ event: 'phase', time: '2026-09-17T00:00:01.000Z', phase: 'new_exact_run' }) + '\n',
  });
  await observer.waitFor('PHASE new_exact_run');
  await writeFile(paths.resultPath, JSON.stringify({ status: 'review_completed', run_id: 'new-active-run' }) + '\n');
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.doesNotMatch(finished.stdout, /old_tool/);
  assert.doesNotMatch(finished.stdout, /foreign_tool/);
  assert.equal(finished.stdout.split('\n').filter(line => /^\d{2}:\d{2}:\d{2} PHASE new_exact_run/.test(line)).length, 1);
  assert.match(finished.stdout, /review_completed/);
});

test('agent:open SIGINT detaches a real observer without mutating runtime artifacts', async (t) => {
  const home = await observerHome(t);
  const paths = await createCliRun(home, 'detach-cli-run', {
    active: true,
    trace: JSON.stringify({ event: 'phase', time: '2026-09-17T00:00:00.000Z', phase: 'detach_test' }) + '\n',
  });
  const before = await artifactSnapshot(paths);
  const observer = startObserver(home, ['--run', 'detach-cli-run', '--all', '--compact'], t);
  await observer.waitFor('PHASE detach_test');
  observer.child.kill('SIGINT');
  const finished = await observer.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assert.match(finished.stdout, /Observer detached\. PatchPaw Agent was not stopped\./);
  assert.equal(await artifactSnapshot(paths), before);
});

test('compact run lists include task and canonical target context', () => {
  const [line] = renderRunList([{
    runId: 'run-1', manifestPath: 'run-1/manifest.json', startedAt: '2026-09-16T00:00:00.000Z',
    manifest: { repository: 'group/sub/project', pr_number: 7, task_chain: ['review'] }, result: { status: 'review_completed' },
  }], 'compact');
  assert.match(line!, /task=review/);
  assert.match(line!, /target=group\/sub\/project#7/);
});

test('CLI options keep the repo entry point and exact run entry point unambiguous', () => {
  const repo = parseTargetCommandArgs(['owner/repo', '12', '--replay', '0', '--compact'], 'agent:open');
  assert.deepEqual(repo.target, { repo: 'owner/repo', changeNumber: 12 });
  assert.equal(repo.replay, 0);
  assert.equal(repo.mode, 'compact');
  const run = parseTargetCommandArgs(['--run', 'run-1', '--all', '--json'], 'agent:open');
  assert.deepEqual(run.target, { runId: 'run-1' });
  assert.equal(run.replay, 'all');
  assert.equal(run.mode, 'json');
  assert.deepEqual(parseRunsArgs(['--failed', '--limit', '5', '--repo', 'owner/repo']).repo, 'owner/repo');
  assert.match(TARGET_COMMAND_HELP, /<repo> <PR\/MR number>.*\[--wait\]/);
  assert.match(TARGET_COMMAND_HELP, /\n\s+npm run agent:open -- --run <run-id>/);
  assert.doesNotMatch(TARGET_COMMAND_HELP.split('\n')[1]!, /--wait/);
  assert.throws(() => parseTargetCommandArgs(['--run', 'run-1', '--replay', '9'.repeat(30)], 'agent:open'), /safe integer/);
  assert.throws(() => parseTargetCommandArgs(['--run', 'run-1', '--wait'], 'agent:open'), /requires the <repo> <PR\/MR number>/);
  assert.throws(() => parseTargetCommandArgs(['owner/repo', '12', '--wait'], 'agent:status'), /only supported by agent:open/);
  assert.throws(() => parseRunsArgs(['--limit', '9'.repeat(30)]), /safe integer/);
});
