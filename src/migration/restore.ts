import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { patchpawPaths } from '../config/paths.ts';
import { withRuntimeLock } from './runtime-lock.ts';
import { RUNTIME_BACKUP_SCHEMA_VERSION, type RuntimeBackupDatabase, type RuntimeBackupFile, type RuntimeBackupReport } from './backup.ts';

const durablePaths = ['data/state', 'data/outbox', 'runs', 'snapshots', 'secrets/scm', 'secrets/scm-webhook'] as const;

export interface RuntimeRestoreReport {
  schema_version: typeof RUNTIME_BACKUP_SCHEMA_VERSION;
  runtime_home: string;
  backup_path: string;
  restored_databases: string[];
  removed_databases: string[];
  restored_paths: string[];
  removed_paths: string[];
  previous_runtime_path: string;
}

async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function safeRelative(value: string, label: string) {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe ${label} in runtime backup manifest`);
  }
  return normalized;
}

function portableRelative(root: string, path: string) {
  return relative(root, path).split(sep).join('/');
}

function inside(root: string, path: string) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Runtime backup path escapes its root: ${path}`);
  }
  return resolvedPath;
}

async function verifyDatabase(backupRoot: string, database: RuntimeBackupDatabase) {
  if (!database.exists) return;
  if (!database.backup || !database.sha256 || !database.source_snapshot || !database.source_snapshot_sha256
    || database.backup_integrity !== 'ok') {
    throw new Error(`Runtime backup database evidence is incomplete: ${database.relative_path}`);
  }
  const backup = inside(backupRoot, join(backupRoot, safeRelative(database.backup, 'database backup')));
  if (await sha256(backup) !== database.sha256) throw new Error(`Runtime backup hash mismatch: ${database.backup}`);
  const snapshot = inside(backupRoot, join(backupRoot, safeRelative(database.source_snapshot, 'source snapshot')));
  if (await sha256(snapshot) !== database.source_snapshot_sha256
    || database.source_snapshot_sha256 !== database.sha256) throw new Error(`Runtime backup snapshot hash mismatch: ${database.relative_path}`);
  for (const [path, label] of [[snapshot, 'source snapshot'], [backup, 'backup']] as const) {
    const client = createClient({ url: pathToFileURL(path).href, timeout: 5000 });
    try {
      const integrity = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
      if (integrity !== 'ok') throw new Error(`Runtime backup ${label} integrity check failed: ${database.relative_path}`);
    } finally { client.close(); }
  }
}

async function readManifest(backupPath: string): Promise<RuntimeBackupReport> {
  const manifestPath = join(backupPath, 'manifest.json');
  let value: RuntimeBackupReport;
  try { value = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeBackupReport; }
  catch (error) { throw new Error(`Cannot read runtime backup manifest: ${(error as Error).message}`); }
  if (value.schema_version !== RUNTIME_BACKUP_SCHEMA_VERSION || value.backup_path !== backupPath
    || !Array.isArray(value.active_workers) || !Array.isArray(value.databases)
    || !Array.isArray(value.copied_paths) || !Array.isArray(value.missing_paths) || !Array.isArray(value.files)) {
    throw new Error('Unsupported or malformed runtime backup manifest');
  }
  return value;
}

async function rejectActiveState(path: string) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await rejectActiveState(child);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const value = JSON.parse(await readFile(child, 'utf8')) as Record<string, unknown>;
      if (value.active === true) throw new Error(`Runtime backup contains an active worker marker: ${relative(path, child)}`);
    }
  }
}

async function durableFileRecords(root: string, relativeRoot: string): Promise<RuntimeBackupFile[]> {
  const records: RuntimeBackupFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = join(relativeRoot, entry.name);
    if (entry.isDirectory()) records.push(...await durableFileRecords(path, relativePath));
    else if (entry.isFile()) records.push({ path: relativePath, bytes: (await stat(path)).size, sha256: await sha256(path) });
    else throw new Error(`Unsupported durable runtime entry in restore: ${path}`);
  }
  return records;
}

async function protectSecretTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await protectSecretTree(child);
    else if (entry.isFile()) await chmod(child, 0o600);
    else throw new Error(`Unsupported secret entry in restore: ${child}`);
  }
}

