import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCommunicationStore } from '../src/runner/communication-store.ts';
import { openControlPlaneDb, closeControlPlaneDb } from '../src/control-plane/db.ts';
import { backupRuntime } from '../src/migration/backup.ts';
import { withRuntimeLock } from '../src/migration/runtime-lock.ts';
import { patchpawPaths } from '../src/config/paths.ts';

test('runtime backup uses consistent SQLite snapshots, excludes provider secrets, and includes SCM slots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-backup-'));
  const paths = patchpawPaths(root);
  const communication = await openCommunicationStore(root);
  await communication.close();
  await mkdir(paths.secrets, { recursive: true });
  await writeFile(join(paths.secrets, 'provider.key'), 'must-not-be-backed-up\n', { mode: 0o600 });
  await mkdir(join(paths.secrets, 'scm'), { recursive: true });
  await writeFile(join(paths.secrets, 'scm', 'gitlab-one.key'), 'gitlab-token\n', { mode: 0o600 });
  await mkdir(join(paths.state, 'owner__repo'), { recursive: true });
  await writeFile(join(paths.state, 'owner__repo', 'pr-7.json'), JSON.stringify({ active: false, phase: 'closed' }));
  await mkdir(join(paths.runs, 'run-1'), { recursive: true });
  await writeFile(join(paths.runs, 'run-1', 'manifest.json'), '{"safe":true}\n');

  const first = await backupRuntime({ runtimeHome: root });
  const controlPlaneFirst = first.databases.find(database => database.relative_path.endsWith('control-plane.db'))!;
  assert.equal(controlPlaneFirst.exists, false);
  assert.equal(first.databases.find(database => database.relative_path.endsWith('communication.db'))?.backup_integrity, 'ok');
  assert.equal(first.databases.find(database => database.relative_path.endsWith('communication.db'))?.backup, 'databases/data/communication.db');
  assert.equal(first.databases.find(database => database.relative_path.endsWith('communication.db'))?.source_snapshot_sha256,
    first.databases.find(database => database.relative_path.endsWith('communication.db'))?.sha256);
  assert.ok(first.files.some(file => file.path.endsWith('data/state/owner__repo/pr-7.json')));
  assert.deepEqual(first.active_workers, []);
  assert.ok(first.excluded_paths.includes('secrets'));
  assert.equal((await stat(first.backup_path)).mode & 0o777, 0o700);
  assert.equal(await stat(join(first.backup_path, 'manifest.json')).then(() => true), true);
  assert.equal(await stat(join(first.backup_path, 'files', 'data', 'state', 'owner__repo', 'pr-7.json')).then(() => true), true);
  assert.equal(await stat(join(first.backup_path, 'secrets')).then(() => true, () => false), false);
  assert.equal((await readFile(join(first.backup_path, 'manifest.json'), 'utf8')).includes('must-not-be-backed-up'), false);
  assert.equal(await readFile(join(first.backup_path, 'files', 'secrets', 'scm', 'gitlab-one.key'), 'utf8'), 'gitlab-token\n');

  const controlPlane = await openControlPlaneDb(root);
  closeControlPlaneDb(controlPlane);
  const second = await backupRuntime({ runtimeHome: root });
  const controlPlaneSecond = second.databases.find(database => database.relative_path.endsWith('control-plane.db'))!;
  assert.equal(controlPlaneSecond.exists, true);
  assert.equal(controlPlaneSecond.integrity, 'ok');
  assert.equal(controlPlaneSecond.backup_integrity, 'ok');
  await assert.rejects(backupRuntime({ runtimeHome: root, destination: first.backup_path }), /already exists/);
});

test('runtime backup refuses a marked active worker before creating a destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-backup-active-'));
  const paths = patchpawPaths(root);
  await mkdir(join(paths.state, 'owner__repo'), { recursive: true });
  await writeFile(join(paths.state, 'owner__repo', 'pr-7.json'), JSON.stringify({ active: true, pid: 12345 }));
  await assert.rejects(backupRuntime({ runtimeHome: root }), /Active PatchPaw workers/);
  assert.equal(await stat(paths.backups).then(() => true, () => false), false);
});

test('runtime backup refuses an active marker whose ownership cannot be verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-backup-invalid-active-'));
  const paths = patchpawPaths(root);
  await mkdir(join(paths.state, 'owner__repo'), { recursive: true });
  await writeFile(join(paths.state, 'owner__repo', 'pr-7.json'), JSON.stringify({ active: true }));
  await assert.rejects(backupRuntime({ runtimeHome: root }), /Cannot verify active worker marker/);
  assert.equal(await stat(paths.backups).then(() => true, () => false), false);
});

test('runtime backup cannot race a worker holding the shared runtime lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-backup-lock-'));
  let enter!: () => void;
  let leave!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const release = new Promise<void>(resolve => { leave = resolve; });
  const worker = withRuntimeLock(root, 'shared', false, async () => { enter(); await release; });
  await entered;
  await assert.rejects(backupRuntime({ runtimeHome: root }), /cutover lock is busy/);
  leave();
  await worker;
});
