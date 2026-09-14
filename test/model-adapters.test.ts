import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModel } from '../src/harness/model.ts';
import { Trace } from '../src/harness/trace.ts';
import { SecretStore } from '../src/control-plane/secrets.ts';
import { providerAdapters } from '../src/models/registry.ts';
import { validateCommandSnapshot } from '../src/control-plane/snapshots.ts';
import type { ProviderType } from '../src/control-plane/types.ts';

type CapturedRequest = { body: Record<string, any>; headers: Record<string, string | string[] | undefined> };

const FIXTURE_WAIT_MS = 5_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, description: string, timeoutMs = FIXTURE_WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settlementWithin(promise: Promise<unknown>, timeoutMs = FIXTURE_WAIT_MS): Promise<'fulfilled' | 'rejected' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed_out'>(resolve => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => 'fulfilled' as const, () => 'rejected' as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listen(handler: (request: CapturedRequest, response: import('node:http').ServerResponse) => void | Promise<void>) {
  const requests: CapturedRequest[] = [];
  const requestReceived = deferred<CapturedRequest>();
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const captured = { body: JSON.parse(raw) as Record<string, any>, headers: request.headers };
    requests.push(captured);
    requestReceived.resolve(captured);
    await handler(captured, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    requests,
    requestReceived: requestReceived.promise,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => bounded(new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }), 'fixture close'),
  };
}

function callOptions(abortSignal?: AbortSignal) {
  return { prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture request' }] }], abortSignal } as any;
}

function responseBody(model: string) {
  return JSON.stringify({ id: `fixture-${model}`, object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

test('all five provider adapters use independent model selections and isolate request extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-model-adapters-'));
  const fixture = await listen(async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(responseBody(request.body.model));
  });
  const store = new SecretStore(root);
  const configurations: Array<{ type: ProviderType; model: string; options: Record<string, string | number | boolean>; secret: string }> = [
    { type: 'zhipu', model: 'glm-model-a', options: { reasoning_effort: 'low' }, secret: 'secret-zhipu' },
    { type: 'deepseek', model: 'deepseek-model', options: { reasoning_effort: 'high', thinking: true }, secret: 'secret-deepseek' },
    { type: 'openrouter', model: 'vendor/model', options: { reasoning_effort: 'medium', http_referer: 'https://patchpaw.test', x_openrouter_title: 'PatchPaw' }, secret: 'secret-openrouter' },
    { type: 'kimi', model: 'kimi-model', options: { thinking: false }, secret: 'secret-kimi' },
    { type: 'qwen', model: 'qwen-model', options: { enable_thinking: true, thinking_budget: 128, reasoning_effort: 'high' }, secret: 'secret-qwen' },
  ];
  try {
    assert.deepEqual(providerAdapters().map(adapter => adapter.type).sort(), ['deepseek', 'kimi', 'openrouter', 'qwen', 'zhipu']);
    const traces: Trace[] = [];
    const handles = [];
    for (const [index, config] of configurations.entries()) {
      const providerId = `provider-${index}`;
      await store.writeProviderSecret(providerId, config.secret);
      const trace = new Trace(join(root, `trace-${config.type}`)); traces.push(trace);
      handles.push({ config, handle: createModel(trace, config.type, {
        provider: { id: providerId, type: config.type, baseUrl: fixture.baseUrl, credentialRef: `slot:provider/${providerId}`, requestOptions: config.options },
        model: { id: `model-${index}`, identifier: config.model }, runtimeHome: root,
      }) });
    }
    for (const { config, handle } of handles) {
      const result = await handle.model.doGenerate(callOptions());
      assert.equal(result.content[0]?.type, 'text');
      assert.equal((result.content[0] as any).text, 'fixture response');
      const request = fixture.requests.at(-1)!;
      assert.equal(request.body.model, config.model);
      assert.equal(request.headers.authorization, `Bearer ${config.secret}`);
      if (config.type === 'zhipu') {
        assert.deepEqual(request.body.thinking, { type: 'enabled' });
        assert.equal(request.body.reasoning_effort, 'low');
        assert.equal(request.body.enable_thinking, undefined);
      }
      if (config.type === 'openrouter') {
        assert.equal(request.body.thinking, undefined);
        assert.equal(request.headers['http-referer'], 'https://patchpaw.test');
        assert.equal(request.headers['x-openrouter-title'], 'PatchPaw');
      }
      if (config.type === 'kimi') assert.deepEqual(request.body.thinking, { type: 'disabled' });
      if (config.type === 'qwen') {
        assert.equal(request.body.enable_thinking, true);
        assert.equal(request.body.thinking_budget, 128);
        assert.equal(request.body.reasoning_effort, 'high');
        assert.equal(request.body.thinking, undefined);
      }
      if (config.type === 'deepseek') assert.deepEqual(request.body.thinking, { type: 'enabled' });
    }
    const zhipuBody = fixture.requests.find(request => request.body.model === 'glm-model-a')!.body;
    const qwenBody = fixture.requests.find(request => request.body.model === 'qwen-model')!.body;
    assert.equal(zhipuBody.enable_thinking, undefined);
    assert.equal(qwenBody.thinking, undefined);
    const traceText = await Promise.all(traces.map(trace => readFile(join(trace.dir, 'trace.jsonl'), 'utf8')));
    assert.equal(traceText.some(text => text.includes('secret-')), false);
  } finally {
    await fixture.close();
  }
});

