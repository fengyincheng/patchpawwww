import { redactValue } from './redaction.ts';
import type { ObservableEvent, RawTraceEvent } from './types.ts';

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function detail(source: RawTraceEvent, keys: string[]) {
  const selected = Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]));
  return Object.keys(selected).length ? redactValue(selected) as Record<string, unknown> : undefined;
}

const MODEL_EVENTS = new Set(['model_request', 'provider_attempt', 'provider_retry', 'provider_error', 'model_response', 'model_step']);
const TOOL_EVENTS = new Set(['tool_start', 'tool_end']);
const GIT_EVENTS = new Set(['git', 'repair_commit', 'repair_push', 'repair_push_confirmed', 'conflict_repair_push_confirmed', 'gitlab_conflict_repair_push_confirmed']);
const VALIDATION_EVENTS = new Set(['validation', 'repair_verification', 'repair_verification_requested', 'ci_poll', 'ci_observation_wait', 'ci_observation_complete', 'ci_failure_evidence']);
const WORKSPACE_EVENTS = new Set(['workspace_change', 'workspace_evidence_captured', 'workspace_disposed', 'workspace_resumed', 'worktree_created',
  'workspace_path_disposed', 'stale_workspace_disposed', 'repo_cache_initialized', 'repo_cache_fetched', 'repo_cache_remote_added', 'repo_cache_remote_updated']);
const ERROR_EVENTS = new Set(['provider_error', 'run_error', 'human_stop_closeout_failed', 'workspace_dispose_failed', 'workspace_retain_failed',
  'stale_workspace_dispose_failed', 'superseded_workspace_dispose_failed', 'repair_closeout_error']);
const RESULT_EVENTS = new Set(['execution_completed', 'execution_paused', 'budget_exhausted', 'task_closeout_submitted', 'conversation_reply_published', 'review_published', 'repair_closeout_started']);

function eventKind(event: string): ObservableEvent['kind'] {
  if (MODEL_EVENTS.has(event)) return event === 'provider_error' ? 'error' : 'model';
  if (TOOL_EVENTS.has(event)) return 'tool';
  if (GIT_EVENTS.has(event)) return 'git';
  if (VALIDATION_EVENTS.has(event)) return 'validation';
  if (WORKSPACE_EVENTS.has(event)) return 'workspace';
  if (ERROR_EVENTS.has(event)) return 'error';
  if (RESULT_EVENTS.has(event)) return 'result';
  if (event === 'phase' || event === 'task_turn_start' || event === 'task_turn_end' || event === 'repair_started') return 'phase';
  if (event === 'execution_started' || event === 'execution_resumed' || event === 'recovery_started') return 'run';
  return 'warning';
}

function titleFor(event: string, source: RawTraceEvent) {
  if (event === 'phase') return `PHASE ${text(source.phase, 'unknown')}`;
  if (event === 'tool_start') return `TOOL ${text(source.tool, 'unknown')}`;
  if (event === 'tool_end') {
    const exitCode = number(source.exit_code);
    return source.error || exitCode !== undefined && exitCode !== 0 ? `TOOL ERROR ${text(source.tool, 'unknown')}` : `TOOL RESULT ${text(source.tool, 'unknown')}`;
  }
  if (event === 'model_request') return 'MODEL REQUEST';
  if (event === 'model_response') return 'MODEL RESPONSE';
  if (event === 'provider_attempt') return 'PROVIDER ATTEMPT';
  if (event === 'provider_retry') return 'PROVIDER RETRY';
  if (event === 'provider_error') return 'PROVIDER ERROR';
  if (event === 'model_step') return 'MODEL STEP';
  if (event === 'validation') return 'VALIDATION';
  if (event === 'repair_commit') return 'COMMIT';
  if (event === 'repair_push') return 'PUSH';
  if (event === 'repair_push_confirmed' || event.endsWith('push_confirmed')) return 'REMOTE CONFIRMED';
  if (event === 'git') return 'GIT';
  if (event === 'execution_started') return 'RUN STARTED';
  if (event === 'execution_completed') return 'RUN COMPLETED';
  if (event === 'execution_paused') return 'RUN PAUSED';
  if (event === 'run_error') return 'RUN ERROR';
  if (event === 'task_turn_start') return `TASK TURN ${text(source.task, 'start')}`;
  if (event === 'task_turn_end') return `TASK TURN ${text(source.task, 'end')}`;
  return event.replaceAll('_', ' ').toUpperCase();
}

function selectedDetail(event: string, source: RawTraceEvent) {
  const keys = event === 'tool_start' || event === 'tool_end'
    ? ['task', 'index', 'tool', 'args', 'args_chars', 'args_sha256', 'duration_ms', 'result_chars', 'output_excerpt', 'output_sha256', 'output_truncated', 'exit_code', 'truncated', 'error']
    : event === 'model_request' || event === 'model_response' || event === 'provider_attempt' || event === 'provider_retry' || event === 'provider_error'
      ? ['task', 'provider', 'provider_id', 'model', 'request', 'attempt', 'status', 'duration_ms', 'body_chars', 'body_sha256', 'body_excerpt', 'output_budget', 'raw_chars', 'raw_sha256', 'raw_excerpt', 'raw_truncated', 'reason', 'code', 'retry_after_ms']
      : event === 'git'
        ? ['args', 'exitCode', 'timedOut', 'stdout_chars', 'stdout', 'stdout_sha256', 'stderr_chars', 'stderr', 'truncated']
        : event === 'validation'
          ? ['command', 'exitCode', 'timedOut', 'stdout_chars', 'stdout', 'stderr_chars', 'stderr', 'truncated']
          : ['task', 'phase', 'status', 'reason', 'message', 'failure_code', 'failure_category', 'failure', 'sha', 'start_head', 'previous_head',
            'head_sha', 'branch', 'source', 'workspace', 'execution_id', 'duration_ms', 'finish_reason', 'usage', 'kind'];
  return detail(source, keys);
}

function explicitThinking(source: RawTraceEvent) {
  for (const key of ['reasoning', 'thinking', 'reasoning_content', 'reasoning_summary']) {
    if (source[key] !== undefined && source[key] !== null) return detail(source, [key]);
  }
  return undefined;
}

export function normalizeObservableEvent(source: unknown, runId: string): ObservableEvent | null {
  const raw = object(source);
  const event = text(raw.event);
  if (!event) return null;
  const time = text(raw.time, new Date(0).toISOString());
  const executionId = number(raw.execution_id);
  const thinking = explicitThinking(raw);
  const kind = thinking ? 'thinking' : eventKind(event);
  return { time, runId, ...(executionId === undefined ? {} : { executionId }), sourceEvent: event,
    kind, title: thinking ? 'MODEL REASONING' : titleFor(event, raw),
    ...(text(raw.status) ? { status: text(raw.status) } : {}),
    ...(thinking ?? selectedDetail(event, raw) ? { detail: thinking ?? selectedDetail(event, raw) } : {}) };
}
