import { cleanJson, redactText, redactValue } from './redaction.ts';
import type { ObservableEvent } from './types.ts';
import type { PublicationRecord, PublicationView } from './publication.ts';
import type { RunSummary } from './run-summary.ts';
import type { ListedRun } from './run-resolver.ts';

export type RenderMode = 'readable' | 'compact' | 'verbose' | 'json';

const MAX_RENDERED_VALUE = 1200;
const MAX_RENDERED_OBJECT_KEYS = 32;
const MAX_RENDERED_ARRAY_ITEMS = 20;

function clock(value: string) {
  return value.length >= 19 && value[10] === 'T' ? value.slice(11, 19) : value;
}

function icon(event: ObservableEvent) {
  if (event.kind === 'error') return '✖';
  if (event.kind === 'warning') return '⚠';
  if (event.kind === 'result') return event.status?.includes('completed') ? '✓' : '◆';
  if (event.kind === 'tool') {
    if (event.sourceEvent === 'tool_end' && (event.title.startsWith('TOOL ERROR') || event.detail?.error || event.detail?.exit_code && event.detail.exit_code !== 0)) return '✖';
    return event.sourceEvent === 'tool_end' ? '✓' : '●';
  }
  if (event.kind === 'git') return event.sourceEvent?.endsWith('confirmed') ? '✓' : '📦';
  if (event.kind === 'validation') return '🧪';
  if (event.kind === 'thinking') return '💭';
  if (event.kind === 'model') return '🤖';
  if (event.kind === 'phase') return '◆';
  return '▶';
}

function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const text = redactText(value);
    return text.length > MAX_RENDERED_VALUE ? `${text.slice(0, MAX_RENDERED_VALUE)}…[TRUNCATED]` : text;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_RENDERED_ARRAY_ITEMS).map(item => bounded(item, depth + 1));
    if (value.length > MAX_RENDERED_ARRAY_ITEMS) items.push(`[${value.length - MAX_RENDERED_ARRAY_ITEMS} items truncated]`);
    return items;
  }
  if (depth < 4 && value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_RENDERED_OBJECT_KEYS).map(([key, child]) => [key, bounded(child, depth + 1)]);
    if (Object.keys(value).length > MAX_RENDERED_OBJECT_KEYS) entries.push(['_truncated', true]);
    return Object.fromEntries(entries);
  }
  if (depth >= 4 && value && typeof value === 'object') return '[OBJECT TRUNCATED]';
  return value;
}

function scalar(value: unknown) {
  if (typeof value === 'string') return redactText(value.replaceAll('\n', '\\n')).slice(0, MAX_RENDERED_VALUE);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return redactText(JSON.stringify(bounded(redactValue(value))) ?? 'null');
}

function boundedText(value: unknown) {
  return String(bounded(value));
}

function publicationLine(record: PublicationRecord) {
  const parts = [`${record.purpose}: ${record.state}`];
  if (record.status && record.status !== record.state) parts.push(`status=${record.status}`);
  parts.push(`classification=${record.classification}`);
  if (record.httpStatus !== null && record.httpStatus !== undefined) parts.push(`http=${record.httpStatus}`);
  if (record.errorName) parts.push(`error=${record.errorName}`);
  if (record.errorCategory) parts.push(`category=${record.errorCategory}`);
  if (record.retryAfterMs !== null && record.retryAfterMs !== undefined) parts.push(`retry_after_ms=${record.retryAfterMs}`);
  if (record.remoteId !== undefined) parts.push(`remote=${record.remoteId}`);
  return parts.join(' ');
}

function publicationLines(publication: PublicationView, verbose = false) {
  if (!verbose) {
    const notice = (publication.notice?.state !== 'delivered' ? publication.notice : undefined)
      ?? publication.records.find(record => record.state !== 'delivered')
      ?? publication.notice
      ?? publication.records.at(-1);
    if (!notice) return [];
    const parts = [publicationLine(notice)];
    if (notice.httpStatus !== null && notice.httpStatus !== undefined) parts.push(`HTTP ${notice.httpStatus}`);
    if (notice.errorMessage) parts.push(`reason: ${boundedText(notice.errorMessage)}`);
    if (notice.documentationUrl) parts.push(`documentation: ${boundedText(notice.documentationUrl)}`);
    if (notice.requestId) parts.push(`request: ${boundedText(notice.requestId)}`);
    const lines = [parts.join(' · ')];
    if (publication.blockedWithoutDelivery) lines.push('TASK TERMINAL, DELIVERY NOT CONFIRMED — the run ended but the user was not reached.');
    return lines;
  }
  const lines = ['', 'Publication'];
  for (const record of publication.records) {
    lines.push(`  ${boundedText(publicationLine(record))}`);
    if (record.errorMessage) lines.push(`    reason: ${boundedText(record.errorMessage)}`);
    if (record.documentationUrl) lines.push(`    documentation: ${boundedText(record.documentationUrl)}`);
    if (record.requestId) lines.push(`    request: ${boundedText(record.requestId)}`);
    lines.push(`    artifacts: ${boundedText(record.artifacts.join(', ') || 'none')}`);
    if (record.events.length) lines.push(`    events: ${boundedText(record.events.join(', '))}`);
  }
  if (publication.blockedWithoutDelivery) lines.push('  TASK TERMINAL, DELIVERY NOT CONFIRMED — the run ended but the user was not reached.');
  return lines;
}

