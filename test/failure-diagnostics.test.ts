import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlaneError } from '../src/control-plane/errors.ts';
import { ModelOutputTruncated } from '../src/harness/runtime.ts';
import { ProviderResponseError } from '../src/harness/retry.ts';
import { GitLabHttpError } from '../src/scm/gitlab/client.ts';
import { classifyRunFailure, terminalStatusForFailure } from '../src/runner/failures.ts';
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

test('classifies GitLab HTTP, network, and configuration failures as SCM/provider failures', () => {
  assert.deepEqual(classifyRunFailure(new GitLabHttpError(401, 'GitLab API request failed (401)')), {
    code: 'gitlab_auth_failed', category: 'scm', scm_platform: 'gitlab', retryable: false, user_action: 'check_configuration',
    message: 'GitLab API request failed (401)', upstream_status: 401,
  });
  assert.deepEqual(classifyRunFailure(new GitLabHttpError(429, 'GitLab API request failed (429)')), {
    code: 'gitlab_unavailable', category: 'scm', scm_platform: 'gitlab', retryable: true, user_action: 'retry',
    message: 'GitLab API request failed (429)', upstream_status: 429,
  });
  const network = Object.assign(new Error('GitLab request failed'), { code: 'GITLAB_NETWORK_ERROR' });
  const networkFailure = classifyRunFailure(network);
  assert.equal(networkFailure.code, 'gitlab_unavailable');
  assert.equal(networkFailure.retryable, true);
  assert.deepEqual(classifyRunFailure(new ControlPlaneError('provider_unavailable', 'Configured provider or model is disabled.')), {
    code: 'provider_configuration_error', category: 'provider', retryable: false, user_action: 'check_configuration',
    message: 'Configured provider or model is disabled.',
  });
});

test('preserves dedicated model truncation status and renders a GitLab notice', () => {
  const failure = classifyRunFailure(new ModelOutputTruncated({ task: 'custom', finishReason: 'length', maxOutputTokens: 10, evidencePath: 'evidence.json' }));
  assert.equal(failure.code, 'model_output_truncated');
  assert.equal(terminalStatusForFailure(failure), 'model_output_truncated');
  const body = runNoticeBody({ run_id: 'gitlab-run', head: '', status: 'model_output_truncated', phase: 'custom',
    reason: '模型没有生成完整结果。', mentions: ['owner'], platform: 'gitlab', failure });
  assert.match(body, /模型输出被截断/);
  assert.match(body, /此 MR/);
});

test('renders GitLab authentication guidance without describing it as a provider error', () => {
  const failure = classifyRunFailure(new GitLabHttpError(403, 'GitLab API request failed (403)'));
  const body = runNoticeBody({ run_id: 'gitlab-auth', head: 'head', status: 'harness_failed', phase: 'bootstrap',
    reason: failure.message, mentions: [], platform: 'gitlab', failure });
  assert.match(body, /GitLab 认证失败/);
  assert.match(body, /检查 GitLab token 和连接配置/);
  assert.doesNotMatch(body, /检查 Provider 凭据和配置/);
});

test('classifies an uncategorized Harness error as an actionable internal failure', () => {
  const failure = classifyRunFailure(new Error('Harness internal fixture failure'));
  assert.deepEqual(failure, {
    code: 'internal_error', category: 'internal', retryable: false, user_action: 'inspect_logs', message: 'Harness internal fixture failure',
  });
  assert.equal(terminalStatusForFailure(failure), 'harness_failed');
  const body = runNoticeBody({ run_id: 'internal-run', head: 'head', status: 'harness_failed', phase: 'custom',
    reason: failure.message, mentions: [], platform: 'gitlab', failure });
  assert.match(body, /PatchPaw 内部错误/);
  assert.match(body, /查看 Run trace/);
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
