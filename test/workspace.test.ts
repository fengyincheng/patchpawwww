import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, command } from '../src/workspace/git.ts';
import { prepareWorkspace, validateWorkspace } from '../src/workspace/manager.ts';
import { ensureRepo, fetchPRState, createWorktree, runWorkspacePath } from '../src/workspace/repo-store.ts';
import { Trace } from '../src/harness/trace.ts';
import { nodeExit, nodeFileExists } from './helpers/portable-commands.ts';

// Production workspace shape: a worktree of the shared bare cache for the repo, then local
// merge/index preparation inside it — never a standalone per-run clone.
async function shared(storeRoot: string, remote: string, trace: Trace, head: string, runId: string, mergeBase?: boolean) {
  await ensureRepo(storeRoot, 'owner/lab', remote, trace);
  await fetchPRState(storeRoot, 'owner/lab', { headSha: head, baseRef: 'main' }, trace);
  const path = runWorkspacePath(storeRoot, runId);
  await createWorktree(storeRoot, 'owner/lab', path, head, trace);
  return prepareWorkspace({ path, headSha: head, baseRef: 'main', mergeBase }, trace);
}

test('isolated exact head merge retains real index conflicts without modifying source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-workspace-test-'));
  const trace = new Trace(join(root, 'trace'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(root, 'value.txt'), 'original\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['checkout', '-b', 'feature']);
  await writeFile(join(root, 'value.txt'), 'feature\n');
  await git(root, ['commit', '-am', 'feature']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(root, ['checkout', 'main']);
  await writeFile(join(root, 'value.txt'), 'main\n');
  await git(root, ['commit', '-am', 'main']);
  const ws = await shared(join(root, 'store'), root, trace, head, 'job');
  assert.equal((await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.deepEqual(ws.unmerged, ['value.txt']);
  assert.equal((await validateWorkspace(ws, [], trace)).ok, false);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'main\n');
  // Fixture-only repair verifies the public validation boundary, never an exam workspace.
  await writeFile(join(ws.path, 'value.txt'), 'combined\n');
  await git(ws.path, ['add', 'value.txt']);
  assert.equal((await validateWorkspace(ws, [nodeExit(7)], trace)).ok, false);
  assert.equal((await validateWorkspace(ws, [nodeFileExists('value.txt')], trace)).ok, true);
  assert.equal((await command(ws.path, process.execPath, ['-e', "process.stdout.write('truth'); process.exit(3)"])).exitCode, 3);
});

test('test edits and deletions are evidence, never overwritten or judged by a frozen-baseline hard gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-original-tests-'));
  const trace = new Trace(join(root, 'trace'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@localhost']);
  const original = "import { readFileSync } from 'node:fs';\nif (readFileSync('value.txt', 'utf8') !== 'correct\\n') process.exit(1);\n";
  await writeFile(join(root, 'value.txt'), 'correct\n');
  await writeFile(join(root, 'value.test.mjs'), original);
  await git(root, ['add', 'value.txt', 'value.test.mjs']);
  await git(root, ['commit', '-m', 'original contract']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const ws = await shared(join(root, 'store'), root, trace, head, 'job');
  const unchanged = await validateWorkspace(ws, ['node value.test.mjs'], trace);
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.verification_input_changes, []);
  assert.equal(unchanged.validation.length, 1, 'candidate test runs only once');

  await writeFile(join(ws.path, 'value.txt'), 'regression\n');
  await writeFile(join(ws.path, 'value.test.mjs'), 'true\n');
  await git(ws.path, ['add', 'value.txt', 'value.test.mjs']);
  const index = (await git(ws.path, ['ls-files', '-s'])).stdout;
  const weakened = await validateWorkspace(ws, ['node value.test.mjs'], trace);
  assert.equal(weakened.validation[0]?.exitCode, 0, 'the weakened candidate test passes');
  assert.equal(weakened.ok, true, 'test quality is a prompt/review concern, not baseline replay');
  assert.deepEqual(weakened.verification_input_changes, ['value.test.mjs']);
  assert.equal(weakened.validation.length, 1);
  assert.equal(await readFile(join(ws.path, 'value.test.mjs'), 'utf8'), 'true\n');
  assert.equal((await git(ws.path, ['ls-files', '-s'])).stdout, index);

  await writeFile(join(ws.path, 'value.txt'), 'correct\n');
  await writeFile(join(ws.path, 'value.test.mjs'), `// A legitimate test update\n${original}`);
  assert.equal((await validateWorkspace(ws, ['node value.test.mjs'], trace)).ok, true);
  assert.equal(await readFile(join(ws.path, 'value.test.mjs'), 'utf8'), `// A legitimate test update\n${original}`);

  await unlink(join(ws.path, 'value.test.mjs'));
  await writeFile(join(ws.path, 'value.txt'), 'regression\n');
  const deleted = await validateWorkspace(ws, [nodeExit(0)], trace);
  assert.equal(deleted.validation[0]?.exitCode, 0);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.verification_input_changes, ['value.test.mjs']);
  await assert.rejects(readFile(join(ws.path, 'value.test.mjs')), { code: 'ENOENT' });
});

test('a resolved package.json conflict passes candidate tests without replaying broken original JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-conflict-baseline-'));
  const trace = new Trace(join(root, 'evidence'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']); await git(root, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(root, 'package.json'), '{"name":"base"}\n');
  await git(root, ['add', 'package.json']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['checkout', '-b', 'feature']);
  await writeFile(join(root, 'package.json'), '{"name":"feature"}\n'); await git(root, ['commit', '-am', 'feature']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(root, ['checkout', 'main']);
  await writeFile(join(root, 'package.json'), '{"name":"main"}\n'); await git(root, ['commit', '-am', 'main']);
  const ws = await shared(join(root, 'store'), root, trace, head, 'job');
  assert.deepEqual(ws.unmerged, ['package.json']);
  await writeFile(join(ws.path, 'package.json'), '{"name":"resolved"}\n'); await git(ws.path, ['add', 'package.json']);
  const result = await validateWorkspace(ws, ['node -e \'JSON.parse(require("fs").readFileSync("package.json"))\''], trace, head);
  assert.equal(result.ok, true); assert.equal(result.validation.length, 1);
  assert.deepEqual(result.verification_input_changes, ['package.json']);
  assert.equal(JSON.parse(await readFile(join(ws.path, 'package.json'), 'utf8')).name, 'resolved');
  assert.match(await readFile(join(trace.dir, 'verification-inputs-content.json'), 'utf8'), /<<<<<<< HEAD/);
});
