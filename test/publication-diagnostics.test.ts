import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptDelivery, enqueueCommentDelivery, listOutbound, safeError } from '../src/runner/outbound.ts';
import { openCommunicationStore, closeCommunicationStore } from '../src/runner/communication-store.ts';
import { readPublicationView } from '../src/observability/publication.ts';
import { resolveRun } from '../src/observability/run-resolver.ts';
import { readNormalizedTrace, readRunResult, readCommandFacts } from '../src/observability/run-reader.ts';
import { normalizeObservableEvent } from '../src/observability/normalize.ts';
import { summarizeRun } from '../src/observability/run-summary.ts';
import { renderSummary } from '../src/observability/renderer.ts';

function githubError(status: number, data: Record<string, unknown>, headers: Record<string, string> = {}) {
  const error = new Error(typeof data.message === 'string' ? data.message : `Request failed with status code ${status}`) as Error & Record<string, unknown>;
  error.name = 'HttpError';
  error.status = status;
  error.response = { status, data, headers: { 'x-github-request-id': 'A1B2:3C4D:5E6F', authorization: 'Bearer ghs_leakedtoken', ...headers } };
  return error;
}

function fakeClient(status: number, data: Record<string, unknown>, headers?: Record<string, string>) {
  const client: any = { rest: { issues: { listComments: async () => ({ data: [] }),
    createComment: async () => { throw githubError(status, data, headers); } } } };
  return client;
}

test('a refused publication keeps a safe, useful explanation of the failure', () => {
  const safe = safeError(githubError(403, {
    message: 'Resource not accessible by integration',
    documentation_url: 'https://docs.github.com/rest/issues/comments#create-an-issue-comment',
  }));
  assert.equal(safe.status, 403);
  assert.equal(safe.name, 'HttpError');
  assert.equal(safe.category, 'http');
  assert.equal(safe.classification, 'permanent');
  assert.equal(safe.message, 'Resource not accessible by integration');
  assert.equal(safe.documentation_url, 'https://docs.github.com/rest/issues/comments#create-an-issue-comment');
  assert.equal(safe.request_id, 'A1B2:3C4D:5E6F');
});

test('transient communication failures are classified as retryable', () => {
  const limited = safeError(githubError(429, { message: 'API rate limit exceeded' }, { 'retry-after': '7' }));
  assert.equal(limited.classification, 'retryable');
  assert.equal(limited.category, 'transient_http');
  assert.equal(limited.retry_after_ms, 7000);
  assert.equal(safeError(githubError(403, { message: 'You have exceeded a secondary rate limit' })).classification, 'retryable');
  assert.equal(safeError(githubError(503, { message: 'Server Error' })).classification, 'retryable');
  const transport = safeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  assert.equal(transport.status, null);
  assert.equal(transport.category, 'transport');
  assert.equal(transport.classification, 'retryable');
});

test('safe provider explanations never persist credentials or unbounded bodies', () => {
  const safe = safeError(githubError(403, {
    message: 'refused with Authorization: Bearer ghs_realtokenvalue and token ghs_anothertoken',
    documentation_url: 'https://docs.github.com/rest',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
  }));
  const serialized = JSON.stringify(safe);
  for (const leak of ['ghs_realtokenvalue', 'ghs_anothertoken', 'ghs_leakedtoken', 'PRIVATE KEY', 'secret']) {
    assert.equal(serialized.includes(leak), false, `${leak} must not be persisted`);
  }
  assert.match(String(safe.message), /\[REDACTED\]/);
  assert.ok(String(safeError(githubError(422, { message: 'x'.repeat(5000) })).message).length <= 400);
});