async function verifyDurableFiles(backupRoot: string, copied: Set<string>, files: RuntimeBackupFile[]) {
  const expected = new Map<string, RuntimeBackupFile>();
  for (const file of files) {
    const path = safeRelative(file.path, 'durable file');
    if (![...copied].some(root => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`Runtime backup file is outside a copied durable path: ${path}`);
    }
    if (expected.has(path)) throw new Error(`Duplicate durable file in runtime backup manifest: ${path}`);
    const source = inside(backupRoot, join(backupRoot, 'files', path));
    if (!await exists(source) || (await stat(source)).isDirectory() || await sha256(source) !== file.sha256
      || (await stat(source)).size !== file.bytes) throw new Error(`Runtime backup file hash mismatch: ${path}`);
    expected.set(path, { ...file, path });
  }
  for (const root of copied) {
    const actual = await durableFileRecords(join(backupRoot, 'files', root), root);
    if (actual.length !== [...expected.keys()].filter(path => path === root || path.startsWith(`${root}/`)).length) {
      throw new Error(`Runtime backup durable file set mismatch: ${root}`);
    }
    for (const file of actual) {
      const wanted = expected.get(file.path);
      if (!wanted || wanted.sha256 !== file.sha256 || wanted.bytes !== file.bytes) {
        throw new Error(`Runtime backup durable file set mismatch: ${file.path}`);
      }
    }
  }
}

function databaseTarget(runtimeHome: string, database: RuntimeBackupDatabase) {
  const rel = safeRelative(database.relative_path, 'database source');
  if (rel === 'data/communication.db' || rel === 'data/control-plane.db'
    || /^data\/memory\/[^/]+\.db$/.test(rel)) return inside(runtimeHome, join(runtimeHome, rel));
  throw new Error(`Runtime backup contains an unsupported database path: ${rel}`);
}

interface ArchivedPath { target: string; archived: string }

async function moveToArchive(target: string, archiveRoot: string, relativeTarget: string): Promise<ArchivedPath | undefined> {
  if (!await exists(target)) return undefined;
  const archived = inside(archiveRoot, join(archiveRoot, relativeTarget));
  await mkdir(dirname(archived), { recursive: true, mode: 0o700 });
  await rename(target, archived);
  return { target, archived };
}

async function stageCopy(source: string, stagingRoot: string, relativeTarget: string) {
  const staged = inside(stagingRoot, join(stagingRoot, relativeTarget));
  await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
  await cp(source, staged, { recursive: true, force: false, errorOnExist: true });
  return staged;
}

