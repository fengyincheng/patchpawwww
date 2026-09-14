import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { enqueueCommentDelivery } from '../src/runner/outbound.ts';
import { openCommunicationStore } from '../src/runner/communication-store.ts';
import { statePath } from '../src/runner/state.ts';
import { checkpointCommunicationDatabase, inspectLegacyRuntime, migrateRuntime } from '../src/migration/runtime.ts';
import { workerEnvironment } from '../src/runner/dispatch.ts';
import { disposeWorkspacePath, ensureRepo, fetchPRState, createWorktree, repoCachePath } from '../src/workspace/repo-store.ts';
import { git } from '../src/workspace/git.ts';
import { Trace } from '../src/harness/trace.ts';

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-migration-'));
  const legacyHome = join(root, 'source');
  const runtimeHome = join(root, 'runtime');
  await mkdir(join(legacyHome, 'var'), { recursive: true });
  return { root, legacyHome, legacyVar: join(legacyHome, 'var'), runtimeHome };
}

async function seedCommunication(legacyVar: string) {
  const seed = await mkdtemp(join(tmpdir(), 'patchpaw-communication-seed-'));
  const item = await enqueueCommentDelivery({ root: seed, repo: 'owner/repo', prNumber: 7,
    purpose: 'conversation_reply', semanticKey: 'existing', body: 'existing', mentions: ['owner'], botLogin: 'patchpawwww[bot]' });
  const store = await openCommunicationStore(seed);
  const marker = await store.getMeta('file_queue_import_v1');
  await store.close();
  await checkpointCommunicationDatabase(join(seed, 'data', 'communication.db'));
  await mkdir(join(legacyVar, 'data'), { recursive: true });
  await cp(join(seed, 'data', 'communication.db'), join(legacyVar, 'communication.db'));
  const queue = join(legacyVar, 'outbox', 'owner%2Frepo', 'pr-7');
  await mkdir(queue, { recursive: true });
  await writeFile(join(queue, 'legacy.json'), JSON.stringify(item.item) + '\n');
  return marker;
}

async function seedTerminalWorkspace(legacyVar: string, legacyHome: string) {
  const remote = join(legacyHome, 'fixture-remote');
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-b', 'main']);
  await git(remote, ['config', 'user.name', 'Fixture']);
  await git(remote, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(remote, 'file.txt'), 'fixture\n');
  await git(remote, ['add', '.']); await git(remote, ['commit', '-m', 'fixture']);
  const head = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  const trace = new Trace(join(legacyHome, 'fixture-trace'));
  await ensureRepo(legacyVar, 'owner/repo', remote, trace);
  await fetchPRState(legacyVar, 'owner/repo', { headSha: head, baseRef: 'main' }, trace);
  const workspace = join(legacyVar, 'workspaces', 'terminal-run');
  await createWorktree(legacyVar, 'owner/repo', workspace, head, trace);
  await mkdir(join(legacyVar, 'runs', 'terminal-run'), { recursive: true });
  await writeFile(join(legacyVar, 'runs', 'terminal-run', 'manifest.json'), JSON.stringify({
    run_id: 'terminal-run', repo: 'owner/repo', pr_number: 7, workspace_path: workspace,
  }) + '\n');
  await writeFile(join(legacyVar, 'runs', 'terminal-run', 'result.json'), JSON.stringify({ status: 'review_completed' }) + '\n');
  await writeFile(statePath(join(legacyVar, 'state'), 'owner/repo', 7), JSON.stringify({
    repo: 'owner/repo', pr_number: 7, run_id: 'terminal-run', phase: 'review_completed', active: false, pid: 1,
  }) + '\n');
  return { workspace, repo: repoCachePath(legacyVar, 'owner/repo') };
}

