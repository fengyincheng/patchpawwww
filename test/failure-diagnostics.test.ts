import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderResponseError } from '../src/harness/retry.ts';
import { classifyRunFailure } from '../src/runner/failures.ts';
import { runNoticeBody } from '../src/github/comments.ts';
import { summarizeRun } from '../scripts/summarize-run.ts';

test('classifies an upstream provider outage and renders an actionable notice', () => {
  const failure = classifyRunFailure(new ProviderResponseError('provider_upstream_unavailable', 'Service temporarily overloaded', {
    status: 502, upstreamCode: 502, upstreamMessage: 'Service temporarily overloaded', retryable: true,
  }));
  assert.deepEqual(failure, {
    code: 'provider_upstream_unavailable', category: 'provider', retryable: true, user_action: 'retry',
    message: 'Service temporarily overloaded', upstream_status: 502, upstream_code: 502,
  });
  const body = runNoticeBody({ run_id: 'failure-run', head: 'head', status: 'provider_unavailable', phase: 'custom',
    reason: '本次没有记录 PatchPaw 提交或推送；失败不代表代码已交付。', mentions: ['owner'], failure });
  assert.match(body, /模型服务暂时不可用/);
  assert.match(body, /provider_upstream_unavailable/);
  assert.match(body, /HTTP 502/);
  assert.match(body, /稍后重新发送原命令/);
  assert.doesNotMatch(body, /Harness 执行／验证过程出错/);
});

test('summarize-run reads bounded current trace fields without crashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-summary-'));
  await writeFile(join(root, 'trace.jsonl'), [
    JSON.stringify({ time: '2026-09-14T00:00:00.000Z', event: 'phase', phase: 'custom' }),
    JSON.stringify({ time: '2026-09-14T00:00:01.000Z', event: 'model_request', body_chars: 1234 }),
    JSON.stringify({ time: '2026-09-14T00:00:02.000Z', event: 'model_response', status: 200,
      raw_excerpt: JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call-1' }] } }] }) }),
    JSON.stringify({ time: '2026-09-14T00:00:03.000Z', event: 'model_step', usage: { inputTokens: 4, outputTokens: 5, cachedInputTokens: 1 } }),
  ].join('\n') + '\n');
  const summary = summarizeRun(root);
  assert.equal(summary.max_request_chars, 1234);
  assert.equal(summary.model_requested_tool_calls, 1);
  assert.equal(summary.usage.input_tokens, 4);
});
