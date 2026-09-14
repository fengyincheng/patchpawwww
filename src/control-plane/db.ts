import { createClient, type Client, type Row, type Transaction } from '@libsql/client';
import { access, chmod, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { patchpawPaths } from '../config/paths.ts';
import { CONTROL_PLANE_MIGRATION_VERSION, CONTROL_PLANE_SCHEMA_VERSION, ensureControlPlaneSchema } from './schema.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';

export type DbArgs = Record<string, string | number | null>;

export interface ControlPlaneExecutor {
  execute(sql: string, args?: DbArgs): Promise<{ rows: Row[]; rowsAffected?: number }>;
}

export function rowValue(row: Row, key: string) {
  return row[key] as string | number | bigint | null | undefined;
}

export function textValue(row: Row, key: string, fallback = '') {
  const value = rowValue(row, key);
  return value === null || value === undefined ? fallback : String(value);
}

export function numberValue(row: Row, key: string, fallback = 0) {
  const value = rowValue(row, key);
  return value === null || value === undefined ? fallback : Number(value);
}

export function booleanValue(row: Row, key: string) {
  return numberValue(row, key) === 1;
}

export function jsonValue<T>(row: Row, key: string, fallback: T): T {
  const value = rowValue(row, key);
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(String(value)) as T;
}

export function optionalNumberValue(row: Row, key: string) {
  const value = rowValue(row, key);
  return value === null || value === undefined ? null : Number(value);
}

export function isoNow() {
  return new Date().toISOString();
}

export class ControlPlaneTransaction implements ControlPlaneExecutor {
  constructor(private readonly transaction: Transaction) {}

  execute(sql: string, args?: DbArgs) {
    return this.transaction.execute({ sql, args });
  }

  commit() { return this.transaction.commit(); }
  rollback() { return this.transaction.rollback(); }
  close() { this.transaction.close(); }
}

export class ControlPlaneDb implements ControlPlaneExecutor {
  readonly path: string;

  constructor(readonly root: string, private readonly client: Client) {
    this.path = patchpawPaths(root).controlPlaneDb;
  }

  async execute(sql: string, args?: DbArgs) {
    return withRuntimeLock(this.root, 'shared', false, () => this.client.execute({ sql, args }));
  }

  async getMeta(key: string) {
    const result = await this.execute('SELECT value FROM control_plane_meta WHERE key = :key', { key });
    return result.rows[0] ? textValue(result.rows[0], 'value') : undefined;
  }

  async setMeta(key: string, value: string, executor: ControlPlaneExecutor = this) {
    await executor.execute(`INSERT INTO control_plane_meta(key, value) VALUES (:key, :value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, { key, value });
  }

  async transaction<T>(work: (transaction: ControlPlaneTransaction) => Promise<T>, mode: 'read' | 'write' = 'write') {
    return withRuntimeLock(this.root, 'shared', false, async () => {
      const rawTransaction = await this.client.transaction(mode);
      const transaction = new ControlPlaneTransaction(rawTransaction);
      try {
        const result = await work(transaction);
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      } finally {
        transaction.close();
      }
    });
  }

  async readTransaction<T>(work: (transaction: ControlPlaneTransaction) => Promise<T>) {
    return this.transaction(work, 'read');
  }

  close() {
    this.client.close();
  }
}

async function chmodIfPresent(path: string) {
  await chmod(path, 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Prepare the local control plane and return its initialized client. */
async function openInitializedControlPlaneDb(root: string) {
  const paths = patchpawPaths(root);
  return withRuntimeLock(root, 'exclusive', false, async () => {
    await mkdir(paths.data, { recursive: true, mode: 0o700 });
    await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
    await mkdir(paths.providerSecrets, { recursive: true, mode: 0o700 });
    await chmod(paths.data, 0o700);
    await chmod(paths.secrets, 0o700);
    await chmod(paths.providerSecrets, 0o700);
    const client = createClient({ url: pathToFileURL(paths.controlPlaneDb).href, timeout: 5000 });
    try {
      await client.execute('PRAGMA journal_mode=WAL');
      await ensureControlPlaneSchema(client);
      const currentRows = await client.execute('SELECT value FROM control_plane_meta WHERE key = :key', { key: 'migration_version' });
      const current = currentRows.rows[0] ? Number(String(rowValue(currentRows.rows[0], 'value'))) : 0;
      if (!Number.isInteger(current) || current > CONTROL_PLANE_MIGRATION_VERSION) {
        throw new Error(`Unsupported control-plane migration version: ${current}`);
      }
      const transaction = await client.transaction('write');
      try {
        await transaction.execute({ sql: `INSERT INTO control_plane_migrations(version, applied_at) VALUES (:version, :applied_at)
          ON CONFLICT(version) DO NOTHING`, args: { version: CONTROL_PLANE_MIGRATION_VERSION, applied_at: isoNow() } });
        await transaction.execute({ sql: `INSERT INTO control_plane_meta(key, value) VALUES ('schema_version', :value)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: { value: CONTROL_PLANE_SCHEMA_VERSION } });
        await transaction.execute({ sql: `INSERT INTO control_plane_meta(key, value) VALUES ('migration_version', :value)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: { value: String(CONTROL_PLANE_MIGRATION_VERSION) } });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      } finally { transaction.close(); }
      for (const path of [paths.controlPlaneDb, `${paths.controlPlaneDb}-wal`, `${paths.controlPlaneDb}-shm`]) {
        await chmodIfPresent(path);
      }
      return new ControlPlaneDb(root, client);
    } catch (error) {
      client.close();
      throw error;
    }
  });
}

/** Converge schema/migrations before a worker acquires the runtime shared lock. */
export async function prepareControlPlaneDb(root: string) {
  const db = await openInitializedControlPlaneDb(root);
  db.close();
}

/**
 * Open a schema that was prepared before the caller acquired a runtime shared lock.
 * This path is deliberately read-only with respect to schema/migration state: a worker
 * must never try to take the runtime exclusive lock while holding its shared lock.
 */
export async function openPreparedControlPlaneDb(root: string) {
  const paths = patchpawPaths(root);
  return withRuntimeLock(root, 'shared', false, async () => {
    await access(paths.controlPlaneDb);
    const client = createClient({ url: pathToFileURL(paths.controlPlaneDb).href, timeout: 5000 });
    try {
      await client.execute('PRAGMA foreign_keys=ON');
      const meta = await client.execute(`SELECT key, value FROM control_plane_meta
        WHERE key IN ('schema_version', 'migration_version')`);
      const versions = new Map(meta.rows.map(row => [String(row.key), String(row.value)]));
      if (versions.get('schema_version') !== CONTROL_PLANE_SCHEMA_VERSION || versions.get('migration_version') !== String(CONTROL_PLANE_MIGRATION_VERSION)) {
        throw new Error(`Control-plane schema is not prepared; expected schema ${CONTROL_PLANE_SCHEMA_VERSION}, migration ${CONTROL_PLANE_MIGRATION_VERSION}`);
      }
      return new ControlPlaneDb(root, client);
    } catch (error) {
      client.close();
      throw error;
    }
  });
}

/** Open the local control plane and converge all known migrations idempotently. */
export const openControlPlaneDb = openInitializedControlPlaneDb;
export const openControlPlaneStore = openControlPlaneDb;

export function closeControlPlaneDb(db: ControlPlaneDb) {
  db.close();
}
