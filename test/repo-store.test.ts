import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { ensureRepo, fetchPRState, createWorktree, removeWorktree, disposeWorkspacePath, repoCachePath, runWorkspacePath, validateRepoRelativePath } from '../src/workspace/repo-store.ts';
import { prepareWorkspace } from '../src/workspace/manager.ts';
import { Trace } from '../src/harness/trace.ts';

// One "GitHub repository" fixture with diverged feature/main so merges really conflict.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-repo-store-'));
  const remote = join(root, 'remote'); await mkdir(remote);
  await git(remote, ['init', '-b', 'main']);
  await git(remote, ['config', 'user.name', 'Fixture']); await git(remote, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(remote, 'sample.txt'), 'base\n'); await git(remote, ['add', '.']); await git(remote, ['commit', '-m', 'base']);
  await git(remote, ['checkout', '-b', 'feature']); await writeFile(join(remote, 'sample.txt'), 'feature\n'); await git(remote, ['commit', '-am', 'feature']);
  const head = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(remote, ['checkout', 'main']); await writeFile(join(remote, 'sample.txt'), 'main\n'); await git(remote, ['commit', '-am', 'main']);
  const main = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, remote, head, main, trace: new Trace(join(root, 'trace')) };
}

test('one shared object database serves many independent worktrees', async () => {
  const f = await fixture();
  const cache = await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  assert.equal(cache, repoCachePath(f.root, 'owner/lab'));
  assert.equal(cache, join(f.root, 'repos', `${encodeURIComponent('owner/lab')}.git`));
  await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  const wsA = runWorkspacePath(f.root, 'run-a'), wsB = runWorkspacePath(f.root, 'run-b');
  await createWorktree(f.root, 'owner/lab', wsA, f.head, f.trace);
  await createWorktree(f.root, 'owner/lab', wsB, f.main, f.trace);
  const registered = (await git(cache, ['worktree', 'list', '--porcelain'])).stdout;
  assert.ok(registered.includes(`worktree ${wsA}`) && registered.includes(`worktree ${wsB}`));
  // Linked worktrees: .git is a pointer file; neither workspace owns an object database.
  for (const ws of [wsA, wsB]) {
    assert.equal((await stat(join(ws, '.git'))).isFile(), true);
    await assert.rejects(stat(join(ws, '.git', 'objects')));
  }
  // A real merge conflict in A leaves B completely unaffected.
  const a = await prepareWorkspace({ path: wsA, headSha: f.head, baseRef: 'main' }, f.trace);
  assert.deepEqual(a.unmerged, ['sample.txt']);
  assert.equal(a.mergePending, true);
  assert.equal((await git(wsB, ['status', '--porcelain'])).stdout, '');
  assert.equal(await readFile(join(wsB, 'sample.txt'), 'utf8'), 'main\n');
  // An object written from one worktree is immediately visible to the other: one store.
  await writeFile(join(wsA, 'probe.txt'), 'shared\n');
  const blob = (await git(wsA, ['hash-object', '-w', 'probe.txt'])).stdout.trim();
  assert.equal((await git(wsB, ['cat-file', '-e', `${blob}^{blob}`], undefined, undefined, true)).exitCode, 0);
});

test('repository-relative evidence paths reject host paths and traversal', () => {
  assert.equal(validateRepoRelativePath('src/file.ts'), 'src/file.ts');
  assert.equal(validateRepoRelativePath('src\\dir\\file.ts'), 'src/dir/file.ts');
  for (const path of ['../outside', 'src\\..\\outside', 'src/../../outside', '/absolute/path', '\\absolute\\path', 'C:\\absolute\\path', 'has\0nul', '']) {
    assert.throws(() => validateRepoRelativePath(path), /Repository path/);
  }
});