test('resolved model identity wins over env model and credential is loaded at call time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-model-selection-'));
  const fixture = await listen(async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(responseBody(request.body.model));
  });
  const previous = process.env.ZAI_MODEL;
  process.env.ZAI_MODEL = 'must-not-be-used';
  const providerId = 'selection-provider'; const store = new SecretStore(root);
  try {
    const trace = new Trace(join(root, 'trace'));
    const handle = createModel(trace, 'resolved-selection', { provider: { id: providerId, type: 'zhipu', baseUrl: fixture.baseUrl,
      credentialRef: `slot:provider/${providerId}`, requestOptions: {} }, model: { id: 'resolved-model', identifier: 'resolved-model-id' }, runtimeHome: root });
    await store.writeProviderSecret(providerId, 'initial-secret');
    await handle.model.doGenerate(callOptions());
    assert.equal(fixture.requests[0].body.model, 'resolved-model-id');
    assert.equal(fixture.requests[0].headers.authorization, 'Bearer initial-secret');
    await store.writeProviderSecret(providerId, 'rotated-secret');
    await handle.model.doGenerate(callOptions());
    assert.equal(fixture.requests[1].headers.authorization, 'Bearer rotated-secret');
    assert.equal(handle.isUnavailable(), false);
    const traceText = await readFile(join(trace.dir, 'trace.jsonl'), 'utf8');
    assert.equal(traceText.includes('initial-secret'), false);
    assert.equal(traceText.includes('rotated-secret'), false);
  } finally {
    if (previous === undefined) delete process.env.ZAI_MODEL; else process.env.ZAI_MODEL = previous;
    await fixture.close();
  }
});

