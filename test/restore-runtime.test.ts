import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCommunicationStore } from '../src/runner/communication-store.ts';
import { openControlPlaneDb, closeControlPlaneDb } from '../src/control-plane/db.ts';
import { backupRuntime } from '../src/migration/backup.ts';
import { restoreRuntime } from '../src/migration/restore.ts';
import { patchpawPaths } from '../src/config/paths.ts';

test('runtime restore verifies a backup and preserves the pre-restore runtime as a recoverable archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-restore-'));
  const paths = patchpawPaths(root);
  const communication = await openCommunicationStore(root);
  await communication.close();
  const controlPlane = await openControlPlaneDb(root);
  closeControlPlaneDb(controlPlane);
  await mkdir(join(paths.state, 'owner__repo'), { recursive: true });
  await writeFile(join(paths.state, 'owner__repo', 'pr-7.json'), JSON.stringify({ active: false, phase: 'closed' }));
  await mkdir(join(paths.runs, 'run-1'), { recursive: true });
  await writeFile(join(paths.runs, 'run-1', 'manifest.json'), '{"safe":true}\n');
  const backup = await backupRuntime({ runtimeHome: root });

  await writeFile(join(paths.state, 'owner__repo', 'pr-7.json'), JSON.stringify({ active: false, phase: 'changed' }));
  await writeFile(join(paths.runs, 'run-1', 'new.txt'), 'not in backup\n');
  const restored = await restoreRuntime({ runtimeHome: root, backupPath: backup.backup_path });
  assert.deepEqual(restored.restored_paths.sort(), ['data/state', 'runs']);
  assert.equal(JSON.parse(await readFile(join(paths.state, 'owner__repo', 'pr-7.json'), 'utf8')).phase, 'closed');
  assert.equal(await stat(join(paths.runs, 'run-1', 'new.txt')).then(() => true, () => false), false);
  assert.equal(await stat(restored.previous_runtime_path).then(() => true, () => false), true);
  assert.equal((await stat(paths.controlPlaneDb)).mode & 0o777, 0o600);
});

test('runtime restore rejects a tampered backup before changing the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-restore-tampered-'));
  const paths = patchpawPaths(root);
  const communication = await openCommunicationStore(root);
  await communication.close();
  const backup = await backupRuntime({ runtimeHome: root });
  await writeFile(join(backup.backup_path, 'databases', 'data', 'communication.db'), 'tampered\n');
  await assert.rejects(restoreRuntime({ runtimeHome: root, backupPath: backup.backup_path }), /hash mismatch/);
  assert.equal(await stat(paths.communicationDb).then(() => true, () => false), true);
});

test('runtime restore archives a memory database created after the backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-restore-extra-memory-'));
  const paths = patchpawPaths(root);
  const communication = await openCommunicationStore(root);
  await communication.close();
  const backup = await backupRuntime({ runtimeHome: root });
  await mkdir(paths.memory, { recursive: true });
  await writeFile(join(paths.memory, 'new.db'), 'new state\n');
  const restored = await restoreRuntime({ runtimeHome: root, backupPath: backup.backup_path });
  assert.ok(restored.removed_databases.includes('data/memory/new.db'));
  assert.equal(await stat(join(paths.memory, 'new.db')).then(() => true, () => false), false);
});