test('runtime migration copies durable data, keeps historical manifests, and does Git-aware terminal cleanup', async () => {
  const f = await makeRoot();
  const marker = await seedCommunication(f.legacyVar);
  await mkdir(join(f.legacyVar, 'memory'), { recursive: true });
  const memory = createClient({ url: pathToFileURL(join(f.legacyVar, 'memory', 'thread.db')).href });
  await memory.execute('CREATE TABLE memory_fixture(value TEXT)');
  await memory.execute("INSERT INTO memory_fixture VALUES ('memory')");
  memory.close();
  await mkdir(join(f.legacyVar, 'snapshots', 'owner__repo', 'pr-7'), { recursive: true });
  await writeFile(join(f.legacyVar, 'snapshots', 'owner__repo', 'pr-7', 'snapshot.json'), '{"historic":true}\n');
  await mkdir(join(f.legacyVar, 'state', 'owner__repo'), { recursive: true });
  const workspace = await seedTerminalWorkspace(f.legacyVar, f.legacyHome);
  const manifestPath = join(f.legacyVar, 'runs', 'terminal-run', 'manifest.json');
  const historicalManifest = await readFile(manifestPath, 'utf8');

  const before = await inspectLegacyRuntime(f.legacyHome, f.runtimeHome);
  assert.equal(before.workspaceDirs, 1); assert.equal(before.workspaces[0]?.disposition, 'terminal');
  assert.equal(before.communication?.meta.file_queue_import_v1, marker);
  const report = await migrateRuntime({ legacyHome: f.legacyHome, runtimeHome: f.runtimeHome, cleanupTerminalWorkspaces: true });

  assert.deepEqual(report.removedTerminalWorkspaces, [workspace.workspace]);
  assert.equal(report.after.stateFiles, 1);
  assert.equal(report.after.memoryDbs, 1);
  assert.equal(report.after.runDirs, 1);
  assert.equal(report.after.snapshotFiles, 1);
  assert.equal(report.after.repoDirs, 1);
  assert.equal(report.after.workspaceDirs, 0);
  assert.equal(report.after.communication?.meta.schema_version, '1');
  assert.equal(report.after.communication?.meta.file_queue_import_v1, marker);
  assert.equal(report.after.communication?.outbound, 1);
  assert.equal(await readFile(join(report.legacyArchivedRoot, 'runs', 'terminal-run', 'manifest.json'), 'utf8'), historicalManifest);
  assert.equal(await readFile(join(f.runtimeHome, 'runs', 'terminal-run', 'manifest.json'), 'utf8'), historicalManifest);
  assert.match(await readFile(join(f.runtimeHome, 'data', 'outbox', 'owner%2Frepo', 'pr-7', 'legacy.json'), 'utf8'), /existing/);
  await assert.rejects(stat(workspace.workspace), { code: 'ENOENT' });
  const worktrees = (await git(join(f.runtimeHome, 'repos', 'owner%2Frepo.git'), ['worktree', 'list', '--porcelain'])).stdout;
  assert.equal(worktrees.trim().split('\n').length, 2); assert.match(worktrees, /^bare$/m);

  const reopened = await openCommunicationStore(f.runtimeHome, f.legacyHome);
  try {
    assert.equal((await reopened.listOutbound()).length, 1, 'the imported legacy queue marker prevents duplicate import');
    assert.equal(await reopened.getMeta('file_queue_import_v1'), marker);
  } finally { await reopened.close(); }
});

test('paused workspace blocks migration and is never deleted', async () => {
  const f = await makeRoot();
  const workspace = join(f.legacyVar, 'workspaces', 'paused-run');
  await mkdir(workspace, { recursive: true });
  const path = statePath(join(f.legacyVar, 'state'), 'owner/repo', 7);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ repo: 'owner/repo', pr_number: 7, run_id: 'paused-run', phase: 'needs_human', active: false, pid: 1 }) + '\n');
  await writeFile(`${path}.paused.json`, JSON.stringify({ status: 'needs_human', run_id: 'paused-run', execution_id: 1,
    task: 'conflict', base_sha: 'base', base_ref: 'main', local_head: 'head', workspace: { path: workspace } }) + '\n');
  const inventory = await inspectLegacyRuntime(f.legacyHome, f.runtimeHome);
  assert.equal(inventory.workspaces[0]?.disposition, 'paused');
  await assert.rejects(migrateRuntime({ legacyHome: f.legacyHome, runtimeHome: f.runtimeHome, cleanupTerminalWorkspaces: true }), /Paused workspaces/);
  assert.equal((await stat(workspace)).isDirectory(), true);
});

test('a failed migration removes its staging tree and never publishes a partial runtime', async () => {
  const f = await makeRoot();
  await seedCommunication(f.legacyVar);
  await assert.rejects(migrateRuntime({ legacyHome: f.legacyHome, runtimeHome: f.runtimeHome, cleanupTerminalWorkspaces: true }), /Required runtime directory is missing/);
  assert.equal(await stat(f.runtimeHome).then(() => true, () => false), false);
  assert.equal((await readdir(f.root)).some(name => name.startsWith('runtime.migration-')), false);
});

test('workspace disposal refuses the shared repository, durable data, and runtime home', async () => {
  const f = await makeRoot();
  for (const target of [join(f.runtimeHome, 'repos'), join(f.runtimeHome, 'data'), f.runtimeHome]) {
    await assert.rejects(disposeWorkspacePath(f.runtimeHome, 'owner/repo', target), /outside the workspace boundary/);
  }
});

test('detached workers always receive the selected runtime home', () => {
  assert.equal(workerEnvironment('fixture-runtime-home', { PATCHPAW_HOME: '/old', TEST: 'kept' }).PATCHPAW_HOME, 'fixture-runtime-home');
  assert.equal(workerEnvironment('fixture-runtime-home', { PATCHPAW_HOME: '/old', TEST: 'kept' }).TEST, 'kept');
});