test('all adapters use the unified output budget and keep explicit provider caps singular', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-model-budget-'));
  const fixture = await listen(async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(responseBody(request.body.model));
  });
  const store = new SecretStore(root);
  try {
    await store.writeProviderSecret('budget-provider', 'budget-secret');
    for (const [index, type] of providerAdapters().map(adapter => adapter.type).entries()) {
      const handle = createModel(new Trace(join(root, `default-${type}`)), 'budget-default', {
        provider: { id: 'budget-provider', type, baseUrl: fixture.baseUrl, credentialRef: 'slot:provider/budget-provider', requestOptions: {} },
        model: { id: `default-${index}`, identifier: `${type}-model` }, runtimeHome: root,
      });
      await handle.model.doGenerate(callOptions());
      const body = fixture.requests.at(-1)!.body;
      assert.equal(body.max_tokens, 60_000, `${type} uses the unified default`);
      assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.max_output_tokens, undefined);
    }

    const explicit = createModel(new Trace(join(root, 'explicit-budget')), 'budget-explicit', {
      provider: { id: 'budget-provider', type: 'deepseek', baseUrl: fixture.baseUrl, credentialRef: 'slot:provider/budget-provider',
        requestOptions: { max_completion_tokens: 256 } },
      model: { id: 'explicit-model', identifier: 'deepseek-model' }, runtimeHome: root,
    });
    await explicit.model.doGenerate({ ...callOptions(), maxOutputTokens: 60_000 } as any);
    const explicitBody = fixture.requests.at(-1)!.body;
    assert.equal(explicitBody.max_tokens, undefined);
    assert.equal(explicitBody.max_completion_tokens, 256);
    assert.equal(explicitBody.max_output_tokens, undefined);

    const capability = createModel(new Trace(join(root, 'capability-budget')), 'budget-capability', {
      provider: { id: 'budget-provider', type: 'qwen', baseUrl: fixture.baseUrl, credentialRef: 'slot:provider/budget-provider', requestOptions: {} },
      model: { id: 'capability-model', identifier: 'qwen-model', maxOutputTokens: 4096 }, runtimeHome: root,
    });
    await capability.model.doGenerate(callOptions());
    assert.equal(fixture.requests.at(-1)!.body.max_tokens, 4096);
  } finally { await fixture.close(); }
});

test('one provider can serve independent resolved models for separate commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-model-same-provider-'));
  const fixture = await listen(async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(responseBody(request.body.model));
  });
  const providerId = 'shared-provider'; const store = new SecretStore(root);
  try {
    await store.writeProviderSecret(providerId, 'shared-secret');
    const provider = { id: providerId, type: 'zhipu' as const, baseUrl: fixture.baseUrl,
      credentialRef: `slot:provider/${providerId}`, enabled: true };
    const ci = createModel(new Trace(join(root, 'ci-trace')), 'ci', { provider: { ...provider, requestOptions: { reasoning_effort: 'low' } },
      model: { id: 'ci-model', identifier: 'model-a' }, runtimeHome: root });
    const review = createModel(new Trace(join(root, 'review-trace')), 'review', { provider: { ...provider, requestOptions: { reasoning_effort: 'high' } },
      model: { id: 'review-model', identifier: 'model-b' }, runtimeHome: root });
    await ci.model.doGenerate(callOptions());
    await review.model.doGenerate(callOptions());
    assert.deepEqual(fixture.requests.map(request => request.body.model), ['model-a', 'model-b']);
    assert.equal(fixture.requests[0].body.reasoning_effort, 'low');
    assert.equal(fixture.requests[1].body.reasoning_effort, 'high');
  } finally { await fixture.close(); }
});

test('durable snapshot validation accepts the stage-04 adapter option union', () => {
  assert.doesNotThrow(() => validateCommandSnapshot({
    schema_version: 'patchpaw.command-snapshot.v1', snapshot_id: 'snapshot-options', execution_id: 'execution-options',
    repository: { id: 'repo-options', full_name: 'owner/repo' }, target: 'conversation', template_type: 'conversation',
    conversation_profile: { id: 'profile-options', revision: 1, permission: 'read_only', enabled: true },
    composition: { output_contract: { kind: 'human_markdown' }, parts: [] },
    provider: { id: 'qwen-provider', type: 'qwen', display_name: 'Qwen', base_url: 'https://provider.test/v1', revision: 1,
      credential_ref: 'slot:provider/qwen-provider', model: { id: 'qwen-model', identifier: 'qwen-plus', display_name: 'Qwen Plus', revision: 1 },
      request_options: { enable_thinking: true, thinking_budget: 128, max_completion_tokens: 256, presence_penalty: 0.1 } },
    toolset_version: 'patchpaw-toolset-v1', snapshot_created_at: new Date().toISOString(),
  }));
});

