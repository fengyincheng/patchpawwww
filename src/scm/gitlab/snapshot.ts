import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorageDirectory } from '../identity.ts';
import type { ChangeRequestSnapshot } from '../types.ts';

export function scmSnapshotDir(root: string, storage: string, number: number) {
  return join(root, safeStorageDirectory(storage), `mr-${number}`);
}

export async function saveScmSnapshot(root: string, snapshot: ChangeRequestSnapshot, deliveryId = `api-${randomUUID()}`) {
  const path = join(scmSnapshotDir(root, snapshot.repository.storageKey, snapshot.changeRequest.number), `${deliveryId}.json`);
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); return { path, duplicate: false, snapshot }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { path, duplicate: true, snapshot: JSON.parse(await readFile(path, 'utf8')) as ChangeRequestSnapshot };
  }
}
