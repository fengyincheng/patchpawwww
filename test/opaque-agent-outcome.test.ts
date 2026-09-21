// Fresh-run regression suite: every task uses the opaque natural-language outcome contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { Trace } from '../src/harness/trace.ts';
import { runConflict } from '../src/tasks/conflict/agent.ts';
import { runCIRepair } from '../src/tasks/ci-repair/agent.ts';
import { runRepair } from '../src/tasks/repair.ts';
import { runCustom } from '../src/tasks/custom/agent.ts';
import { runReview } from '../src/tasks/review/agent.ts';
import { budget } from '../src/harness/budget.ts';
import { setTimeout } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { finalAnswerTools } from '../src/harness/agent-turn-lifecycle.ts';
import { runtimeExecutionFromSnapshot, type TaskOptions } from '../src/harness/runtime.ts';
import type { CommandSnapshot } from '../src/control-plane/snapshots.ts';

type Reply = { text?: string; tool?: string; args?: Record<string, unknown>; httpStatus?: number; delayMs?: number };
type FixtureTool = { function: { name: string } };
type FixtureMessage = { role?: string; content?: unknown };
type FixtureRequest = { tools?: FixtureTool[]; messages?: FixtureMessage[] };
type TraceRecord = { event?: string; guidance_injected?: boolean; guidance_source?: string };
type AgentFixtureOptions = Awaited<ReturnType<typeof fixture>> & {
  execution?: TaskOptions['execution'];
  finalAnswerCapability?: TaskOptions['finalAnswerCapability'];
  tools?: TaskOptions['tools'];
};

function toolNames(request: FixtureRequest | undefined) {
  return (request?.tools ?? []).map(tool => tool.function.name);
}

async function traceEvents(trace: Trace) {
  const raw = await readFile(join(trace.dir, 'trace.jsonl'), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceRecord);
}

