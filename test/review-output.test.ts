import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview } from '../src/tasks/review/agent.ts';
import { Trace } from '../src/harness/trace.ts';
import { runNoticeBody } from '../src/github/comments.ts';

type Reply = { content: string | null; finishReason: 'length' | 'stop' };

async function reviewFixture(replies: Reply[]) {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-review-output-'));
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    const payload = { id: `reply-${requests.length}`, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: reply.content, ...(reply.content === null ? { reasoning_content: 'still thinking' } : {}) }, finish_reason: reply.finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 6000, total_tokens: 6010 } };
    if (body.stream) {
      response.end(`data: ${JSON.stringify({ id: payload.id, model: payload.model, choices: [{ index: 0,
        delta: reply.content === null ? { reasoning_content: 'still thinking' } : { content: reply.content }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: payload.id, model: payload.model, choices: [{ index: 0,
          delta: {}, finish_reason: reply.finishReason }], usage: payload.usage })}\n\ndata: [DONE]\n\n`);
    } else response.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'fixture-key';
  process.env.ZAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { root, requests, trace: new Trace(join(root, 'trace')), previous, server };
}

test('opaque review stops with a truncation error and does not retry after length', async () => {
  const fixture = await reviewFixture([{ content: null, finishReason: 'length' }]);
  try {
    await assert.rejects(
      runReview({ runId: 'length-review', trace: fixture.trace, opaqueOutcome: true,
        ws: { path: fixture.root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } },
      { task: 'review fixture' }),
      (error: any) => error?.code === 'model_output_truncated',
    );
    assert.equal(fixture.requests.length, 1, 'a length result must not enter a format retry');
  } finally {
    if (fixture.previous.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = fixture.previous.key;
    if (fixture.previous.url === undefined) delete process.env.ZAI_BASE_URL; else process.env.ZAI_BASE_URL = fixture.previous.url;
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('opaque review treats partial content with length as truncated', async () => {
  const fixture = await reviewFixture([{ content: '{"summary":"partial"', finishReason: 'length' }]);
  try {
    await assert.rejects(
      runReview({ runId: 'partial-review', trace: fixture.trace, opaqueOutcome: true,
        ws: { path: fixture.root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } },
      { task: 'review fixture' }),
      (error: any) => error?.code === 'model_output_truncated',
    );
    assert.equal(fixture.requests.length, 1);
  } finally {
    if (fixture.previous.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = fixture.previous.key;
    if (fixture.previous.url === undefined) delete process.env.ZAI_BASE_URL; else process.env.ZAI_BASE_URL = fixture.previous.url;
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('opaque review delivers plain Markdown as-is without a retry', async () => {
  const markdown = '## 评审\n\n改动看起来是安全的，没有发现可操作缺陷。';
  const fixture = await reviewFixture([{ content: markdown, finishReason: 'stop' }]);
  try {
    assert.deepEqual(await runReview({ runId: 'valid-review', trace: fixture.trace, opaqueOutcome: true,
      ws: { path: fixture.root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } },
    { task: 'review fixture' }), { outcome: 'finished', body: markdown });
    assert.equal(fixture.requests.length, 1, 'opaque text must not trigger a format retry');
  } finally {
    if (fixture.previous.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = fixture.previous.key;
    if (fixture.previous.url === undefined) delete process.env.ZAI_BASE_URL; else process.env.ZAI_BASE_URL = fixture.previous.url;
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('opaque review treats JSON-looking and malformed JSON-looking output as text', async () => {
  const jsonLooking = '{"summary":"Looks good","recommendation":"approve","findings":[],"limitations":[]}';
  const malformed = '{"summary":"partial","findings":[';
  const fixture = await reviewFixture([
    { content: jsonLooking, finishReason: 'stop' },
    { content: malformed, finishReason: 'stop' },
  ]);
  try {
    const options = { runId: 'opaque-review', trace: fixture.trace, opaqueOutcome: true as const,
      ws: { path: fixture.root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } };
    assert.deepEqual(await runReview(options, { task: 'review fixture' }), { outcome: 'finished', body: jsonLooking });
    assert.deepEqual(await runReview(options, { task: 'review fixture' }), { outcome: 'finished', body: malformed },
      'incomplete JSON is still non-empty text and must not be schema-rejected');
    assert.equal(fixture.requests.length, 2, 'opaque output must not trigger a format retry');
  } finally {
    if (fixture.previous.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = fixture.previous.key;
    if (fixture.previous.url === undefined) delete process.env.ZAI_BASE_URL; else process.env.ZAI_BASE_URL = fixture.previous.url;
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('provider stop with no text becomes a typed protocol failure', async () => {
  const fixture = await reviewFixture([{ content: '', finishReason: 'stop' }]);
  try {
    await assert.rejects(
      runReview({ runId: 'empty-review', trace: fixture.trace, opaqueOutcome: true,
        ws: { path: fixture.root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } },
      { task: 'review fixture' }),
      (error: any) => error?.code === 'agent_final_response_missing' && error?.name === 'AgentFinalResponseMissing',
    );
  } finally {
    if (fixture.previous.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = fixture.previous.key;
    if (fixture.previous.url === undefined) delete process.env.ZAI_BASE_URL; else process.env.ZAI_BASE_URL = fixture.previous.url;
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

test('truncation notice identifies a normal model connection and points to /readme retry', () => {
  const body = runNoticeBody({ run_id: 'truncated-run', head: 'head', status: 'model_output_truncated', phase: 'review_running',
    reason: '模型连接正常，但单次输出上限已耗尽。', mentions: ['owner'] });
  assert.match(body, /模型输出被截断，尚未完成/);
  assert.match(body, /模型连接正常/);
  assert.doesNotMatch(body, /Provider unavailable/);
  assert.match(body, /`\/readme`/);
  assert.match(body, /无需改用 `\/review`/);
});
