import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchpawPaths } from '../config/paths.ts';
import { FileLockBusyError, withFileLock } from '../platform/lock.ts';

type RuntimeLockMode = 'shared' | 'exclusive';

export async function withRuntimeLock<T>(
  runtimeHome: string,
  mode: RuntimeLockMode,
  nonblock: boolean,
  work: () => Promise<T>,
) {
  const locks = patchpawPaths(runtimeHome).locks;
  try {
    return await withFileLock(join(locks, 'runtime-cutover.lock'), mode, { nonblock, reentrant: true }, work);
  } catch (error) {
    if (nonblock && error instanceof FileLockBusyError) throw new Error('PatchPaw runtime cutover lock is busy');
    throw error;
  }
}

/** Lock an explicit source identity without creating control files in a legacy checkout. */
export async function withCutoverSourceLock<T>(
  sourceIdentity: string,
  mode: RuntimeLockMode,
  nonblock: boolean,
  work: () => Promise<T>,
) {
  const key = createHash('sha256').update(sourceIdentity).digest('hex').slice(0, 24);
  const lockRoot = join(tmpdir(), `patchpaw-cutover-source-${key}`);
  return withFileLock(join(lockRoot, 'runtime-cutover.lock'), mode, { nonblock, reentrant: true }, work);
}
