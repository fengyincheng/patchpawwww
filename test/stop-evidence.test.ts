import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/workspace/git.ts';
import { validateWorkspace } from '../src/workspace/manager.ts';
import { Trace } from '../src/harness/trace.ts';
import { stopEvidence } from '../src/runner/stop-evidence.ts';
import { nodeExit } from './helpers/portable-commands.ts';

test('stop evidence exposes real test failure, local commit and unconfirmed publication separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchpaw-stop-evidence-')), ws = join(dir, 'workspace');
  await mkdir(ws); const trace = new Trace(dir);
  await git(ws, ['init', '-b', 'main']); await git(ws, ['config', 'user.name', 'Fixture']);
  await git(ws, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(ws, 'a.txt'), 'before\n'); await git(ws, ['add', '.']); await git(ws, ['commit', '-m', 'base']);
  const base = (await git(ws, ['rev-parse', 'HEAD'])).stdout.trim();
  trace.save('manifest.json', { initial_head_sha: base });
  await writeFile(join(ws, 'a.txt'), 'after  \n'); await git(ws, ['commit', '-am', 'Agent fix']);
  const validation = await validateWorkspace({ path: ws, initialHead: base, mainSha: base, unmerged: [], mergePending: false },
    ["node -e \"console.log('not ok 1 - broken contract'); console.error('AssertionError: expected true'); process.exit(7)\"", nodeExit(0)], trace, base);
  trace.save('last-validation.json', validation);
  const report = await stopEvidence(dir, base);
  assert.match(report, /exit 7/); assert.match(report, /AssertionError: expected true/);
  assert.match(report, /通过：`node -e \"process\.exit\(0\)\"`/); assert.match(report, /Agent fix/);
  assert.match(report, /尚无推送成功确认/); assert.match(report, /格式检查提示（不阻断）/);
  assert.equal(validation.ok, false, 'formatting is advisory but test failures still block');
});

test('staged leftover conflict markers still block despite a resolved index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'patchpaw-staged-markers-')); const trace = new Trace(join(dir, 'trace'));
  await git(dir, ['init', '-b', 'main']); await git(dir, ['config', 'user.name', 'Fixture']);
  await git(dir, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(dir, 'a.txt'), 'before\n'); await git(dir, ['add', 'a.txt']); await git(dir, ['commit', '-m', 'base']);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(dir, 'a.txt'), '<<<<<<< HEAD\nbefore\n=======\nafter\n>>>>>>> main\n'); await git(dir, ['add', 'a.txt']);
  const result = await validateWorkspace({ path: dir, initialHead: head, mainSha: head, unmerged: [], mergePending: false }, [nodeExit(0)], trace, head);
  assert.equal(result.unmerged, ''); assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('leftover conflict marker')));
});