function manifestRepo(manifest: ListedRun['manifest']) {
  for (const key of ['repository', 'repository_path', 'path_with_namespace', 'full_name', 'repo']) {
    if (typeof manifest?.[key] === 'string') return manifest[key];
  }
  return undefined;
}

function details(event: ObservableEvent, verbose: boolean) {
  if (!event.detail) return '';
  const entries = Object.entries(event.detail).filter(([, value]) => value !== undefined);
  const selected = verbose ? entries : entries.filter(([key]) => !['task', 'index', 'provider_id', 'request', 'attempt', 'body_sha256', 'raw_sha256', 'output_sha256', 'args_sha256'].includes(key));
  return selected.slice(0, verbose ? 32 : 12).map(([key, value]) => `${key}=${scalar(value)}`).join(' ');
}

export function renderObservableEvent(event: ObservableEvent, mode: RenderMode = 'readable') {
  const safe = redactValue(event) as ObservableEvent;
  if (mode === 'json') return cleanJson(bounded(safe));
  const detail = details(safe, mode === 'verbose');
  if (mode === 'compact') return `${clock(boundedText(safe.time))} ${boundedText(safe.title)}${detail ? ` ${detail}` : ''}`;
  return `${clock(boundedText(safe.time))}  ${icon(safe)} ${boundedText(safe.title)}${detail ? `\n           ${detail}` : ''}`;
}

function summaryLines(summary: RunSummary) {
  return [
    'PatchPaw Agent Status',
    '',
    `Run        ${boundedText(summary.runId)}`,
    `Repo/PR    ${boundedText(summary.repo ? `${summary.repo}#${summary.prNumber ?? '?'}` : 'unknown')}`,
    `Execution  ${summary.executionId ?? 'unknown'}`,
    `Worker     ${summary.worker}`,
    `Phase      ${boundedText(summary.phase ?? 'unknown')}`,
    `Task       ${boundedText(summary.task ?? 'unknown')}`,
    `Permission ${boundedText(summary.permission ?? 'unknown')}`,
    `Status     ${boundedText(summary.status)}`,
    `Current    ${boundedText(summary.currentActivity)}`,
    `Started    ${boundedText(summary.startedAt ?? 'unknown')}`,
    `Last event ${boundedText(summary.lastEventAt ?? 'unknown')}`,
    '',
    `Model      ${boundedText(summary.model ?? 'unknown')}`,
    `Provider   ${boundedText(summary.provider ?? 'unknown')}`,
    `Requests   ${summary.requests}`,
    `Attempts   ${summary.attempts}`,
    `Retries    ${summary.retries}`,
    `Tools      ${summary.tools}`,
    `Tool errors ${summary.toolErrors}`,
    `Errors     ${summary.errors}`,
    `Validations ${summary.validations}`,
    `CI polls   ${summary.ciPolls}`,
    `Commits    ${summary.commits}`,
    `Pushes     ${summary.pushes}`,
    `Confirmed  ${summary.remoteConfirmations}`,
    `Workspace  ${boundedText(summary.workspace ?? 'unknown')}`,
    `Head       ${boundedText(summary.head ?? 'unknown')}`,
    ...(summary.lastCommit ? [`Last commit ${boundedText(summary.lastCommit)}`] : []),
    ...(summary.lastPush ? [`Last push   ${boundedText(summary.lastPush)}`] : []),
    ...(summary.result ? ['', `Result     ${scalar(resultProjection(summary.result))}`] : []),
  ];
}

