import type { createGitHub } from '../../github/client.ts';
import type { ScmAdapter, ScmConnection } from '../types.ts';

/** The GitHub implementation remains the compatibility adapter for existing deployments. */
export function githubConnection(id = 'github-default', instanceUrl = 'https://github.com'): ScmConnection {
  return { id, kind: 'github', instanceUrl, credentialRef: null, webhookMode: 'secret', webhookSecretRef: null,
    botUserId: null, botLogin: null, projectIds: [], enabled: true, createdAt: '', updatedAt: '' };
}

export type GitHubRuntime = ReturnType<typeof createGitHub>;
