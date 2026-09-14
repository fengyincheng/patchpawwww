import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export function createGitHub(config: { appId: number; privateKey: string }, baseUrl?: string) {
  const options = {
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
    baseUrl,
    request: { timeout: 3000 },
    // SDK errors can include request credentials; callers log only status/code.
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const app = new Octokit(options);
  const installation = (installationId: number) => new Octokit({
    ...options, auth: { ...options.auth, installationId },
  });

  return {
    app,
    installation,
    async readPullRequest(installationId: number, fullName: string, number: number) {
      const [owner, repo] = fullName.split('/');
      const client = installation(installationId);
      // One token exchange; the SDK retains the token/cache in memory only.
      await client.auth({ type: 'installation' });
      const [repository, pullRequest] = await Promise.all([
        client.rest.repos.get({ owner, repo }),
        client.rest.pulls.get({ owner, repo, pull_number: number }),
      ]);
      return { repository: repository.data, pullRequest: pullRequest.data };
    },
  };
}

// Only the external API fields consumed by this phase, not entire SDK models.
export interface GitHubReader {
  readPullRequest(installationId: number, fullName: string, number: number): Promise<{
    repository: { id: number; full_name: string; private: boolean };
    pullRequest: { number: number; base: { sha: string; repo: { id: number } }; head: { sha: string } };
  }>;
}
