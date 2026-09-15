import { LibSQLStore } from '@mastra/libsql';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changeRequestThreadId } from '../scm/identity.ts';

export interface PRMemory { root: string; repo: string; number: number }
export function prThreadId(repo: string, number: number) {
  return repo.startsWith('gitlab:') ? changeRequestThreadId('gitlab', repo.toLowerCase(), number) : `github:${repo.toLowerCase()}:pr:${number}`;
}
// Exact storage location of one PR's durable Memory database, so lifecycle code (e.g. /close)
// never duplicates the hashing scheme or touches another PR's storage.
export function prMemoryPath(root: string, repo: string, number: number) {
  return join(root, `${createHash('sha256').update(prThreadId(repo, number)).digest('hex')}.db`);
}
export function taskMemory(pr: PRMemory | undefined, runId: string, directory: string) {
  const thread = pr ? prThreadId(pr.repo, pr.number) : `run:${runId}`;
  const root = pr?.root ?? join(directory, 'memory');
  mkdirSync(root, { recursive: true });
  const file = pr ? prMemoryPath(root, pr.repo, pr.number)
    : join(root, `${createHash('sha256').update(thread).digest('hex')}.db`);
  return { state: { thread, resource: thread }, storage: new LibSQLStore({ id: 'pr-memory',
    url: pathToFileURL(file).href }) };
}
