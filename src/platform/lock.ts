import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isProcessAlive } from './process.ts';

export type FileLockMode = 'shared' | 'exclusive';

export class FileLockBusyError extends Error {
  readonly code = 'PATCHPAW_LOCK_BUSY';

  constructor(path: string) {
    super(`PatchPaw lock is busy: ${path}`);
    this.name = 'FileLockBusyError';
  }
}

export class FileLockTimeoutError extends Error {
  readonly code = 'PATCHPAW_LOCK_TIMEOUT';

  constructor(path: string) {
    super(`PatchPaw lock acquisition timed out: ${path}`);
    this.name = 'FileLockTimeoutError';
  }
}

interface LocalOwnership {
  lockDirectory: string;
  ownerDirectory: string;
  physicalMode: FileLockMode;
  sharedCount: number;
  exclusiveCount: number;
}

interface LockOptions {
  nonblock?: boolean;
  timeoutMs?: number;
  /** Re-enter only from the async context which already owns this lock. */
  reentrant?: boolean;
}

const ownershipContext = new AsyncLocalStorage<ReadonlySet<string>>();
const localOwnership = new Map<string, LocalOwnership>();
const pollMs = 25;

function lockDirectoryFor(path: string) {
  return `${resolve(path)}.patchpaw-lock`;
}

function ownerName(mode: FileLockMode, pid: number, token: string) {
  return `owner-${mode}-${pid}-${token}`;
}

function parseOwner(name: string) {
  const match = /^owner-(shared|exclusive)-(\d+)-([0-9a-f-]+)$/.exec(name);
  return match ? { mode: match[1] as FileLockMode, pid: Number(match[2]), name } : undefined;
}

async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // Windows does not implement POSIX mode bits as an access-control boundary.
  // Avoid treating chmod's emulation there as a prerequisite for startup.
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function listEntries(lockDirectory: string) {
  try { return await readdir(lockDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function removeStaleEntries(lockDirectory: string, entries?: Awaited<ReturnType<typeof listEntries>>) {
  for (const entry of entries ?? await listEntries(lockDirectory)) {
    const parsed = parseOwner(entry.name);
    if (parsed && !isProcessAlive(parsed.pid)) {
      await rm(join(lockDirectory, entry.name), { recursive: true, force: true });
      continue;
    }
  }
}

async function acquireGate(lockDirectory: string, nonblock: boolean, timeoutMs?: number) {
  const gatePath = join(lockDirectory, 'gate');
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (true) {
    await secureDirectory(lockDirectory);
    const token = randomUUID();
    const temporaryOwner = join(lockDirectory, `gate-owner-${process.pid}-${token}.tmp`);
    await writeFile(temporaryOwner, JSON.stringify({
      pid: process.pid,
      token,
      kind: 'gate',
      acquired_at: new Date().toISOString(),
    }) + '\n', { mode: 0o600 });
    try {
      // link() atomically creates gatePath without replacing an existing gate.
      // Both paths are in the same directory, including on Windows/NTFS.
      await link(temporaryOwner, gatePath);
      return gatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryOwner, { force: true });
    }

    let ownerPid: number | undefined;
    try {
      const value = JSON.parse(await readFile(gatePath, 'utf8')) as { pid?: unknown };
      if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) ownerPid = Number(value.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A malformed owner cannot be safely attributed to a dead process.
        // Keep it as a busy lock instead of breaking a possibly live holder.
        if (nonblock) throw new FileLockBusyError(lockDirectory);
      }
    }
    if (ownerPid === undefined) {
      if (nonblock) throw new FileLockBusyError(lockDirectory);
    } else if (isProcessAlive(ownerPid)) {
      if (nonblock) throw new FileLockBusyError(lockDirectory);
    } else {
      // A complete owner record whose PID is dead is safe to reclaim. Multiple
      // reclaimers may race, but only one can re-link the fixed gatePath.
      await rm(gatePath, { force: true });
      continue;
    }
    if (deadline !== undefined && Date.now() >= deadline) throw new FileLockTimeoutError(lockDirectory);
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, pollMs));
  }
}

async function releaseGate(gate: string) {
  await rm(gate, { recursive: true, force: true });
}

async function activeOwners(lockDirectory: string) {
  const entries = await listEntries(lockDirectory);
  await removeStaleEntries(lockDirectory, entries);
  return (await listEntries(lockDirectory))
    .map(entry => parseOwner(entry.name))
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);
}