/** Restore durable state, control-plane data, and the explicitly included SCM secret slots. */
export async function restoreRuntime(options: { runtimeHome: string; backupPath: string }): Promise<RuntimeRestoreReport> {
  const runtimeHome = resolve(options.runtimeHome);
  const backupPath = resolve(options.backupPath);
  return withRuntimeLock(runtimeHome, 'exclusive', true, async () => {
    const manifest = await readManifest(backupPath);
    if (manifest.active_workers.length) throw new Error('Runtime backup records active workers; refusing restore');
    const paths = patchpawPaths(runtimeHome);
    await rejectActiveState(join(backupPath, 'files', 'data', 'state'));

    const databases = new Map<string, RuntimeBackupDatabase>();
    let communicationSeen = false;
    let controlPlaneSeen = false;
    for (const database of manifest.databases) {
      const target = databaseTarget(runtimeHome, database);
      const rel = portableRelative(runtimeHome, target);
      if (databases.has(rel)) throw new Error(`Duplicate database in runtime backup manifest: ${rel}`);
      databases.set(rel, database);
      communicationSeen ||= rel === 'data/communication.db';
      controlPlaneSeen ||= rel === 'data/control-plane.db';
      if (database.exists) {
        if (!database.backup) throw new Error(`Runtime backup database has no copy: ${rel}`);
        await verifyDatabase(backupPath, database);
        if (!await exists(join(backupPath, safeRelative(database.backup, 'database backup')))) {
          throw new Error(`Runtime backup database is missing: ${database.backup}`);
        }
      }
    }
    if (!communicationSeen || !controlPlaneSeen) throw new Error('Runtime backup is missing a required database record');

    const copied = new Set(manifest.copied_paths.map(path => safeRelative(path, 'copied path')));
    const missing = new Set(manifest.missing_paths.map(path => safeRelative(path, 'missing path')));
    for (const path of [...copied, ...missing]) {
      if (!(durablePaths as readonly string[]).includes(path)) throw new Error(`Unsupported runtime backup path: ${path}`);
    }
    for (const path of durablePaths) {
      if (copied.has(path) === missing.has(path)) throw new Error(`Runtime backup durable path is ambiguous: ${path}`);
      if (copied.has(path) && !await exists(join(backupPath, 'files', path))) throw new Error(`Runtime backup path is missing: ${path}`);
    }
    await verifyDurableFiles(backupPath, copied, manifest.files);

    const token = randomUUID();
    const stagingRoot = join(paths.tmp, `restore-${token}`);
    const archiveRoot = join(paths.backups, `restore-old-${token}`);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    const stagedDatabases = new Map<string, string>();
    const stagedDurable = new Map<string, string>();
    const archived: ArchivedPath[] = [];
    const installed: string[] = [];
    const restoredDatabases: string[] = [];
    const removedDatabases: string[] = [];
    try {
      for (const [rel, database] of databases) {
        if (database.exists) stagedDatabases.set(rel, await stageCopy(join(backupPath, safeRelative(database.backup!, 'database backup')), stagingRoot, rel));
      }
      for (const path of durablePaths) {
        if (copied.has(path)) stagedDurable.set(path, await stageCopy(join(backupPath, 'files', path), stagingRoot, path));
      }

      const expectedMemory = new Set([...databases.keys()].filter(path => path.startsWith('data/memory/')));
      const currentMemory = await readdir(paths.memory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      const extraMemory = new Set<string>();
      for (const entry of currentMemory) {
        const base = entry.name.replace(/-(?:wal|shm)$/, '');
        if (base.endsWith('.db')) extraMemory.add(base);
      }
      for (const base of extraMemory) {
        const rel = `data/memory/${base}`;
        if (expectedMemory.has(rel)) continue;
        const target = join(paths.memory, base);
        const previous = await moveToArchive(target, archiveRoot, rel);
        if (previous) { archived.push(previous); removedDatabases.push(rel); }
        for (const suffix of ['-wal', '-shm']) {
          const previousSidecar = await moveToArchive(`${target}${suffix}`, archiveRoot, `${rel}${suffix}`);
          if (previousSidecar) archived.push(previousSidecar);
        }
      }
      for (const [rel, database] of databases) {
        const target = join(runtimeHome, rel);
        const previous = await moveToArchive(target, archiveRoot, rel);
        if (previous) { archived.push(previous); database.exists ? restoredDatabases.push(rel) : removedDatabases.push(rel); }
        for (const suffix of ['-wal', '-shm']) {
          const previousSidecar = await moveToArchive(`${target}${suffix}`, archiveRoot, `${rel}${suffix}`);
          if (previousSidecar) archived.push(previousSidecar);
        }
        const staged = stagedDatabases.get(rel);
        if (staged) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await rename(staged, target);
          installed.push(target);
          await chmod(target, 0o600);
        }
      }

      const restoredPaths: string[] = [];
      const removedPaths: string[] = [];
      for (const path of durablePaths) {
        const target = join(runtimeHome, path);
        const previous = await moveToArchive(target, archiveRoot, path);
        if (previous) { archived.push(previous); copied.has(path) ? restoredPaths.push(path) : removedPaths.push(path); }
        const staged = stagedDurable.get(path);
        if (staged) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await rename(staged, target);
          installed.push(target);
          if (path.startsWith('secrets/')) await protectSecretTree(target);
          else await chmod(target, 0o700);
        }
      }
      await writeFile(join(archiveRoot, 'manifest.json'), `${JSON.stringify({ schema_version: 'patchpaw.runtime-restore.v1', backup_path: backupPath }, null, 2)}\n`, { mode: 0o600 });
      return { schema_version: RUNTIME_BACKUP_SCHEMA_VERSION, runtime_home: runtimeHome, backup_path: backupPath,
        restored_databases: restoredDatabases, removed_databases: removedDatabases,
        restored_paths: restoredPaths, removed_paths: removedPaths, previous_runtime_path: archiveRoot };
    } catch (error) {
      let rollbackError: unknown;
      try {
        // Remove every newly installed path first, then restore old paths in
        // reverse order. This keeps a failed command from leaving a mixed
        // state; the archive remains available if rollback itself fails.
        for (const target of installed.reverse()) {
          if (!await exists(target)) continue;
          const failedPath = inside(stagingRoot, join(stagingRoot, 'failed', portableRelative(runtimeHome, target)));
          await mkdir(dirname(failedPath), { recursive: true, mode: 0o700 });
          await rename(target, failedPath);
        }
        for (const previous of archived.reverse()) {
          if (await exists(previous.target)) throw new Error(`Rollback target is unexpectedly occupied: ${previous.target}`);
          await mkdir(dirname(previous.target), { recursive: true, mode: 0o700 });
          await rename(previous.archived, previous.target);
        }
        await rm(archiveRoot, { recursive: true, force: true });
      } catch (rollbackFailure) { rollbackError = rollbackFailure; }
      if (rollbackError) throw new Error(`Runtime restore failed and automatic rollback was incomplete: ${(rollbackError as Error).message}`);
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
