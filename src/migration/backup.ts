import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { patchpawPaths } from '../config/paths.ts';
import { withRuntimeLock } from './runtime-lock.ts';

export const RUNTIME_BACKUP_SCHEMA_VERSION = 'patchpaw.runtime-backup.v1';

export interface RuntimeBackupDatabase {
  source: string;
  relative_path: string;
  exists: boolean;
  backup: string | null;
  source_main_sha256?: string;
  source_snapshot?: string;
  source_snapshot_sha256?: string;
  integrity?: string;
  backup_integrity?: string;
  journal_mode?: string;
  wal_bytes?: number;
  bytes?: number;
  sha256?: string;
}

export interface RuntimeBackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RuntimeBackupReport {
  schema_version: typeof RUNTIME_BACKUP_SCHEMA_VERSION;
  created_at: string;
  runtime_home: string;
  backup_path: string;
  active_workers: Array<{ path: string; pid: number }>;
  databases: RuntimeBackupDatabase[];
  copied_paths: string[];
  missing_paths: string[];
  files: RuntimeBackupFile[];
  excluded_paths: string[];
}

function portableRelative(root: string, path: string) {
  return relative(root, path).split(sep).join('/');
}

async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function activeWorkers(stateRoot: string) {
  const workers: Array<{ path: string; pid: number }> = [];
  for (const repository of await entries(stateRoot)) {
    if (!repository.isDirectory()) continue;
    for (const entry of await entries(join(stateRoot, repository.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(stateRoot, repository.name, entry.name);
      let value: Record<string, unknown>;
      try { value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`Cannot inspect runtime state before backup: ${path}`);
      }
      if (value.active !== true) continue;
      if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
        throw new Error(`Cannot verify active worker marker before backup: ${path}`);
      }
      workers.push({ path, pid: Number(value.pid) });
    }
  }
  return workers;
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fileBytes(path: string) {
  try { return (await stat(path)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function databaseBackup(source: string, runtimeHome: string, stagingRoot: string): Promise<RuntimeBackupDatabase> {
  const relativePath = portableRelative(runtimeHome, source);
  const result: RuntimeBackupDatabase = { source, relative_path: relativePath, exists: await exists(source), backup: null };
  if (!result.exists) return result;

  const destination = join(stagingRoot, 'databases', relativePath);
  const sourceSnapshot = join(stagingRoot, 'database-snapshots', relativePath);
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
  await mkdir(join(sourceSnapshot, '..'), { recursive: true, mode: 0o700 });
  const client = createClient({ url: pathToFileURL(source).href, timeout: 5000 });
  try {
    const integrity = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed for ${source}: ${integrity}`);
    const journalMode = String((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode ?? '');
    result.integrity = integrity;
    result.journal_mode = journalMode;
    result.wal_bytes = await fileBytes(`${source}-wal`);
    result.source_main_sha256 = await sha256(source);
    // VACUUM INTO takes a transactionally consistent snapshot, including WAL state;
    // copying only the main database file would be unsafe while the service is live.
    await client.execute(`VACUUM INTO ${sqlString(sourceSnapshot)}`);
  } finally { client.close(); }

  const sourceSnapshotClient = createClient({ url: pathToFileURL(sourceSnapshot).href, timeout: 5000 });
  try {
    const snapshotIntegrity = String((await sourceSnapshotClient.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (snapshotIntegrity !== 'ok') throw new Error(`SQLite source snapshot integrity check failed for ${sourceSnapshot}: ${snapshotIntegrity}`);
  } finally { sourceSnapshotClient.close(); }
  result.source_snapshot = `database-snapshots/${relativePath}`;
  result.source_snapshot_sha256 = await sha256(sourceSnapshot);
  await cp(sourceSnapshot, destination, { force: false, errorOnExist: true });

  const backupClient = createClient({ url: pathToFileURL(destination).href, timeout: 5000 });
  try {
    result.backup_integrity = String((await backupClient.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (result.backup_integrity !== 'ok') throw new Error(`SQLite backup integrity check failed for ${destination}: ${result.backup_integrity}`);
  } finally { backupClient.close(); }
  result.backup = `databases/${relativePath}`;
  result.bytes = await fileBytes(destination);
  result.sha256 = await sha256(destination);
  if (result.source_snapshot_sha256 !== result.sha256) throw new Error(`SQLite source/copy snapshot hash mismatch for ${source}`);
  return result;
}

async function durableFileRecords(root: string, relativeRoot: string): Promise<RuntimeBackupFile[]> {
  const records: RuntimeBackupFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) records.push(...await durableFileRecords(path, relativePath));
    else if (entry.isFile()) records.push({ path: relativePath, bytes: await fileBytes(path), sha256: await sha256(path) });
    else throw new Error(`Unsupported durable runtime entry in backup: ${path}`);
  }
  return records;
}

async function copyDurablePath(source: string, runtimeHome: string, stagingRoot: string) {
  if (!await exists(source)) return false;
  const destination = join(stagingRoot, 'files', portableRelative(runtimeHome, source));
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return durableFileRecords(destination, relative(runtimeHome, source));
}

/**
 * Create a rollback artifact for a runtime home without including provider
 * secrets. SQLite files are copied through VACUUM INTO so a live WAL database
 * is backed up from a consistent snapshot rather than by copying its main file.
 */
export async function backupRuntime(options: { runtimeHome: string; destination?: string }): Promise<RuntimeBackupReport> {
  const runtimeHome = resolve(options.runtimeHome);
  return withRuntimeLock(runtimeHome, 'exclusive', true, async () => {
    const paths = patchpawPaths(runtimeHome);
    const workers = await activeWorkers(paths.state);
    if (workers.length) throw new Error(`Active PatchPaw workers found; refusing backup: ${JSON.stringify(workers)}`);

    const backupRoot = resolve(options.destination ?? join(paths.backups, `runtime-${new Date().toISOString().replaceAll(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`));
    if (await exists(backupRoot)) throw new Error(`Backup destination already exists: ${backupRoot}`);
    await mkdir(join(backupRoot, '..'), { recursive: true, mode: 0o700 });
    const stagingRoot = `${backupRoot}.tmp-${randomUUID()}`;
    let committed = false;
    try {
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const databaseSources = [paths.communicationDb, paths.controlPlaneDb,
        ...(await entries(paths.memory)).filter(entry => entry.isFile() && entry.name.endsWith('.db')).map(entry => join(paths.memory, entry.name))];
      const databases = [];
      for (const source of databaseSources) databases.push(await databaseBackup(source, runtimeHome, stagingRoot));

      const durableSources = [paths.state, paths.outbox, paths.runs, paths.snapshots];
      const copiedPaths: string[] = [];
      const missingPaths: string[] = [];
      const files: RuntimeBackupFile[] = [];
      for (const source of durableSources) {
        const copied = await copyDurablePath(source, runtimeHome, stagingRoot);
        const relativePath = portableRelative(runtimeHome, source);
        if (copied) { copiedPaths.push(relativePath); files.push(...copied); }
        else missingPaths.push(relativePath);
      }

      const report: RuntimeBackupReport = {
        schema_version: RUNTIME_BACKUP_SCHEMA_VERSION,
        created_at: new Date().toISOString(),
        runtime_home: runtimeHome,
        backup_path: backupRoot,
        active_workers: workers,
        databases,
        copied_paths: copiedPaths,
        missing_paths: missingPaths,
        files,
        excluded_paths: ['secrets', 'repos', 'workspaces', 'logs', 'cache', 'tmp', 'locks'],
      };
      await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      await rename(stagingRoot, backupRoot);
      committed = true;
      return report;
    } finally {
      if (!committed) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