test('every run fetches fresh remote state without touching an existing paused worktree', async () => {
  const f = await fixture();
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  const first = await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  assert.deepEqual(first, { baseRef: 'main', currentBaseTipSha: f.main });
  const ws = runWorkspacePath(f.root, 'run-a');
  await createWorktree(f.root, 'owner/lab', ws, f.head, f.trace);
  await writeFile(join(ws, 'notes.txt'), 'paused work\n');
  const cache = repoCachePath(f.root, 'owner/lab');
  assert.equal((await git(cache, ['rev-parse', 'origin/main'])).stdout.trim(), f.main);
  // Upstream advances; the next run's fetch must see it while the paused worktree stays put.
  await writeFile(join(f.remote, 'later.txt'), 'advanced\n');
  await git(f.remote, ['add', '.']); await git(f.remote, ['commit', '-m', 'advance']);
  const advanced = (await git(f.remote, ['rev-parse', 'main'])).stdout.trim();
  const fetched = await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  assert.deepEqual(fetched, { baseRef: 'main', currentBaseTipSha: advanced });
  assert.equal((await git(cache, ['rev-parse', 'origin/main'])).stdout.trim(), advanced);
  assert.equal((await git(ws, ['rev-parse', 'HEAD'])).stdout.trim(), f.head);
  assert.equal(await readFile(join(ws, 'notes.txt'), 'utf8'), 'paused work\n');
  assert.equal((await git(ws, ['status', '--porcelain'])).stdout.trim(), '?? notes.txt');
  // A rewound (force-pushed) base branch is still reflected: tracking refs update forcibly.
  await git(f.remote, ['update-ref', 'refs/heads/main', f.main]);
  await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  assert.equal((await git(cache, ['rev-parse', 'origin/main'])).stdout.trim(), f.main);
});

test('concurrent runs on one repo serialize shared-repo metadata without corrupting refs', async () => {
  const f = await fixture();
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  await Promise.all([
    fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace),
    fetchPRState(f.root, 'owner/lab', { headSha: f.main, baseRef: 'main' }, f.trace),
    ensureRepo(f.root, 'owner/lab', f.remote, f.trace),
  ]);
  await Promise.all(['run-a', 'run-b', 'run-c'].map((run, i) =>
    createWorktree(f.root, 'owner/lab', runWorkspacePath(f.root, run), i === 1 ? f.main : f.head, f.trace)));
  const cache = repoCachePath(f.root, 'owner/lab');
  assert.equal((await git(cache, ['rev-parse', 'origin/main'])).stdout.trim(), f.main);
  const registered = (await git(cache, ['worktree', 'list', '--porcelain'])).stdout;
  for (const run of ['run-a', 'run-b', 'run-c']) assert.ok(registered.includes(runWorkspacePath(f.root, run)));
  // After setup the worktrees work independently.
  assert.equal((await git(runWorkspacePath(f.root, 'run-a'), ['rev-parse', 'HEAD'])).stdout.trim(), f.head);
  assert.equal((await git(runWorkspacePath(f.root, 'run-b'), ['rev-parse', 'HEAD'])).stdout.trim(), f.main);
  assert.equal((await git(runWorkspacePath(f.root, 'run-c'), ['status', '--porcelain'])).stdout, '');
});

test('removeWorktree unregisters a disposable workspace and tolerates missing paths', async () => {
  const f = await fixture();
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  const ws = runWorkspacePath(f.root, 'run-a');
  await createWorktree(f.root, 'owner/lab', ws, f.head, f.trace);
  await writeFile(join(ws, 'dirty.txt'), 'build output\n');
  await removeWorktree(f.root, 'owner/lab', ws, f.trace);
  await assert.rejects(stat(ws), { code: 'ENOENT' });
  const cache = repoCachePath(f.root, 'owner/lab');
  assert.ok(!(await git(cache, ['worktree', 'list', '--porcelain'])).stdout.includes(ws));
  await removeWorktree(f.root, 'owner/lab', ws, f.trace); // crash-leftover convergence is harmless
  // The shared store itself is untouched and remains usable for a later fresh run.
  const again = runWorkspacePath(f.root, 'run-b');
  await createWorktree(f.root, 'owner/lab', again, f.head, f.trace);
  assert.equal((await git(again, ['rev-parse', 'HEAD'])).stdout.trim(), f.head);
});

test('one repo key keeps exactly one cache and reconciles a changed remote URL', async () => {
  const f = await fixture();
  const caches = async () => (await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git'));
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace); // later runs reuse, never re-init
  assert.deepEqual(await caches(), [`${encodeURIComponent('owner/lab')}.git`]);
  const relocated = join(f.root, 'relocated'); await mkdir(relocated);
  await git(relocated, ['init', '-b', 'main']);
  await ensureRepo(f.root, 'owner/lab', relocated, f.trace);
  assert.equal((await git(repoCachePath(f.root, 'owner/lab'), ['remote', 'get-url', 'origin'])).stdout.trim(), relocated);
  // Still exactly one cache; the persistent lock guard inode beside it is by design.
  assert.deepEqual(await caches(), [`${encodeURIComponent('owner/lab')}.git`]);
});