async function acquirePhysical(path: string, mode: FileLockMode, options: Required<Pick<LockOptions, 'nonblock'>> & Pick<LockOptions, 'timeoutMs'>) {
  const lockDirectory = lockDirectoryFor(path);
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  while (true) {
    const gate = await acquireGate(lockDirectory, options.nonblock, deadline === undefined ? undefined : Math.max(0, deadline - Date.now()));
    try {
      const owners = await activeOwners(lockDirectory);
      const canAcquire = mode === 'shared'
        ? !owners.some(owner => owner.mode === 'exclusive')
        : owners.length === 0;
      if (canAcquire) {
        const token = randomUUID();
        const ownerDirectory = join(lockDirectory, ownerName(mode, process.pid, token));
        await mkdir(ownerDirectory, { mode: 0o700 });
        await writeFile(join(ownerDirectory, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token,
          mode,
          acquired_at: new Date().toISOString(),
          // This is descriptive metadata only. Reclamation is based on a dead PID,
          // never on an expired lease, so a slow live holder is not broken.
          lease_until: null,
        }) + '\n', { mode: 0o600 });
        return { lockDirectory, ownerDirectory, physicalMode: mode } satisfies Pick<LocalOwnership, 'lockDirectory' | 'ownerDirectory' | 'physicalMode'>;
      }
    } finally {
      await releaseGate(gate);
    }
    if (options.nonblock) throw new FileLockBusyError(path);
    if (deadline !== undefined && Date.now() >= deadline) throw new FileLockTimeoutError(path);
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, pollMs));
  }
}

function localRelease(ownership: LocalOwnership, mode: FileLockMode) {
  if (mode === 'shared') ownership.sharedCount--;
  else ownership.exclusiveCount--;
  if (ownership.sharedCount < 0 || ownership.exclusiveCount < 0) return Promise.resolve();
  if (ownership.sharedCount !== 0 || ownership.exclusiveCount !== 0) return Promise.resolve();
  localOwnership.delete(ownership.lockDirectory);
  return rm(ownership.ownerDirectory, { recursive: true, force: true });
}

/**
 * Acquire a portable process lock backed only by atomic filesystem operations.
 *
 * A short-lived fixed gate serializes changes to the owner directory. Shared
 * owners can coexist; an exclusive owner requires there to be no shared owners.
 * Owner records encode their PID, allowing a later process to reclaim entries
 * left by a process that died without releasing them. A live PID is never
 * reclaimed.
 */
export async function acquireFileLock(path: string, mode: FileLockMode, options: LockOptions = {}) {
  const lockPath = resolve(path);
  const reentrant = options.reentrant !== false;
  const context = ownershipContext.getStore();
  const existing = localOwnership.get(lockDirectoryFor(lockPath));
  if (reentrant && context?.has(lockDirectoryFor(lockPath)) && existing) {
    if (existing.physicalMode === 'shared' && mode === 'exclusive') {
      throw new FileLockBusyError(lockPath);
    }
    if (mode === 'shared') existing.sharedCount++;
    else existing.exclusiveCount++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await localRelease(existing, mode);
    };
  }

  const physical = await acquirePhysical(lockPath, mode, {
    nonblock: options.nonblock ?? false,
    timeoutMs: options.timeoutMs,
  });
  const ownership: LocalOwnership = { ...physical, sharedCount: mode === 'shared' ? 1 : 0, exclusiveCount: mode === 'exclusive' ? 1 : 0 };
  localOwnership.set(physical.lockDirectory, ownership);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await localRelease(ownership, mode);
  };
}

export async function tryAcquireFileLock(path: string, mode: FileLockMode, options: Omit<LockOptions, 'nonblock'> = {}) {
  try { return await acquireFileLock(path, mode, { ...options, nonblock: true }); }
  catch (error) { if (error instanceof FileLockBusyError) return null; throw error; }
}

export async function withFileLock<T>(path: string, mode: FileLockMode, options: LockOptions, work: () => Promise<T>) {
  const release = await acquireFileLock(path, mode, options);
  const lockDirectory = lockDirectoryFor(path);
  const parent = ownershipContext.getStore();
  const next = new Set(parent ?? []);
  next.add(lockDirectory);
  try { return await ownershipContext.run(next, work); }
  finally { await release(); }
}
