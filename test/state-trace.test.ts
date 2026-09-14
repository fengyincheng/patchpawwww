import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Trace } from '../src/harness/trace.ts';
import { claimRun, savePending, takePending } from '../src/runner/state.ts';
import { isOutputTruncated } from '../src/harness/context/policy.ts';

test('trace redacts registered multiline and quoted credentials without false truncation flags', async () => {
  const trace = new Trace(await mkdtemp(join(tmpdir(), 'patchpaw-trace-test-')));
  const secret = 'private\nkey"with\\escapes'; trace.secret(secret);
  assert.deepEqual(JSON.parse(trace.clean({ output: `value: ${secret}` })), { output: 'value: [REDACTED]' });
  assert.equal(isOutputTruncated({ content: 'omitted is a source variable', truncated: false }), false);
  assert.equal(isOutputTruncated({ content: 'short', truncated: true }), true);
});

test('only one run claims a PR while a newer external head remains pending for the next run', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'patchpaw-state-test-')), 'pr.json');
  const release = await claimRun(path); assert.ok(release);
  assert.equal(await claimRun(path), null);
  await savePending(path, 'head-a'); await savePending(path, 'head-b');
  await release();
  assert.equal(await takePending(path), 'head-b');
  assert.equal(await takePending(path), null);
  const next = await claimRun(path); assert.ok(next); await next();
});
