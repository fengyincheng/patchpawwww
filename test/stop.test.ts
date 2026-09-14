import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchStop, TaskStopped } from '../src/runner/stop.ts';
import { saveHumanReply } from '../src/runner/human-feedback.ts';
import { command, git } from '../src/workspace/git.ts';
import { captureExecutionBaseline, executionChanges } from '../src/runner/workspace-evidence.ts';
import { Trace } from '../src/harness/trace.ts';

test('stop watcher ignores handled and quoted commands, consumes the durable stop and interrupts a long command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchpaw-stop-')), path = join(dir, 'state.json');
  const reply = (id: number, body: string) => saveHumanReply(path, { repo: 'owner/repo', pr_number: 1, installation_id: 1,
    comment_id: id, author: 'owner', body, url: 'https://example.test/comment' });
  await reply(1, '@bot /stop'); await reply(2, '> @bot /stop');
  const stop = watchStop(path, 'bot', () => [1]);
  try {
    await stop.guard(); assert.equal(stop.signal.aborted, false);
    const running = command(dir, process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('should-not-exist', 'unexpected'), 30000)"], undefined, 60000, stop.signal);
    const rejected = assert.rejects(running, TaskStopped);
    await reply(3, '@bot /stop 请解释目前进度');
    await assert.rejects(stop.guard(), TaskStopped);
    await rejected;
    assert.equal(stop.request()?.comment_id, 3);
    await assert.rejects(readFile(join(dir, 'should-not-exist')), { code: 'ENOENT' });
  } finally { await stop.close(); }
});

test('execution baseline handles a tracked file replaced by FIFO without blocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchpaw-evidence-')), ws = join(dir, 'ws'); await mkdir(ws);
  await git(ws, ['init']); await writeFile(join(ws, 'tracked'), 'content'); await git(ws, ['add', 'tracked']);
  const trace = new Trace(join(dir, 'run')); await captureExecutionBaseline(ws, trace);
  const replacement = process.platform === 'win32'
    ? command(ws, process.execPath, ['-e', "require('node:fs').rmSync('tracked'); require('node:fs').mkdirSync('tracked')"])
    : command(ws, 'sh', ['-c', 'rm tracked && mkfifo tracked']);
  assert.equal((await replacement).exitCode, 0);
  assert.match(await executionChanges(ws, trace.dir), /1 个文件/);
});