test('blocked publication is durable, visible to the observer, and never reported as delivered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-publication-diagnostics-'));
  const stored = await enqueueCommentDelivery({ root, repo: 'owner/repo', prNumber: 7, purpose: 'run_notice',
    semanticKey: 'run-notice:fixture', body: 'body', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
  const attempt = await attemptDelivery(root, stored, { client: fakeClient(403, {
    message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest' }) });
  assert.equal(attempt?.item.status, 'blocked');

  const db = await openCommunicationStore(root);
  try {
    const row = await db.getOutboundByDeliveryId(stored.item.delivery_id);
    const lastError = row?.item.last_error;
    assert.equal(lastError?.status, 403);
    assert.equal(lastError?.classification, 'permanent');
    assert.equal(lastError?.message, 'Resource not accessible by integration');
    assert.equal(lastError?.documentation_url, 'https://docs.github.com/rest');
    assert.equal(lastError?.request_id, 'A1B2:3C4D:5E6F');
    assert.equal(JSON.stringify(row).includes('ghs_leakedtoken'), false);
  } finally { await closeCommunicationStore(db); }

  const dir = join(root, 'runs', 'run-1');
  await mkdir(dir, { recursive: true });
  const notice = (await listOutbound(root))[0]!.item;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'run-1', repo: 'owner/repo', pr_number: 7, task_chain: ['ci'] }));
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'needs_human', repo: 'owner/repo', pr_number: 7 }));
  await writeFile(join(dir, 'run-notice.json'), JSON.stringify({ status: 'needs_human' }));
  await writeFile(join(dir, 'notification.json'), JSON.stringify({ status: 'notification_failed', http_status: 403, last_error: notice.last_error }));
  await writeFile(join(dir, 'trace.jsonl'), JSON.stringify({ time: '2026-09-19T03:19:18.960Z', event: 'run_notice_published',
    execution_id: 1, status: 'blocked', delivery_id: notice.delivery_id, last_error: notice.last_error }) + '\n');

  const events = [normalizeObservableEvent(JSON.parse(await readFile(join(dir, 'trace.jsonl'), 'utf8')), 'run-1')!];
  const publication = await readPublicationView({ dir, events, terminal: true });
  assert.equal(publication.notice?.state, 'blocked');
  assert.equal(publication.notice?.classification, 'permanent');
  assert.equal(publication.notice?.httpStatus, 403);
  assert.equal(publication.notice?.errorName, 'HttpError');
  assert.equal(publication.anyDelivered, false);

  const summary = summarizeRun({ runId: 'run-1', manifest: { run_id: 'run-1', repo: 'owner/repo', pr_number: 7, task_chain: ['ci'] },
    result: { status: 'needs_human' }, events, publication });
  const rendered = renderSummary(summary);
  assert.match(rendered, /Status\s+needs_human/);
  assert.match(rendered, /run_notice: blocked/);
  assert.match(rendered, /HTTP 403/);
  assert.match(rendered, /reason: Resource not accessible by integration/);
  assert.match(rendered, /TASK TERMINAL, DELIVERY NOT CONFIRMED/);
});

test('observer can explain a refused publication from run artifacts alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-refusal-reason-'));
  const dir = join(root, 'runs', 'run-403');
  await mkdir(dir, { recursive: true });
  const refusal = { status: 403, code: null, name: 'HttpError', category: 'http', classification: 'permanent',
    message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest/issues/comments#create-an-issue-comment',
    request_id: 'A1B2:3C4D:5E6F', retry_after_ms: null };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'run-403', repo: 'owner/repo', pr_number: 7,
    task_chain: ['ci'], started_at: '2026-09-19T03:16:21.879Z' }));
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'needs_human', run_id: 'run-403', repo: 'owner/repo',
    pr_number: 7, duration_ms: 176321 }));
  await writeFile(join(dir, 'run-notice.json'), JSON.stringify({ status: 'needs_human', run_id: 'run-403' }));
  await writeFile(join(dir, 'notification.json'), JSON.stringify({ status: 'notification_failed', http_status: 403, last_error: refusal }));
  await writeFile(join(dir, 'command-snapshot.json'), JSON.stringify({ template_type: 'ci',
    command: { slash_name: 'ci', execution_type: 'ci', permission: 'read_write_approval' } }));
  await writeFile(join(dir, 'trace.jsonl'), [
    JSON.stringify({ time: '2026-09-19T03:16:21.883Z', event: 'phase', execution_id: 1, phase: 'inspect' }),
    JSON.stringify({ time: '2026-09-19T03:19:18.960Z', event: 'run_notice_published', execution_id: 1,
      status: 'blocked', delivery_id: 'delivery-1', last_error: refusal }),
  ].join('\n') + '\n');

  const run = await resolveRun({ runId: 'run-403', runtimeHome: root });
  const trace = await readNormalizedTrace(run);
  const result = await readRunResult(run);
  const publication = await readPublicationView({ dir: run.dir, events: trace.events, terminal: !!result });
  const summary = summarizeRun({ runId: run.runId, manifest: run.manifest, result, events: trace.events, publication,
    command: await readCommandFacts(run.dir) });
  const readable = renderSummary(summary);
  assert.match(readable, /Permission\s+read_write_approval/);
  assert.match(readable, /Status\s+needs_human/);
  assert.match(readable, /run_notice: blocked/);
  assert.match(readable, /HTTP 403/);
  assert.match(readable, /reason: Resource not accessible by integration/);
  assert.match(readable, /TASK TERMINAL, DELIVERY NOT CONFIRMED/);

  const verbose = renderSummary(summary, 'verbose');
  assert.match(verbose, /classification=permanent/);
  assert.match(verbose, /http=403/);
  assert.match(verbose, /documentation: https:\/\/docs\.github\.com\/rest\/issues\/comments/);
  assert.match(verbose, /request: A1B2:3C4D:5E6F/);
  const asJson = JSON.parse(renderSummary(summary, 'json')) as { publication: { notice: Record<string, unknown> } };
  assert.equal(asJson.publication.notice.errorMessage, 'Resource not accessible by integration');
  assert.equal(asJson.publication.notice.requestId, 'A1B2:3C4D:5E6F');
  assert.equal(asJson.publication.notice.classification, 'permanent');
});
