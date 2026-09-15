import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GitHubReader } from './client.ts';
import { safeStorageDirectory } from '../scm/identity.ts';

const fullName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const revision = z.object({ ref: z.string().min(1), sha: z.string().regex(/^[a-f0-9]{40}$/) });
export const supportedActions = ['opened', 'synchronize', 'reopened'] as const;
const eventSchema = z.object({
  action: z.enum(supportedActions),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ id: z.number().int().positive(), full_name: fullName, private: z.boolean() }),
  pull_request: z.object({
    number: z.number().int().positive(), title: z.string(), html_url: z.url(),
    base: revision,
    head: revision.extend({ repo: z.object({ full_name: fullName }).nullable().optional() }),
  }),
});

export function normalizeSnapshot(payload: unknown, delivery: string, receivedAt: string) {
  const event = eventSchema.parse(payload);
  const pr = event.pull_request;
  return {
    schema_version: 1 as const, event: 'pull_request' as const,
    action: event.action, delivery_id: delivery, received_at: receivedAt,
    installation_id: event.installation.id, repository: event.repository,
    pull_request: { number: pr.number, title: pr.title, html_url: pr.html_url },
    base: pr.base, head: pr.head,
  };
}
export type PRSnapshot = ReturnType<typeof normalizeSnapshot>;

// Exact snapshot subtree of one PR, shared by the writer and by lifecycle cleanup (/close)
// so the repo-key rule is never duplicated.
export function snapshotPRDir(root: string, fullNameValue: string, number: number) {
  const directory = fullNameValue.startsWith('gitlab:') ? safeStorageDirectory(fullNameValue) : fullNameValue.replace('/', '__');
  return join(root, directory, `pr-${number}`);
}
export async function saveSnapshot(root: string, snapshot: PRSnapshot) {
  const path = join(snapshotPRDir(root, snapshot.repository.full_name, snapshot.pull_request.number), `${snapshot.delivery_id}.json`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    return { snapshot, path, duplicate: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A redelivery keeps the original received_at and event revisions.
    return { snapshot: JSON.parse(await readFile(path, 'utf8')) as PRSnapshot, path, duplicate: true };
  }
}

export async function verifySnapshot(snapshot: PRSnapshot, github: GitHubReader) {
  const { repository, pullRequest } = await github.readPullRequest(snapshot.installation_id, snapshot.repository.full_name, snapshot.pull_request.number);
  const identityMatches = repository.id === snapshot.repository.id
    && repository.full_name.toLowerCase() === snapshot.repository.full_name.toLowerCase()
    && repository.private === snapshot.repository.private
    && pullRequest.number === snapshot.pull_request.number && pullRequest.base.repo.id === repository.id;
  const shaMatches = pullRequest.base.sha === snapshot.base.sha && pullRequest.head.sha === snapshot.head.sha;
  return {
    status: !identityMatches ? 'identity_mismatch' : shaMatches ? 'matched' : 'stale',
    checked_at: new Date().toISOString(),
    repository: { id: repository.id, full_name: repository.full_name, private: repository.private },
    pull_request: { number: pullRequest.number, base_sha: pullRequest.base.sha, head_sha: pullRequest.head.sha },
    identity_matches: identityMatches, sha_matches: shaMatches,
  };
}

export async function saveVerification(snapshotPath: string, result: object) {
  const path = snapshotPath.replace(/\.json$/, `.verification.${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return path;
}
