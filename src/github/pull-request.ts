import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { createGitHub } from './client.ts';
import { normalizeSnapshot, saveSnapshot } from './snapshot.ts';

export async function inspectPullRequest(github: ReturnType<typeof createGitHub>, fullName: string, number: number, options: { allowClosed?: boolean } = {}) {
  const [owner, repo] = fullName.split('/');
  const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo });
  const client = github.installation(installation.id);
  const [{ data: repository }, { data: pr }] = await Promise.all([
    client.rest.repos.get({ owner, repo }), client.rest.pulls.get({ owner, repo, pull_number: number }),
  ]);
  if ((!options.allowClosed && pr.state !== 'open') || !pr.head.repo) throw new Error('PR is not open or has no head repository');
  const snapshot = normalizeSnapshot({ action: 'synchronize', installation, repository, pull_request: pr },
    `api-${randomUUID()}`, new Date().toISOString());
  return { client, repository, pr, snapshot, owner, repo, installationId: installation.id };
}
export async function capturePullRequest(github: ReturnType<typeof createGitHub>, fullName: string, number: number, root: string, options: { allowClosed?: boolean } = {}) {
  const inspected = await inspectPullRequest(github, fullName, number, options);
  const saved = await saveSnapshot(root, inspected.snapshot);
  return { ...inspected, snapshotPath: saved.path };
}
export type InspectedPR = Awaited<ReturnType<typeof inspectPullRequest>>;
export async function assertCurrentPR(pr: Pick<InspectedPR, 'client' | 'owner' | 'repo'> & { pr: { number: number; base: { ref: string } } }, expectedHead: string, expectedBase: string, previousHead?: string, expectedBaseRef = pr.pr.base.ref, expectedHeadRef?: string, expectedHeadRepo?: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { data: current } = await pr.client.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.pr.number });
    // PR payload base.sha may lag the moving branch tip; compare the actual branch API.
    const { data: branch } = await pr.client.rest.repos.getBranch({ owner: pr.owner, repo: pr.repo, branch: pr.pr.base.ref });
    const sameHeadTarget = (!expectedHeadRef || current.head.ref === expectedHeadRef)
      && (!expectedHeadRepo || current.head.repo?.full_name === expectedHeadRepo);
    const sameBaseAndOpen = branch.commit.sha === expectedBase && current.base.ref === expectedBaseRef && current.state === 'open' && sameHeadTarget;
    if (sameBaseAndOpen && current.head.sha === expectedHead) return;
    // Only our own just-pushed head may take time to appear in the PR API.
    const awaitingPush = sameBaseAndOpen && previousHead !== undefined && current.head.sha === previousHead;
    if (awaitingPush && Date.now() < deadline) {
      await setTimeout(Math.min(2000, deadline - Date.now()));
      continue;
    }
    const reason = awaitingPush ? 'Timed out confirming pushed PR head' : 'PR head, base, or open state changed during run';
    throw new Error(`${reason}: ${JSON.stringify({
      expected: { head: expectedHead, base: expectedBase, ref: expectedBaseRef, state: 'open' },
      actual: { head: current.head.sha, base: branch.commit.sha, ref: current.base.ref, state: current.state },
      previous_head: previousHead,
    })}`);
  }
}
export async function installationGitToken(pr: InspectedPR) {
  const auth = await pr.client.auth({ type: 'installation' }) as { token: string };
  return auth.token;
}
