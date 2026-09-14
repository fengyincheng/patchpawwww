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
import { budget } from '../src/harness/budget.ts';
import { setTimeout } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { nodeExit, nodeFileEquals, nodeFileExists, nodeWriteFile } from './helpers/portable-commands.ts';

type Reply = { text?: string; tool?: string; args?: object; httpStatus?: number; delayMs?: number };
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
async function withProvider(replies: Reply[], run: (requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const reply = replies[requests.length - 1] ?? { text: 'Done.' };
    if (reply.delayMs) await setTimeout(reply.delayMs);
    if (reply.httpStatus) { res.writeHead(reply.httpStatus); res.end('fixture provider failure'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: `response-${requests.length}`, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: reply.text ?? 'Here is my explanation, not a JSON document.',
        ...(reply.tool ? { tool_calls: [{ id: `call-${requests.length}`, type: 'function',
          function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : {}) },
      finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'fixture-key';
  process.env.ZAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try { await run(requests); }
  finally {
    for (const [name, value] of [['ZAI_API_KEY', previous.key], ['ZAI_BASE_URL', previous.url]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

// Stage 06 makes runConflict read-only. These lower-level tests still exercise the generic
// repair verification loop, so they call that loop explicitly instead of treating Conflict as a
// repair-capable task.
const runDirectConflictRepair = (options: Awaited<ReturnType<typeof fixture>>, seed: unknown) =>
  runRepair({ ...options, task: 'conflict', prompt: '' }, seed);

test('the generic repair loop accepts a structured verification request, returns real failure, and verifies a same-session repair without parsing prose', async () => {
  const options = await fixture();
  const request = { summary: 'fixture repair', tests: [nodeFileEquals('sample.txt', 'after\n')], validation_not_applicable: null };
  await withProvider([
    { tool: 'request_repair_verification', args: request },
    { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'after', replace_all: false } },
    { tool: 'mastra_workspace_execute_command', args: { command: 'git add sample.txt' } },
    { tool: 'request_repair_verification', args: request },
  ], async requests => {
    const result = await runDirectConflictRepair(options, { task: 'Repair fixture' });
    assert.equal(result.status, 'repaired');
    assert.equal(requests.length, 4, 'verification request stops the loop without asking for a final JSON reply');
    assert.match(JSON.stringify(requests[1].messages), /独立验证失败/);
    assert.match(JSON.stringify(requests[1].messages), /exitCode.*1/);
    assert.equal(await readFile(join(options.ws.path, 'sample.txt'), 'utf8'), 'after\n');
    const events = (await readFile(join(options.trace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.event === 'repair_verification').map(e => e.ok), [false, true]);
    assert.equal(new Set(events.filter(e => e.event === 'task_turn_start').map(e => e.thread)).size, 1);
  });
});

test('CI Repair ignores an agent-authored repaired JSON when no verification was requested', async () => {
  const options = await fixture();
  await withProvider([{ text: JSON.stringify({ status: 'repaired', summary: 'claimed success', tests: [nodeExit(0)], validation_not_applicable: null }) }], async () => {
    assert.equal((await runCIRepair(options, { task: 'fixture' })).status, 'budget_exhausted');
  });
});

test('changed tests run as the candidate without a second frozen-baseline execution', async () => {
  const options = await fixture();
  const original = "import { readFileSync } from 'node:fs';\nif (readFileSync('sample.txt', 'utf8') !== 'after\\n') process.exit(1);\n";
  await writeFile(join(options.ws.path, 'sample.test.mjs'), original);
  await git(options.ws.path, ['add', 'sample.test.mjs']);
  await git(options.ws.path, ['commit', '-m', 'existing acceptance test']);
  const request = { summary: 'fixture repair', tests: ['node sample.test.mjs'], validation_not_applicable: null };
  await withProvider([
    { tool: 'mastra_workspace_edit_file', args: { path: 'sample.test.mjs', old_string: original.trim(), new_string: 'true', replace_all: false } },
    { tool: 'request_repair_verification', args: request },
    { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'after', replace_all: false } },
    { tool: 'request_repair_verification', args: request },
  ], async requests => {
    assert.equal((await runCIRepair(options, { task: 'Repair fixture' })).status, 'repaired');
    assert.equal(requests.length, 2);
    assert.equal(await readFile(join(options.ws.path, 'sample.txt'), 'utf8'), 'before\n');
    const events = (await readFile(join(options.trace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.event === 'repair_verification').map(e => e.ok), [true]);
    assert.equal(events.filter(e => e.event === 'original_validation').length, 0);
  });
});

test('CI Repair uses the same structured verification boundary and supports structured human help', async () => {
  const options = await fixture();
  await withProvider([{ tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'after', replace_all: false } },
  { tool: 'request_repair_verification', args: {
    summary: 'verified fixture', tests: [nodeFileExists('sample.txt')], validation_not_applicable: null,
  } }], async requests => {
    assert.equal((await runCIRepair(options, { task: 'fixture' })).status, 'repaired');
    assert.equal(requests.length, 2);
  });
  await withProvider([{ tool: 'request_human_help', args: { reason: 'Product decision required' } }], async () => {
    assert.deepEqual(await runConflict(await fixture(), { task: 'fixture' }), { status: 'needs_human', summary: 'Product decision required' });
  });
});

test('read-only Conflict filters caller-supplied mutating tools before the Agent turn', async () => {
  const options = await fixture();
  const mutatingTool = createTool({ id: 'malicious_write', description: 'must never be exposed to read-only Conflict',
    inputSchema: z.object({}), execute: async () => ({ wrote: true }) });
  await withProvider([{ tool: 'request_human_help', args: { reason: 'Product decision required' } }], async requests => {
    const result = await runConflict({ ...options, tools: { malicious_write: mutatingTool } }, { task: 'fixture' });
    assert.equal(result.status, 'needs_human');
    assert.equal(requests[0].tools.some((tool: any) => tool.function.name === 'malicious_write'), false);
  });
});

test('each repair rejects a clean unchanged HEAD even when a previous task already committed a repair', async () => {
  const options = await fixture();
  const request = { summary: 'claims repaired', tests: [nodeFileExists('sample.txt')], validation_not_applicable: null };
  await withProvider([
    { tool: 'mastra_workspace_execute_command', args: { command: nodeWriteFile('sample.txt', 'after\n') + ' && git add sample.txt && git commit -m "Agent fix"' } },
    { tool: 'request_repair_verification', args: request },
  ], async () => assert.equal((await runCIRepair(options, {})).status, 'repaired'));
  const head = (await git(options.ws.path, ['rev-parse', 'HEAD'])).stdout.trim();
  assert.notEqual(head, options.ws.initialHead);
  await withProvider([
    { tool: 'request_repair_verification', args: request },
    { tool: 'request_human_help', args: { reason: 'No code change justified; need guidance' } },
  ], async requests => {
    assert.equal((await runCIRepair(options, {})).status, 'needs_human');
    assert.match(JSON.stringify(requests[1].messages), /No changes since this repair started/);
    assert.equal((await git(options.ws.path, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  });
});

test('passing tests cannot override a real unmerged index', async () => {
  const options = await fixture();
  await git(options.ws.path, ['checkout', '-b', 'feature']);
  await writeFile(join(options.ws.path, 'sample.txt'), 'feature\n');
  await git(options.ws.path, ['commit', '-am', 'feature']);
  await git(options.ws.path, ['checkout', 'main']);
  await writeFile(join(options.ws.path, 'sample.txt'), 'main\n');
  await git(options.ws.path, ['commit', '-am', 'main']);
  await git(options.ws.path, ['merge', 'feature'], undefined, undefined, true);
  await withProvider([{ tool: 'request_repair_verification', args: {
    summary: 'claims ready', tests: [nodeExit(0)], validation_not_applicable: null,
  } }], async requests => {
    assert.equal((await runDirectConflictRepair(options, { task: 'fixture' })).status, 'budget_exhausted');
    assert.match(JSON.stringify(requests[1].messages), /unmerged/);
    assert.notEqual((await git(options.ws.path, ['ls-files', '-u'])).stdout, '');
  });
});

const closeout = { status: 'budget_exhausted', summary: '候选尚未完成', completed: ['已定位问题'], remaining: ['修复调用路径'],
  current_investigation: 'threadId 参数传递', validation: { passed: ['契约检查'], failed: ['handoff 返回 400'] },
  workspace_state: 'dirty', human_question: null };
async function shortBudget(run: () => Promise<void>) {
  const previous = { maxSteps: budget.maxSteps, feedbackTurns: budget.feedbackTurns };
  budget.maxSteps = 3; budget.feedbackTurns = 0;
  try { await run(); } finally { Object.assign(budget, previous); }
}
test('hard execution budget enters the same thread closeout with only submission tools and persists agent summary', async () => {
  await shortBudget(async () => {
    const options = await fixture();
    const read = { tool: 'mastra_workspace_read_file', args: { path: 'sample.txt' } };
    await withProvider([read, read, read, { tool: 'submit_task_closeout', args: closeout }], async requests => {
      const result = await runDirectConflictRepair(options, { task: 'repair' });
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(requests.length, 4);
      assert.match(JSON.stringify(requests[0].messages), /本轮剩余 3 个执行步骤/);
      assert.match(JSON.stringify(requests[3].messages), /常规修复执行预算已耗尽/);
      assert.match(JSON.stringify(requests[3].messages), /sample.txt/);
      assert.deepEqual(requests[3].tools.map((t: any) => t.function.name).sort(),
        ['request_human_help', 'request_repair_verification', 'submit_task_closeout']);
      const saved = JSON.parse(await readFile(join(options.trace.dir, 'closeout.json'), 'utf8'));
      assert.equal(saved.source, 'agent');
      assert.equal(saved.current_investigation, closeout.current_investigation);
      assert.equal(saved.facts.unresolved_count, 0);
      assert.equal(saved.facts.dirty, false, 'machine facts override agent workspace claim');
      assert.equal(saved.facts.verification_requested, false);
      const events = (await readFile(join(options.trace.dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse as any) as any[];
      assert.equal(new Set(events.filter(e => e.event === 'task_turn_start').map(e => e.thread)).size, 1);
      assert.ok(events.some(e => e.event === 'budget_critical'));
    });
  });
});
test('closeout provider failure still produces mechanical evidence and a human-readable report', async () => {
  await shortBudget(async () => {
    const options = await fixture();
    await writeFile(join(options.ws.path, 'sample.txt'), 'candidate\n');
    await withProvider([{ text: 'Still investigating' }, { httpStatus: 400 }], async () => {
      const result = await runCIRepair(options, {});
      assert.equal(result.status, 'budget_exhausted');
      assert.match(result.summary, /未获得 Agent 结构化收尾/);
      const saved = JSON.parse(await readFile(join(options.trace.dir, 'closeout.json'), 'utf8'));
      assert.equal(saved.source, 'harness'); assert.equal(saved.facts.dirty, true);
      assert.equal(saved.facts.committed, false); assert.equal(saved.facts.verification_requested, false);
    });
  });
});
test('human decision during closeout wins over budget exhaustion', async () => {
  await shortBudget(async () => {
    await withProvider([{ text: 'Unfinished' }, { tool: 'request_human_help', args: { reason: '请选择架构方向' } }], async () => {
      assert.deepEqual(await runDirectConflictRepair(await fixture(), {}), { status: 'needs_human', summary: '请选择架构方向' });
    });
  });
});
test('verification submitted during closeout still runs independent checks', async () => {
  await shortBudget(async () => {
    for (const passing of [true, false]) {
      const options = await fixture();
      await writeFile(join(options.ws.path, 'sample.txt'), 'candidate\n');
      await withProvider([{ text: 'Candidate ready' }, { tool: 'request_repair_verification', args: {
        summary: 'candidate', tests: [passing ? nodeFileEquals('sample.txt', 'candidate\n') : nodeExit(1)], validation_not_applicable: null,
      } }], async () => {
        assert.equal((await runDirectConflictRepair(options, {})).status, passing ? 'repaired' : 'budget_exhausted');
        const validation = JSON.parse(await readFile(join(options.trace.dir, 'last-validation.json'), 'utf8'));
        assert.equal(validation.ok, passing);
      });
    }
  });
});
test('soft budget warning leaves verification available without requiring closeout', async () => {
  const previous = budget.maxSteps; budget.maxSteps = 10;
  try {
    const options = await fixture(); await writeFile(join(options.ws.path, 'sample.txt'), 'candidate\n');
    await withProvider([{ tool: 'request_repair_verification', args: { summary: 'ready', tests: [nodeExit(0)], validation_not_applicable: null } }], async requests => {
      assert.equal((await runDirectConflictRepair(options, {})).status, 'repaired');
      assert.match(JSON.stringify(requests[0].messages), /本轮剩余 10 个执行步骤/);
      assert.equal(requests.length, 1);
    });
  } finally { budget.maxSteps = previous; }
});
test('the final feedback turn exhausts the total step budget before independent closeout', async () => {
  const previous = { maxSteps: budget.maxSteps, feedbackTurns: budget.feedbackTurns };
  budget.maxSteps = 1; budget.feedbackTurns = 1;
  try {
    const read = { tool: 'mastra_workspace_read_file', args: { path: 'sample.txt' } };
    await withProvider([read, read, { tool: 'submit_task_closeout', args: closeout }], async requests => {
      assert.equal((await runDirectConflictRepair(await fixture(), {})).status, 'budget_exhausted');
      assert.equal(requests.length, 3);
      assert.ok(requests[1].tools.some((t: any) => t.function.name === 'mastra_workspace_edit_file'));
      assert.ok(!requests[2].tools.some((t: any) => t.function.name === 'mastra_workspace_edit_file'));
    });
  } finally { Object.assign(budget, previous); }
});
test('closeout cannot execute a hallucinated edit tool even when it appears in earlier history', async () => {
  await shortBudget(async () => {
    const options = await fixture();
    await withProvider([{ text: 'unfinished' },
      { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'forbidden' } },
      { tool: 'submit_task_closeout', args: closeout }], async () => {
      assert.equal((await runDirectConflictRepair(options, {})).status, 'budget_exhausted');
      assert.equal(await readFile(join(options.ws.path, 'sample.txt'), 'utf8'), 'before\n');
    });
  });
});
test('wall-clock execution timeout leaves closeout with a fresh independent signal', async () => {
  await shortBudget(async () => {
    const options = await fixture(), previous = budget.taskMs; budget.taskMs = 200;
    try {
      await withProvider([{ text: 'slow unfinished work', delayMs: 500 }, { tool: 'submit_task_closeout', args: closeout }], async () => {
        assert.equal((await runDirectConflictRepair(options, {})).status, 'budget_exhausted');
        const saved = JSON.parse(await readFile(join(options.trace.dir, 'closeout.json'), 'utf8'));
        assert.equal(saved.source, 'agent');
      });
    } finally { budget.taskMs = previous; }
  });
});

test('staged whitespace warnings do not reject passing tests or consume another model turn', async () => {
  const options = await fixture();
  await withProvider([{ tool: 'request_repair_verification', args: {
    summary: 'claims ready', tests: [nodeWriteFile('sample.txt', 'after  \n') + ' && git add sample.txt'], validation_not_applicable: null,
  } }], async requests => {
    const result = await runDirectConflictRepair(options, { task: 'fixture' });
    assert.equal(result.status, 'repaired');
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(result), /trailing whitespace/);
  });
});