test('transport retries one identical exchange, rejects truncated SSE, and preserves cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-model-transport-'));
  let attempt = 0;
  const fixture = await listen(async (request, response) => {
    attempt++;
    if (attempt === 1) { response.writeHead(503, { 'retry-after': '0' }); response.end('temporary'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'stream', model: request.body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'stream', model: request.body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const providerId = 'transport-provider'; await new SecretStore(root).writeProviderSecret(providerId, 'transport-secret');
  const handle = createModel(new Trace(join(root, 'retry-trace')), 'retry', { provider: { id: providerId, type: 'zhipu', baseUrl: fixture.baseUrl,
    credentialRef: `slot:provider/${providerId}`, requestOptions: {} }, model: { id: 'retry-model', identifier: 'retry-model' }, runtimeHome: root });
  try {
    const response = await handle.model.doStream(callOptions());
    for await (const _chunk of response.stream) { /* consume */ }
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[0].body, fixture.requests[1].body);
    assert.equal(handle.isUnavailable(), false);
  } finally { await fixture.close(); }

  await t.test('truncated stream reaches provider unavailable without succeeding', async () => {
    let calls = 0;
    const truncated = await listen(async (_request, response) => {
      calls++; response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' }); response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    const brokenId = 'broken-provider'; await new SecretStore(root).writeProviderSecret(brokenId, 'broken-secret');
    const broken = createModel(new Trace(join(root, 'broken-trace')), 'broken', { provider: { id: brokenId, type: 'zhipu', baseUrl: truncated.baseUrl,
      credentialRef: `slot:provider/${brokenId}`, requestOptions: {} }, model: { id: 'broken-model', identifier: 'broken-model' }, runtimeHome: root });
    try {
      await assert.rejects(Promise.resolve(broken.model.doStream(callOptions())), (error: any) => /Provider unavailable/.test(String(error?.message ?? error)) || error?.cause?.name === 'ProviderUnavailable');
      assert.equal(calls, 4);
      assert.equal(broken.isUnavailable(), true);
    } finally { await truncated.close(); }
  });

  await t.test('caller cancellation aborts the request instead of retrying', async () => {
    const responseRelease = deferred<void>();
    const cancelled = await listen(async (_request, response) => {
      await responseRelease.promise;
      if (response.destroyed) return;
      response.writeHead(200); response.end(responseBody('cancelled'));
    });
    const cancelId = 'cancel-provider'; await new SecretStore(root).writeProviderSecret(cancelId, 'cancel-secret');
    const cancelledHandle = createModel(new Trace(join(root, 'cancel-trace')), 'cancel', { provider: { id: cancelId, type: 'zhipu', baseUrl: cancelled.baseUrl,
      credentialRef: `slot:provider/${cancelId}`, requestOptions: {} }, model: { id: 'cancel-model', identifier: 'cancel-model' }, runtimeHome: root });
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => cancelledHandle.model.doGenerate(callOptions(controller.signal)));
    void pending.catch(() => undefined);
    try {
      await bounded(cancelled.requestReceived, 'provider request receipt');
      controller.abort(new Error('fixture cancelled'));
      assert.equal(await settlementWithin(pending), 'rejected', 'cancelled request must reject');
      assert.equal(cancelled.requests.length, 1);
      assert.equal(cancelledHandle.isUnavailable(), false);
    } finally {
      controller.abort(new Error('fixture cancelled during cleanup'));
      responseRelease.resolve();
      await settlementWithin(pending);
      await cancelled.close();
    }
  });

  await t.test('caller cancellation before send does not issue a provider request', async () => {
    const beforeSend = await listen(async (_request, response) => {
      response.writeHead(200); response.end(responseBody('cancelled-before-send'));
    });
    const cancelId = 'cancel-before-send-provider'; await new SecretStore(root).writeProviderSecret(cancelId, 'cancel-before-send-secret');
    const cancelledHandle = createModel(new Trace(join(root, 'cancel-before-send-trace')), 'cancel-before-send', { provider: { id: cancelId, type: 'zhipu', baseUrl: beforeSend.baseUrl,
      credentialRef: `slot:provider/${cancelId}`, requestOptions: {} }, model: { id: 'cancel-before-send-model', identifier: 'cancel-before-send-model' }, runtimeHome: root });
    const controller = new AbortController();
    controller.abort(new Error('cancel before provider send'));
    const pending = Promise.resolve().then(() => cancelledHandle.model.doGenerate(callOptions(controller.signal)));
    void pending.catch(() => undefined);
    try {
      assert.equal(await settlementWithin(pending), 'rejected', 'pre-send cancellation must reject');
      assert.equal(beforeSend.requests.length, 0);
      assert.equal(cancelledHandle.isUnavailable(), false);
    } finally {
      await settlementWithin(pending);
      await beforeSend.close();
    }
  });

  await t.test('2xx provider error envelopes become retryable upstream failures', async () => {
    let calls = 0;
    const envelope = await listen(async (_request, response) => {
      calls++; response.writeHead(200, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { code: 502, message: 'Service temporarily overloaded', metadata: { error_type: 'provider_unavailable' } } }));
    });
    const envelopeId = 'envelope-provider'; await new SecretStore(root).writeProviderSecret(envelopeId, 'envelope-secret');
    const envelopeTrace = new Trace(join(root, 'envelope-trace'));
    const envelopeHandle = createModel(envelopeTrace, 'provider-envelope', { provider: { id: envelopeId, type: 'openrouter', baseUrl: envelope.baseUrl,
      credentialRef: `slot:provider/${envelopeId}`, requestOptions: {} }, model: { id: 'envelope-model', identifier: 'openrouter/free' }, runtimeHome: root });
    try {
      let terminalError: any;
      await assert.rejects(Promise.resolve(envelopeHandle.model.doGenerate(callOptions())), (error: any) => {
        terminalError = error;
        return !/Invalid JSON response/.test(String(error?.message ?? error));
      });
      assert.equal(calls, 4);
      assert.equal(envelopeHandle.isUnavailable(), true);
      const providerFailure = terminalError?.cause?.name === 'ProviderUnavailable' ? terminalError.cause : terminalError;
      assert.equal(providerFailure.name, 'ProviderUnavailable');
      assert.equal(providerFailure.details.failureCode, 'provider_upstream_unavailable');
      assert.equal(providerFailure.details.status, 502);
      assert.equal(providerFailure.details.attempts, 4);
      const events = (await readFile(join(envelopeTrace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.event === 'provider_retry').length, 3);
      assert.equal(events.filter(event => event.event === 'model_response').at(-1)?.status, 200);
    } finally { await envelope.close(); }
  });

  await t.test('provider error evidence omits credential and authorization material', async () => {
    const errorFixture = await listen(async (_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json', 'x-fixture-secret': 'error-secret' });
      response.end(JSON.stringify({ error: 'invalid key error-secret' }));
    });
    const errorId = 'error-provider'; const errorSecret = 'error-secret';
    await new SecretStore(root).writeProviderSecret(errorId, errorSecret);
    const errorTrace = new Trace(join(root, 'error-trace'));
    const errorHandle = createModel(errorTrace, 'provider-error', { provider: { id: errorId, type: 'zhipu', baseUrl: errorFixture.baseUrl,
      credentialRef: `slot:provider/${errorId}`, requestOptions: {} }, model: { id: 'error-model', identifier: 'error-model' }, runtimeHome: root });
    try {
      await assert.rejects(Promise.resolve(errorHandle.model.doGenerate(callOptions())));
      assert.equal(errorFixture.requests.length, 1);
      const traceText = await readFile(join(errorTrace.dir, 'trace.jsonl'), 'utf8');
      assert.equal(traceText.includes(errorSecret), false);
      assert.equal(traceText.includes('Authorization'), false);
      assert.equal(traceText.includes('Bearer'), false);
    } finally { await errorFixture.close(); }
  });
});