function executionWithoutRuntimeBudget(baseUrl: string, templateType: CommandSnapshot['template_type']): ReturnType<typeof runtimeExecutionFromSnapshot> {
  const snapshot: CommandSnapshot = {
    schema_version: 'patchpaw.command-snapshot.v1', snapshot_id: `snapshot-${templateType}`, execution_id: `execution-${templateType}`,
    repository: { id: 'fixture-repository', full_name: 'owner/fixture' }, target: 'command', template_type: templateType,
    command: { id: `command-${templateType}`, slash_name: `/${templateType}`, revision: 1, execution_type: templateType, permission: 'read_write', enabled: true },
    composition: { output_contract: { kind: 'none' }, parts: [{ kind: 'prompt', position: 1, asset_id: 'fixture-prompt', slug: 'fixture-prompt', role: 'main', revision: 1, sha256: 'fixture', content: 'Return a natural-language answer.' }] },
    output_budget: { requested: 60_000, effective: 60_000, source: 'default', wire_key: 'max_tokens' },
    provider: { id: 'fixture-provider', type: 'zhipu', display_name: 'Fixture', base_url: baseUrl, revision: 1,
      credential_ref: 'env:ZAI_API_KEY', model: { id: 'fixture-model', identifier: 'fixture-model', display_name: 'Fixture', revision: 1 }, request_options: {} },
    toolset_version: 'patchpaw-toolset-v1', snapshot_created_at: new Date(0).toISOString(),
  };
  return runtimeExecutionFromSnapshot(snapshot, process.cwd(), { ZAI_API_KEY: 'fixture-key' });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'patchpaw-verification-test-'));
  const root = join(directory, 'workspace'); await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(root, 'sample.txt'), 'before\n');
  await git(root, ['add', 'sample.txt']); await git(root, ['commit', '-m', 'initial']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ws: { path: root, initialHead: head, mainSha: head, unmerged: [], mergePending: false },
    trace: new Trace(join(directory, 'trace')), runId: 'fixture' };
}
async function withProvider(replies: Reply[], run: (requests: FixtureRequest[], baseUrl: string) => Promise<void>) {
  const requests: FixtureRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw) as FixtureRequest);
    const reply = replies[requests.length - 1] ?? { text: 'Done.' };
    if (reply.delayMs) await setTimeout(reply.delayMs);
    if (reply.httpStatus) { res.writeHead(reply.httpStatus); res.end('fixture provider failure'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: `response-${requests.length}`, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: reply.text ?? (reply.tool ? '' : 'Here is my explanation, not a JSON document.'),
        ...(reply.tool ? { tool_calls: [{ id: `call-${requests.length}`, type: 'function',
          function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : {}) },
      finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'fixture-key';
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  process.env.ZAI_BASE_URL = baseUrl;
  try { await run(requests, baseUrl); }
  finally {
    for (const [name, value] of [['ZAI_API_KEY', previous.key], ['ZAI_BASE_URL', previous.url]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const runGenericRepair = (options: AgentFixtureOptions, seed: unknown) =>
  runRepair({ ...options, task: 'repair', prompt: '', opaqueOutcome: true }, seed);

test('generic repair returns the Agent Markdown without any structured verification request', async () => {
  const options = await fixture();
  await withProvider([
    { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'after', replace_all: false } },
    { text: '## 修复\n\n已调整兼容性，并自行运行了相关测试。' },
  ], async requests => {
    const result = await runGenericRepair(options, { task: 'Repair fixture' });
    assert.deepEqual(result, { status: 'repaired', body: '## 修复\n\n已调整兼容性，并自行运行了相关测试。' });
    assert.equal(requests.length, 2);
    assert.equal(toolNames(requests[0]).includes('request_repair_verification'), false,
      'new repair runs expose no structured verification tool');
    assert.equal(await readFile(join(options.ws.path, 'sample.txt'), 'utf8'), 'after\n');
  });
});

test('CI repair returns opaque Markdown and never gates success on a tests list', async () => {
  const options = await fixture();
  await withProvider([{ text: '已修复 CI 失败。' }], async requests => {
    assert.deepEqual(await runCIRepair({ ...options, opaqueOutcome: true }, {}), { status: 'repaired', body: '已修复 CI 失败。' });
    assert.equal(requests.length, 1);
  });
});

test('repair surfaces a human-help request as needs_human', async () => {
  const options = await fixture();
  await withProvider([{ tool: 'request_human_help', args: { reason: 'Product decision required' } }], async () => {
    assert.deepEqual(await runGenericRepair(options, {}), { status: 'needs_human', summary: 'Product decision required' });
  });
});

test('a wall-clock budget exhaustion returns budget_exhausted instead of a fabricated success', async () => {
  const options = await fixture();
  const previous = { taskMs: budget.taskMs, finalAnswerMs: budget.finalAnswerMs };
  budget.taskMs = 200; budget.finalAnswerMs = 50;
  try {
    await withProvider([{ text: 'slow unfinished work', delayMs: 600 }, { text: 'slow final answer', delayMs: 600 }], async () => {
      assert.equal((await runGenericRepair(options, {})).status, 'budget_exhausted');
    });
  } finally { budget.taskMs = previous.taskMs; budget.finalAnswerMs = previous.finalAnswerMs; }
});

test('every ordinary repair turn reserves a tool-free final-answer phase after step exhaustion', async () => {
  const options = await fixture();
  const previous = budget.maxSteps; budget.maxSteps = 1;
  try {
    await withProvider([
      { tool: 'mastra_workspace_read_file', args: { path: 'sample.txt', showLineNumbers: true } },
      { text: '根据现有证据完成答复。' },
    ], async requests => {
      const result = await runGenericRepair(options, {});
      assert.deepEqual(result, { status: 'repaired', body: '根据现有证据完成答复。' });
      assert.equal(requests.length, 2);
      const finalTools = toolNames(requests[1]);
      assert.equal(finalTools.includes('mastra_workspace_read_file'), false);
      assert.equal(finalTools.includes('mastra_workspace_edit_file'), false);
      const events = await traceEvents(options.trace);
      assert.equal(events.filter(event => event.event === 'agent_final_answer_started').length, 1);
      assert.equal(events.filter(event => event.event === 'agent_final_answer_completed').length, 1);
    });
  } finally { budget.maxSteps = previous; }
});

test('custom, review, repair, CI and conflict share the same final-answer fallback contract', async () => {
  const previous = budget.maxSteps; budget.maxSteps = 1;
  const cases = [
    { name: 'custom', run: (options: Awaited<ReturnType<typeof fixture>>) => runCustom({ ...options, opaqueOutcome: true }, {}) },
    { name: 'review', run: (options: Awaited<ReturnType<typeof fixture>>) => runReview({ ...options, opaqueOutcome: true }, {}) },
    { name: 'repair', run: (options: Awaited<ReturnType<typeof fixture>>) => runRepair({ ...options, task: 'repair', prompt: '', opaqueOutcome: true }, {}) },
    { name: 'ci', run: (options: Awaited<ReturnType<typeof fixture>>) => runCIRepair({ ...options, opaqueOutcome: true }, {}) },
    { name: 'conflict', run: (options: Awaited<ReturnType<typeof fixture>>) => runConflict({ ...options, opaqueOutcome: true }, {}) },
  ] as const;
  try {
    for (const entry of cases) {
      const options = await fixture();
      await withProvider([
        { tool: 'mastra_workspace_read_file', args: { path: 'sample.txt', showLineNumbers: true } },
        { text: `${entry.name} final answer` },
      ], async requests => {
        const result = await entry.run(options);
        const body = 'outcome' in result
          ? result.outcome === 'finished' ? result.body : assert.fail(`${entry.name} unexpectedly ended as ${result.status}`)
          : result.status === 'repaired' || result.status === 'completed'
            ? result.body : assert.fail(`${entry.name} unexpectedly ended as ${result.status}`);
        assert.equal(body, `${entry.name} final answer`);
        assert.equal(requests.length, 2, `${entry.name} must use one execution turn and one final-answer turn`);
        const finalTools = toolNames(requests[1]);
        assert.equal(finalTools.some((name: string) => /read_file|edit_file|delete|execute_command/.test(name)), false,
          `${entry.name} final-answer phase must not expose ordinary exploration tools`);
      });
    }
  } finally { budget.maxSteps = previous; }
});

test('all ordinary command types inject code-owned convergence guidance without runtime-budget Prompt', async () => {
  const previous = budget.maxSteps; budget.maxSteps = 1;
  const cases = [
    { name: 'custom', templateType: 'custom' as const, run: (options: Awaited<ReturnType<typeof fixture>>) => runCustom({ ...options, opaqueOutcome: true }, {}) },
    { name: 'review', templateType: 'review' as const, run: (options: Awaited<ReturnType<typeof fixture>>) => runReview({ ...options, opaqueOutcome: true }, {}) },
    { name: 'repair', templateType: 'repair' as const, run: (options: Awaited<ReturnType<typeof fixture>>) => runRepair({ ...options, task: 'repair', prompt: '', opaqueOutcome: true }, {}) },
    { name: 'ci', templateType: 'ci' as const, run: (options: Awaited<ReturnType<typeof fixture>>) => runCIRepair({ ...options, opaqueOutcome: true }, {}) },
    { name: 'conflict', templateType: 'conflict' as const, run: (options: Awaited<ReturnType<typeof fixture>>) => runConflict({ ...options, opaqueOutcome: true }, {}) },
  ] as const;
  try {
    for (const entry of cases) {
      const options = await fixture();
      await withProvider([{ text: `${entry.name} converged` }], async (requests, baseUrl) => {
        const configured = { ...options, execution: executionWithoutRuntimeBudget(baseUrl, entry.templateType) };
        const result = await entry.run(configured);
        const body = 'outcome' in result
          ? result.outcome === 'finished' ? result.body : assert.fail(`${entry.name} unexpectedly ended as ${result.status}`)
          : result.status === 'repaired' || result.status === 'completed'
            ? result.body : assert.fail(`${entry.name} unexpectedly ended as ${result.status}`);
        assert.equal(body, `${entry.name} converged`);
        assert.match(JSON.stringify(requests[0]), /停止开始新的大范围调查或工具循环/,
          `${entry.name} must receive code-owned convergence guidance when its snapshot omits runtime-budget`);
        const warning = (await traceEvents(configured.trace)).find(event => event.event === 'budget_warning' || event.event === 'budget_critical');
        assert.equal(warning?.guidance_injected, true, `${entry.name} must trace injected convergence guidance`);
        assert.equal(warning?.guidance_source, 'code_owned', `${entry.name} must identify the code-owned fallback`);
      });
    }
  } finally { budget.maxSteps = previous; }
});

test('final-answer capability is runtime-owned and cannot expose caller-supplied exploration tools', async () => {
  assert.deepEqual(finalAnswerTools('text_only'), []);
  assert.deepEqual(finalAnswerTools('conversation_reply'), ['reply_to_pr']);
  const options = await fixture();
  const maliciousTool = createTool({ id: 'malicious_exploration', description: 'must never enter final-answer phase',
    inputSchema: z.object({}), execute: async () => ({ wrote: true }) });
  const previous = budget.maxSteps; budget.maxSteps = 1;
  try {
    await withProvider([
      { tool: 'mastra_workspace_read_file', args: { path: 'sample.txt', showLineNumbers: true } },
      { text: '只根据已有证据完成答复。' },
    ], async requests => {
      const result = await runGenericRepair({ ...options, finalAnswerCapability: 'text_only', tools: { malicious_exploration: maliciousTool } }, {});
      assert.deepEqual(result, { status: 'repaired', body: '只根据已有证据完成答复。' });
      assert.equal(toolNames(requests[1]).includes('malicious_exploration'), false);
      assert.equal(toolNames(requests[1]).some(name => /read_file|edit_file|delete|execute_command/.test(name)), false);
    });
  } finally { budget.maxSteps = previous; }
});

test('read-only Conflict filters caller-supplied mutating tools before the Agent turn', async () => {
  const options = await fixture();
  const mutatingTool = createTool({ id: 'malicious_write', description: 'must never be exposed to read-only Conflict',
    inputSchema: z.object({}), execute: async () => ({ wrote: true }) });
  await withProvider([{ tool: 'request_human_help', args: { reason: 'Product decision required' } }], async requests => {
    const result = await runConflict({ ...options, opaqueOutcome: true, tools: { malicious_write: mutatingTool } }, { task: 'fixture' });
    assert.equal(result.status, 'needs_human');
    assert.equal(toolNames(requests[0]).includes('malicious_write'), false);
  });
});

test('approved-write Conflict keeps its caller-supplied tools', async () => {
  const options = await fixture();
  const allowedTool = createTool({ id: 'allowed_write', description: 'available during the approved write phase',
    inputSchema: z.object({}), execute: async () => ({ wrote: true }) });
  await withProvider([{ tool: 'request_human_help', args: { reason: 'stop here' } }], async requests => {
    await runConflict({ ...options, opaqueOutcome: true, permissionPhase: 'approved_write', tools: { allowed_write: allowedTool } }, { task: 'fixture' });
    assert.equal(toolNames(requests[0]).includes('allowed_write'), true);
  });
});
