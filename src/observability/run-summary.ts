import { workerStatus, type RunState } from '../runner/state.ts';
import type { ObservableEvent } from './types.ts';
import type { RunManifest, RunResult } from './run-resolver.ts';

export interface RunSummary {
  runId: string;
  executionId?: number;
  task?: string;
  phase?: string;
  status: string;
  worker: 'idle' | 'running' | 'interrupted' | 'unknown';
  currentActivity: string;
  startedAt?: string;
  lastEventAt?: string;
  provider?: string;
  model?: string;
  requests: number;
  attempts: number;
  retries: number;
  tools: number;
  toolErrors: number;
  errors: number;
  validations: number;
  commits: number;
  pushes: number;
  remoteConfirmations: number;
  workspace?: string;
  head?: string;
  lastCommit?: string;
  lastPush?: string;
  result?: RunResult;
}

export interface RunSummaryInput {
  runId: string;
  manifest?: RunManifest;
  result?: RunResult | null;
  state?: RunState | null;
  events: ObservableEvent[];
}

function detailText(event: ObservableEvent, key: string) {
  const value = event.detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

function detailIdentifier(event: ObservableEvent, key: string) {
  const value = event.detail?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function detailNumber(event: ObservableEvent, key: string) {
  const value = event.detail?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function detailIndex(event: ObservableEvent) {
  const value = detailNumber(event, 'index');
  return value === undefined ? undefined : String(value);
}

function manifestTask(manifest: RunManifest | undefined) {
  const chain = manifest?.task_chain;
  return Array.isArray(chain) && typeof chain.at(-1) === 'string' ? chain.at(-1) as string : undefined;
}

export function summarizeRun(input: RunSummaryInput): RunSummary {
  const result = input.result ?? undefined;
  const state = input.state ?? null;
  const summary: RunSummary = {
    runId: input.runId, executionId: typeof input.manifest?.execution_id === 'number' ? input.manifest.execution_id : state?.execution_id,
    task: manifestTask(input.manifest), phase: state?.phase, status: typeof result?.status === 'string' ? result.status : state?.active ? 'active' : state?.phase ?? 'unknown',
    worker: state ? workerStatus(state) : result ? 'idle' : 'unknown', currentActivity: 'idle',
    startedAt: typeof input.manifest?.started_at === 'string' ? input.manifest.started_at : undefined,
    requests: 0, attempts: 0, retries: 0, tools: 0, toolErrors: 0, errors: 0, validations: 0, commits: 0, pushes: 0, remoteConfirmations: 0,
    head: typeof result?.final_head_sha === 'string' && result.final_head_sha ? result.final_head_sha : state?.current_head_sha || undefined,
    result,
  };
  const activeTools = new Map<string, string>();
  const pendingProviders = new Set<string>();
  let validationPending = false;
  let waitingForCi = false;
  let lastTitle = 'idle';

  for (const event of input.events) {
    summary.lastEventAt = event.time;
    summary.executionId = event.executionId ?? summary.executionId;
    lastTitle = event.title;
    const source = event.sourceEvent ?? '';
    const request = detailIdentifier(event, 'request');
    const index = detailIndex(event);
    if (source === 'phase' && detailText(event, 'phase')) summary.phase = detailText(event, 'phase');
    if (source === 'task_turn_start' || source === 'task_turn_end' || source === 'repair_started') summary.task = detailText(event, 'task') ?? summary.task;
    if (source === 'model_request') {
      summary.requests++;
      summary.provider = detailText(event, 'provider') ?? summary.provider;
      summary.model = detailText(event, 'model') ?? summary.model;
      pendingProviders.add(request ?? `request-${summary.requests}`);
    }
    if (source === 'provider_attempt') {
      summary.attempts++;
      pendingProviders.add(request ?? `attempt-${summary.attempts}`);
    }
    if (source === 'provider_retry') {
      summary.retries++;
      if (request !== undefined) pendingProviders.add(request);
    }
    if (source === 'model_response' || source === 'provider_error') if (request !== undefined) pendingProviders.delete(request);
    if (source === 'tool_start') {
      summary.tools++;
      activeTools.set(index ?? `tool-${summary.tools}`, detailText(event, 'tool') ?? 'unknown');
    }
    if (source === 'tool_end') {
      const tool = detailText(event, 'tool');
      const activeKey = index ?? [...activeTools.entries()].reverse().find(([, name]) => name === tool)?.[0];
      if (activeKey) activeTools.delete(activeKey);
      const exitCode = detailNumber(event, 'exit_code');
      if (event.detail?.error || (exitCode !== undefined && exitCode !== 0)) summary.toolErrors++;
    }
    if (event.kind === 'error') summary.errors++;
    if (source === 'validation' || source === 'repair_verification') summary.validations++;
    if (source === 'repair_verification_requested') validationPending = true;
    if (source === 'repair_verification') validationPending = false;
    if (source === 'ci_observation_wait') waitingForCi = true;
    if (source === 'ci_observation_complete') waitingForCi = false;
    if (source === 'repair_commit') {
      summary.commits++;
      summary.lastCommit = detailText(event, 'sha') ?? summary.lastCommit;
      summary.head = summary.lastCommit ?? summary.head;
    }
    if (source === 'repair_push') {
      summary.pushes++;
      summary.lastPush = detailText(event, 'sha') ?? summary.lastPush;
      summary.head = summary.lastPush ?? summary.head;
    }
    if (source.endsWith('push_confirmed')) summary.remoteConfirmations++;
    summary.workspace = detailText(event, 'workspace') ?? summary.workspace;
  }

  const activeTool = activeTools.values().next().value as string | undefined;
  if (activeTool) summary.currentActivity = `running tool ${activeTool}`;
  else if (pendingProviders.size) summary.currentActivity = 'waiting for provider';
  else if (state?.waiting_for_ci || waitingForCi) summary.currentActivity = 'waiting for CI';
  else if (validationPending) summary.currentActivity = 'waiting for validation';
  else if (summary.worker === 'interrupted') summary.currentActivity = 'worker interrupted';
  else summary.currentActivity = lastTitle;
  if (summary.worker === 'idle' && result) summary.currentActivity = 'terminal';
  return summary;
}
