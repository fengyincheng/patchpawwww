import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { prepareWorkspace } from '../src/workspace/manager.ts';
import { ensureRepo, fetchPRState, createWorktree, runWorkspacePath, disposeWorkspacePath } from '../src/workspace/repo-store.ts';
import { Trace } from '../src/harness/trace.ts';
import { retainWorkspace, resumeWorkspace, readPaused } from '../src/runner/resume.ts';
import { claimRun, writeState } from '../src/runner/state.ts';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-resume-'));
  const remote = join(root, 'remote'); await mkdir(remote);
  await git(remote, ['init', '-b', 'main']);
  await git(remote, ['config', 'user.name', 'Fixture']); await git(remote, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(remote, 'sample.txt'), 'base\n'); await git(remote, ['add', '.']); await git(remote, ['commit', '-m', 'base']);
  await git(remote, ['checkout', '-b', 'feature']); await writeFile(join(remote, 'sample.txt'), 'feature\n'); await git(remote, ['commit', '-am', 'feature']);
  const head = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(remote, ['checkout', 'main']); await writeFile(join(remote, 'sample.txt'), 'main\n'); await git(remote, ['commit', '-am', 'main']);
  const main = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  const trace = new Trace(join(root, 'first')), path = join(root, 'state/pr.json');
  await ensureRepo(root, 'owner/lab', remote, trace);
  await fetchPRState(root, 'owner/lab', { headSha: head, baseRef: 'main' }, trace);
  const wsPath = runWorkspacePath(root, 'first');
  await createWorktree(root, 'owner/lab', wsPath, head, trace);
  const ws = await prepareWorkspace({ path: wsPath, headSha: head, baseRef: 'main' }, trace);
  await writeFile(join(ws.path, 'notes.txt'), 'unfinished investigation\n');
  await retainWorkspace(path, trace, { run_id: 'first', execution_id: 1, base_sha: main, base_ref: 'main', workspace: ws });
  return { root, trace, path, ws, current: { head, main, base: main, baseRef: 'main' },
    dispose: (workspace: string) => disposeWorkspacePath(root, 'owner/lab', workspace, trace) };
}
test('resume retains unmerged index and untracked work, claims once, and increments epochs without rewriting evidence', async () => {
  const f = await fixture(), trace = new Trace(join(f.root, 'second'));
  const prior = await readFile(join(f.trace.dir, 'trace.jsonl'), 'utf8');
  const index = (await git(f.ws.path, ['ls-files', '-u'])).stdout;
  const release = await claimRun(f.path); assert.ok(release);
  try {
    const resumed = await resumeWorkspace(f.path, f.current, trace, f.dispose);
    assert.equal(resumed?.workspace.path, f.ws.path); assert.equal(resumed?.execution_id, 2);
    assert.equal((await git(f.ws.path, ['ls-files', '-u'])).stdout, index);
    assert.equal(await readFile(join(f.ws.path, 'notes.txt'), 'utf8'), 'unfinished investigation\n');
    assert.equal(await resumeWorkspace(f.path, f.current, trace, f.dispose), null, 'already claimed candidate cannot be reclaimed');
    assert.equal(await claimRun(f.path), null);
    await retainWorkspace(f.path, trace, { run_id: 'second', execution_id: 2, base_sha: f.current.base, base_ref: 'main', workspace: f.ws });
  } finally { await release(); }
  const nextRelease = await claimRun(f.path); assert.ok(nextRelease);
  try { assert.equal((await resumeWorkspace(f.path, f.current, new Trace(join(f.root, 'third'))))?.execution_id, 3); }
  finally { await nextRelease(); }
  assert.equal(await readFile(join(f.trace.dir, 'trace.jsonl'), 'utf8'), prior);
});
for (const changed of ['head', 'base', 'main', 'baseRef'] as const) {
  test(`changed remote ${changed} refuses old candidate using Git facts without any model`, async () => {
    const f = await fixture(), release = await claimRun(f.path); assert.ok(release);
    try {
      assert.equal(await resumeWorkspace(f.path, { ...f.current, [changed]: 'changed' }, f.trace, f.dispose), null);
      const stale = await readPaused(f.path);
      assert.equal(stale?.status, 'stale');
      assert.ok(stale?.reason, 'the stale reason is durable before the checkout is released');
      // The rejected checkout is released: a stale pause never keeps a permanent workspace.
      await assert.rejects(stat(f.ws.path), { code: 'ENOENT' });
    } finally { await release(); }
  });
}
for (const damage of ['missing', 'corrupt'] as const) {
  test(`${damage} paused workspace is refused`, async () => {
    const f = await fixture(), release = await claimRun(f.path); assert.ok(release);
    if (damage === 'missing') await rm(f.ws.path, { recursive: true });
    // A worktree's .git is a gitdir pointer file; corrupting it detaches the workspace from
    // the shared object store, which resume must detect and refuse.
    else await writeFile(join(f.ws.path, '.git'), 'corrupt gitdir pointer');
    try {
      assert.equal(await resumeWorkspace(f.path, f.current, f.trace, f.dispose), null);
      assert.equal((await readPaused(f.path))?.status, 'stale');
      await assert.rejects(stat(f.ws.path), { code: 'ENOENT' }, 'damaged leftovers are released, not kept forever');
    } finally { await release(); }
  });
}
test('live worker prevents resume without consuming or staling its candidate', async () => {
  const f = await fixture();
  await writeState(f.path, { repo: 'owner/lab', pr_number: 7, run_id: 'running', current_head_sha: f.current.head,
    phase: 'conflict', repair_attempts: 0, last_patchpaw_commit: null, waiting_for_ci: false, active: true, pid: process.pid });
  await assert.rejects(resumeWorkspace(f.path, f.current, f.trace), /live worker/);
  assert.equal((await readPaused(f.path))?.status, 'budget_exhausted');
});
test('concurrent stale-lock reclaim grants at most one worker ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-lock-race-')), path = join(root, 'pr.json');
  await writeFile(`${path}.lock`, '2147483647');
  await writeFile(`${path}.lock.reclaim`, '2147483647');
  const claims = await Promise.all(Array.from({ length: 12 }, () => claimRun(path)));
  assert.equal(claims.filter(Boolean).length, 1);
  for (const release of claims) if (release) await release();
});
test('a killed worker releases kernel ownership and the next process can reclaim its PID file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-lock-death-')), path = join(root, 'pr.json');
  const source = `import { claimRun } from ${JSON.stringify(new URL('../src/runner/state.ts', import.meta.url).href)};
    const release = await claimRun(${JSON.stringify(path)}); if (!release) process.exit(2);
    console.log('acquired'); setInterval(() => {}, 1000);`;
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject);
    child.once('exit', () => reject(new Error('Fixture worker failed before acquiring lock'))); });
  assert.equal(await claimRun(path), null);
  child.kill('SIGKILL'); await exited;
  let release: Awaited<ReturnType<typeof claimRun>> = null;
  for (let attempt = 0; attempt < 50 && !release; attempt++) { release = await claimRun(path); if (!release) await setTimeout(10); }
  assert.ok(release); await release();
});