function resultProjection(result: Record<string, unknown>) {
  const projection: Record<string, unknown> = {};
  for (const key of ['status', 'run_id', 'failed_phase', 'failure_code', 'final_head_sha', 'duration_ms', 'message']) {
    if (result[key] !== undefined) projection[key] = result[key];
  }
  const failure = result.failure;
  if (typeof failure === 'string') projection.failure = failure;
  else if (failure && typeof failure === 'object') {
    const value = failure as Record<string, unknown>;
    projection.failure = Object.fromEntries(['code', 'category', 'message', 'phase'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  }
  return projection;
}

export function renderSummary(summary: RunSummary, mode: RenderMode = 'readable') {
  const safe = redactValue(summary) as RunSummary;
  if (mode === 'json') return cleanJson(bounded({ ...safe, result: safe.result ? resultProjection(safe.result) : undefined }));
  if (mode === 'compact') return `${boundedText(safe.runId)} ${boundedText(safe.status)} phase=${boundedText(safe.phase ?? 'unknown')} current=${boundedText(safe.currentActivity)} tools=${safe.tools} errors=${safe.errors}`;
  const lines = summaryLines(safe);
  if (safe.publication) lines.push(...publicationLines(safe.publication, mode === 'verbose'));
  return lines.join('\n');
}

export function renderObserverHeader(runId: string, mode: RenderMode = 'readable') {
  if (mode === 'json') return '';
  if (mode === 'compact') return `PatchPaw Agent Observer run=${boundedText(runId)}`;
  return `PatchPaw Agent Observer\nrun=${boundedText(runId)}\n${'─'.repeat(60)}`;
}

export function renderRunList(runs: ListedRun[], mode: RenderMode = 'readable') {
  if (mode === 'json') return runs.map(run => cleanJson(bounded({
    runId: run.runId,
    startedAt: run.startedAt,
    repo: manifestRepo(run.manifest),
    changeNumber: run.manifest?.pr_number,
    task: Array.isArray(run.manifest?.task_chain) ? run.manifest.task_chain.at(-1) : undefined,
    status: typeof run.result?.status === 'string' ? run.result.status : 'active/unknown',
    error: run.error,
  })));
  if (mode === 'compact') return runs.map(run => {
    const task = Array.isArray(run.manifest?.task_chain) && typeof run.manifest.task_chain.at(-1) === 'string' ? run.manifest.task_chain.at(-1) : 'unknown';
    const repo = manifestRepo(run.manifest);
    const target = typeof repo === 'string' ? `${repo}#${run.manifest?.pr_number ?? '?'}` : 'corrupt manifest';
    return `${boundedText(run.startedAt ?? 'unknown')} ${boundedText(run.runId ?? 'corrupt')} task=${boundedText(task)} target=${boundedText(target)} status=${boundedText(typeof run.result?.status === 'string' ? run.result.status : 'active/unknown')}`;
  });
  const rows = ['TIME                 RUN                              TASK       STATUS       REPO / PR'];
  for (const run of runs) {
    const task = Array.isArray(run.manifest?.task_chain) && typeof run.manifest.task_chain.at(-1) === 'string' ? boundedText(run.manifest.task_chain.at(-1)) : 'unknown';
    const status = typeof run.result?.status === 'string' ? run.result.status : 'active/unknown';
    const repoValue = manifestRepo(run.manifest);
    const repo = typeof repoValue === 'string' ? `${repoValue}#${run.manifest?.pr_number ?? '?'}` : 'corrupt manifest';
    rows.push(`${boundedText(run.startedAt ?? 'unknown')} ${boundedText(run.runId ?? 'corrupt')} ${String(task).padEnd(10)} ${boundedText(status).padEnd(12)} ${boundedText(repo)}`);
    if (run.error) rows.push(`  warning: ${boundedText(redactText(run.error))}`);
  }
  return [rows.join('\n')];
}

export function renderMalformed(line: number, message: string, excerpt: string, mode: RenderMode = 'readable') {
  const safeMessage = boundedText(redactText(message));
  const safeExcerpt = boundedText(redactText(excerpt));
  const value = { kind: 'warning', title: 'MALFORMED TRACE LINE', line, message: safeMessage, excerpt: safeExcerpt };
  return mode === 'json' ? cleanJson(value) : `⚠ MALFORMED TRACE LINE line=${line} message=${safeMessage} excerpt=${safeExcerpt}`;
}

export const DETACHED_MESSAGE = 'Observer detached. PatchPaw Agent was not stopped.';

export function renderObserverNotice(kind: 'waiting' | 'detached', mode: RenderMode) {
  const title = kind === 'waiting' ? 'WAITING' : 'DETACHED';
  const message = kind === 'waiting' ? 'No active local run. Waiting for the next PatchPaw run...' : DETACHED_MESSAGE;
  return mode === 'json' ? cleanJson({ kind: 'observer', title, message }) : message;
}
