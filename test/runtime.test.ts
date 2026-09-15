import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createTaskSession, isGitPushCommand } from '../src/harness/runtime.ts';
import { Trace } from '../src/harness/trace.ts';
import { git } from '../src/workspace/git.ts';

test('Git push command detection covers shell and git option forms', () => {
  assert.equal(isGitPushCommand('git push origin HEAD:feature'), true);
  assert.equal(isGitPushCommand('git -C /workspace --git-dir repo push --force'), true);
  assert.equal(isGitPushCommand('printf "git push"'), false);
  assert.equal(isGitPushCommand('git status && printf done'), false);
});

test('Review and Conversation can read the exact fetched current base without changing the PR workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-current-base-tools-'));
  const repo = join(root, 'repo'), workspace = join(root, 'workspace'); await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Fixture']); await git(repo, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(repo, 'shared.txt'), 'common\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base']);
  await git(repo, ['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'pr-only.txt'), 'PR head\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'PR']);
  const prHead = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['checkout', 'main']);
  await writeFile(join(repo, 'base-only.txt'), 'current base\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'current base']);
  const currentBase = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['worktree', 'add', '--detach', workspace, prHead]);

  const bodies: any[] = []; let step = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const tool = step === 0 ? { name: 'read_current_base_file', arguments: JSON.stringify({ path: 'base-only.txt' }) }
      : step === 2 ? { name: 'grep_current_base', arguments: JSON.stringify({ query: 'current base' }) }
        : step === 3 ? { name: 'list_current_base_files', arguments: '{}' }
          : step === 4 ? { name: 'grep_current_base', arguments: JSON.stringify({ query: 'definitely absent' }) }
            : step === 6 ? { name: 'grep_current_base', arguments: JSON.stringify({ query: 'current base' }) } : null;
    step++;
    const delta = tool ? { tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: tool }] } : { content: 'done' };
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${step}`, type: 'function', function: tool }] }
      : { role: 'assistant', content: 'done' };
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `response-${step}`, model: 'fixture', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: `response-${step}`, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: `response-${step}`, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const previous = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'fixture-provider-secret'; process.env.ZAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  const ws = { path: workspace, initialHead: prHead, mainSha: currentBase, unmerged: [], mergePending: false };
  const base = { ref: 'main', sha: currentBase };
  try {
    const review = createTaskSession({ task: 'review', prompt: 'Use the current-base tools.', runId: 'review', trace: new Trace(join(root, 'review-trace')), ws, currentBase: base });
    try { assert.equal(await review.turn('Read the current base file.'), 'done'); }
    finally { await review.close(); }
    const conversation = createTaskSession({ task: 'conversation', prompt: 'Use the current-base tools.', runId: 'conversation', trace: new Trace(join(root, 'conversation-trace')), ws, currentBase: base, readOnly: true });
    try { assert.equal(await conversation.turn('Search the current base.'), 'done'); }
    finally { await conversation.close(); }
    const failedRevision = createTaskSession({ task: 'conversation', prompt: 'Use the current-base tools.', runId: 'failed-revision', trace: new Trace(join(root, 'failed-revision-trace')), ws, currentBase: { ref: 'main', sha: 'f'.repeat(40) }, readOnly: true });
    try { assert.equal(await failedRevision.turn('Search the current base.'), 'done'); }
    finally { await failedRevision.close(); }
    for (const request of [bodies[0], bodies[2]]) {
      const names = request.tools.map((tool: any) => tool.function.name);
      assert.ok(names.includes('read_current_base_file'));
      assert.ok(names.includes('grep_current_base'));
      assert.ok(names.includes('list_current_base_files'));
    }
    assert.match(JSON.stringify(bodies[1].messages), /current base/);
    assert.match(JSON.stringify(bodies[3].messages), /current base/);
    assert.match(JSON.stringify(bodies[1].messages), new RegExp(currentBase));
    assert.match(JSON.stringify(bodies[4].messages), /base-only\.txt/);
    const toolContents = bodies.flatMap(body => body.messages.filter((message: any) => message.role === 'tool').map((message: any) => String(message.content)));
    const structuredTools = toolContents.flatMap(content => { try { return [JSON.parse(content)]; } catch { return []; } });
    const matched = structuredTools.find((tool: any) => tool.content?.includes('base-only.txt:1:current base'));
    assert.ok(matched, 'grep with a match returns the matching line');
    assert.match(matched.content, /base-only\.txt:1:current base/);
    assert.equal(matched.revision_sha, currentBase);
    const noMatch = structuredTools.find((tool: any) => tool.content === '');
    assert.ok(noMatch, 'grep with no matches returns a structured empty result');
    assert.equal(noMatch.content, '');
    assert.equal(noMatch.total_chars, 0);
    assert.equal(noMatch.revision_sha, currentBase);
    assert.ok(toolContents.some(content => /Git grep failed|exit 128/.test(content)), 'Git grep failure is surfaced to the Agent');
    await assert.rejects(readFile(join(workspace, 'base-only.txt'), 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(join(workspace, 'pr-only.txt'), 'utf8'), 'PR head\n');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of [['ZAI_API_KEY', previous.key], ['ZAI_BASE_URL', previous.url]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test('native tool loop preserves low-effort reasoning, repeated reads and edit/history across provider retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-test-'));
  await writeFile(join(root, 'sample.txt'), 'before\n');
  const bodies: any[] = [];
  let toolStep = 0, injected = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (toolStep === 4 && !injected) { injected = true; res.writeHead(503, { 'Retry-After': '0' }); res.end('temporarily unavailable'); return; }
    const tool = toolStep < 3 ? { name: 'mastra_workspace_read_file', arguments: JSON.stringify({ path: 'sample.txt', showLineNumbers: true }) }
      : toolStep === 3 ? { name: 'mastra_workspace_edit_file', arguments: JSON.stringify({ path: 'sample.txt', old_string: 'before', new_string: 'after', replace_all: false }) }
        : toolStep === 4 ? { name: 'mastra_workspace_read_file', arguments: JSON.stringify({ path: 'sample.txt', showLineNumbers: true }) } : null;
    const reasoning = `Fixture reasoning step ${toolStep}`;
    const delta = tool ? { reasoning_content: reasoning, tool_calls: [{ index: 0, id: `call-${toolStep}`, type: 'function', function: tool }] } : { content: 'Finished' };
    toolStep++;
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0,
        message: { role: 'assistant', content: tool ? null : 'Finished', ...(tool ? { reasoning_content: reasoning, tool_calls: [{ id: `call-${toolStep}`, type: 'function', function: tool }] } : {}) },
        finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  process.env.ZAI_API_KEY = 'fixture-provider-secret';
  process.env.ZAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ZAI_REASONING_EFFORT = 'low';
  const trace = new Trace(join(root, 'trace'));
  const session = createTaskSession({ task: 'fixture', prompt: 'Use tools.', runId: 'fixture', trace,
    ws: { path: root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } });
  try {
    assert.equal(await session.turn('Read repeatedly, edit, read.'), 'Finished');
    assert.equal(await readFile(join(root, 'sample.txt'), 'utf8'), 'after\n');
    assert.deepEqual(bodies[4], bodies[5]);
    assert.ok(bodies.every(body => body.reasoning_effort === 'low' && body.thinking.type === 'enabled'));
    const assistant = bodies[1].messages.find((message: any) => message.role === 'assistant' && message.tool_calls?.length);
    assert.equal(assistant.reasoning_content, 'Fixture reasoning step 0', 'reasoning is returned with tool-call history');
    const events = (await readFile(join(trace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.event === 'provider_retry').length, 1);
    assert.equal(events.filter(e => e.event === 'tool_end' && e.tool === 'mastra_workspace_read_file').length, 4);
    assert.equal(JSON.stringify(events).includes('fixture-provider-secret'), false);
  } finally { await session.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('large tool payloads and provider wire traffic stay bounded in durable artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-retention-test-'));
  const payload = 'X'.repeat(500_000);
  let toolStep = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tool = toolStep === 0 ? { name: 'big_evidence', arguments: '{}' } : null;
    const delta = tool ? { tool_calls: [{ index: 0, id: `call-${toolStep}`, type: 'function', function: tool }] } : { content: 'Finished' };
    toolStep++;
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0,
        message: { role: 'assistant', content: tool ? null : 'Finished', ...(tool ? { tool_calls: [{ id: `call-${toolStep}`, type: 'function', function: tool }] } : {}) },
        finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'test', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  process.env.ZAI_API_KEY = 'fixture-provider-secret';
  process.env.ZAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  const trace = new Trace(join(root, 'trace'));
  const session = createTaskSession({ task: 'fixture', prompt: 'Call the tool.', runId: 'fixture', trace,
    ws: { path: root, initialHead: '', mainSha: '', unmerged: [], mergePending: false },
    tools: { big_evidence: createTool({ id: 'big_evidence', description: 'Return one large fixture payload.',
      inputSchema: z.object({}), execute: async () => payload }) } });
  try {
    assert.equal(await session.turn('Call big_evidence once, then finish.'), 'Finished');
    const events = (await readFile(join(trace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const end = events.find(e => e.event === 'tool_end' && e.tool === 'big_evidence')!;
    assert.ok(end.result_chars >= 500_000, 'the trace records the true payload size');
    assert.ok(end.output_excerpt.length <= 4000, 'persisted excerpt is bounded');
    assert.match(end.output_sha256, /^[a-f0-9]{64}$/, 'fingerprint survives for debugging');
    assert.equal(end.output, undefined, 'full tool output is never persisted');
    const requests = events.filter(e => e.event === 'model_request');
    assert.ok(requests.length >= 2, 'the tool result travels in the next request body');
    for (const request of requests) {
      assert.equal(request.body, undefined, 'full request wire payload is never persisted');
      assert.ok(request.body_excerpt.length <= 4000);
      assert.ok(request.body_chars > 0);
    }
    assert.ok(requests.some(r => r.body_chars >= 500_000), 'the large in-flight body is measured, not stored');
    for (const response of events.filter(e => e.event === 'model_response')) {
      assert.equal(response.raw, undefined);
      assert.ok(response.raw_excerpt.length <= 4000);
    }
    const raw = await readFile(join(trace.dir, 'trace.jsonl'), 'utf8');
    assert.ok(raw.length < 100_000, `trace stays bounded despite a 500KB payload (actual ${raw.length})`);
    assert.equal(raw.includes('fixture-provider-secret'), false);
    // The per-turn artifact is small metadata; the full history belongs to PR Memory only.
    const turnFiles = (await readdir(trace.dir)).filter(name => /-turn-\d+\.json$/.test(name));
    assert.equal(turnFiles.length, 1);
    const turn = JSON.parse(await readFile(join(trace.dir, turnFiles[0]), 'utf8'));
    assert.deepEqual(Object.keys(turn).sort(), ['finishReason', 'maxOutputTokens', 'runId', 'text', 'usage']);
  } finally { await session.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
