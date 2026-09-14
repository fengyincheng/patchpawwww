import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '@mastra/memory';
import { taskMemory, prThreadId } from '../src/harness/pr-memory.ts';
import { createTaskSession } from '../src/harness/runtime.ts';
import { contextPolicy } from '../src/harness/context/policy.ts';
import { Trace } from '../src/harness/trace.ts';

test('persistent PR history survives a closed storage handle, uses the last 100 messages, and isolates other PRs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-memory-'));
  const pr = { root: join(root, 'memory'), repo: 'Owner/Repo', number: 7 };
  const initial = taskMemory(pr, 'first-run', root);
  const memory = new Memory({ storage: initial.storage, options: { lastMessages: 100, semanticRecall: false,
    workingMemory: { enabled: false }, generateTitle: false } });
  const threadId = prThreadId(pr.repo, pr.number);
  await memory.saveThread({ thread: { id: threadId, resourceId: threadId, title: 'fixture', createdAt: new Date(), updatedAt: new Date() } });
  await memory.saveMessages({ messages: Array.from({ length: 120 }, (_, i) => ({ id: `message-${i}`, threadId,
    resourceId: threadId, role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    content: { format: 2 as const, parts: [{ type: 'text' as const, text: `persisted-marker-${String(i).padStart(3, '0')}` }] } })) });
  await memory.settled(); await initial.storage.close();
  const requests: any[] = [];
  const old = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'fixture'; process.env.ZAI_BASE_URL = 'https://model.fixture/v1';
  t.after(() => {
    for (const [key, value] of [['ZAI_API_KEY', old.key], ['ZAI_BASE_URL', old.url]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `reply-${requests.length}`, model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'remember this new answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const [task, number] of [['conflict', 7], ['conversation', 7], ['review', 8]] as const) {
    const session = createTaskSession({ task, runId: `${task}-new-run`, prompt: 'Answer the question', readOnly: true,
      prMemory: { ...pr, repo: 'owner/repo', number }, trace: new Trace(join(root, task)),
      ws: { path: root, initialHead: '', mainSha: '', unmerged: [], mergePending: false } });
    try { await session.turn('Use the prior conversation'); } finally { await session.close(); }
  }
  assert.equal(contextPolicy.lastMessages, 100);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /persisted-marker-000/);
  assert.match(JSON.stringify(requests[0].messages), /persisted-marker-119/);
  assert.ok((JSON.stringify(requests[0].messages).match(/persisted-marker-/g) ?? []).length <= 100);
  assert.match(JSON.stringify(requests[1].messages), /remember this new answer/);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /persisted-marker-|remember this new answer/);
});