test('disposal is structurally bounded to real workspace paths and never the shared store', async () => {
  const f = await fixture();
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  const cache = repoCachePath(f.root, 'owner/lab');
  const memoryDir = join(f.root, 'data/memory'); await mkdir(memoryDir, { recursive: true });
  const memoryFile = join(memoryDir, 'x.db'); await writeFile(memoryFile, 'db\n');
  const runDir = join(f.root, 'runs', 'some-run'); await mkdir(runDir, { recursive: true });
  const stateDir = join(f.root, 'data/state', 'owner__lab'); await mkdir(stateDir, { recursive: true });
  const forbidden = [
    cache, join(cache, 'objects'), join(f.root, 'repos'),
    memoryDir, memoryFile,
    stateDir, join(stateDir, 'pr-7.json'),
    join(f.root, 'snapshots'), runDir, join(runDir, 'manifest.json'),
    join(f.root, 'workspaces'), join(f.root, 'workspaces', 'a', 'b'),
    join(f.root, 'remote'), join(f.root, 'var'), f.root, 'var/workspaces/relative',
  ];
  for (const target of forbidden) {
    await assert.rejects(disposeWorkspacePath(f.root, 'owner/lab', target), /outside the workspace boundary/,
      `must refuse ${target}`);
  }
  // Everything forbidden survives untouched, above all the shared repository.
  assert.equal((await git(cache, ['rev-parse', '--is-bare-repository'])).stdout.trim(), 'true');
  assert.ok((await stat(memoryFile)).isFile());
  assert.ok((await stat(runDir)).isDirectory());
  assert.ok((await stat(join(f.root, 'remote'))).isDirectory());
  // Allowed: the new-layout worktree root and the legacy per-run clone location.
  const ws = runWorkspacePath(f.root, 'boundary-run');
  await createWorktree(f.root, 'owner/lab', ws, f.head, f.trace);
  await disposeWorkspacePath(f.root, 'owner/lab', ws, f.trace);
  await assert.rejects(stat(ws), { code: 'ENOENT' });
  assert.ok(!(await git(cache, ['worktree', 'list', '--porcelain'])).stdout.includes(ws), 'metadata converged');
  const legacy = join(f.root, 'runs', 'legacy-run', 'workspace');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'f.txt'), 'x\n');
  await disposeWorkspacePath(f.root, 'owner/lab', legacy, f.trace);
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
  assert.ok((await stat(join(f.root, 'runs', 'legacy-run'))).isDirectory(),
    'only the workspace subtree goes, never the run directory itself');
});

test('a half-initialized cache converges on the next ensureRepo without reclone', async () => {
  const f = await fixture();
  const cache = repoCachePath(f.root, 'owner/lab');
  // Simulate the crash window: the bare init succeeded, remote and identity never ran.
  await mkdir(dirname(cache), { recursive: true });
  await git(dirname(cache), ['init', '--bare', cache]);
  await assert.rejects(git(cache, ['remote', 'get-url', 'origin']), /Git command failed/);
  // The next ensure heals in place: origin added, bot identity converged, no second cache.
  await ensureRepo(f.root, 'owner/lab', f.remote, f.trace);
  assert.equal((await git(cache, ['remote', 'get-url', 'origin'])).stdout.trim(), f.remote);
  assert.equal((await git(cache, ['config', 'user.name'])).stdout.trim(), 'patchpawwww[bot]');
  assert.equal((await git(cache, ['config', 'user.email'])).stdout.trim(), 'patchpawwww[bot]@users.noreply.github.com');
  assert.deepEqual((await readdir(join(f.root, 'repos'))).filter(name => name.endsWith('.git')),
    [`${encodeURIComponent('owner/lab')}.git`]);
  // The healed cache fetches and serves worktrees normally.
  await fetchPRState(f.root, 'owner/lab', { headSha: f.head, baseRef: 'main' }, f.trace);
  const ws = runWorkspacePath(f.root, 'healed-run');
  await createWorktree(f.root, 'owner/lab', ws, f.head, f.trace);
  assert.equal((await git(ws, ['rev-parse', 'HEAD'])).stdout.trim(), f.head);
  assert.equal((await stat(join(ws, '.git'))).isFile(), true);
});
