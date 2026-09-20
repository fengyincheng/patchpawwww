import type { Octokit } from '@octokit/rest';
import { readCI as readGitHubCI, failureEvidence as readGitHubFailureEvidence } from '../../github/ci.ts';
import { publishReview as publishGitHubReview } from '../../github/review-publisher.ts';
import { storageKey } from '../identity.ts';
import type {
  ActorAuthorization, ChangeRequestSnapshot, InboundScmComment, ScmAdapter, ScmCiState,
  ScmConnection, ScmDeliveryReceipt,
} from '../types.ts';
import type { ReviewPayload } from '../../tasks/review/result.ts';

const GITHUB_CONNECTION_ID = 'github-app';
const accessLevel = { pull: 20, triage: 25, push: 30, maintain: 40, admin: 50 } as const;

function repositoryParts(projectId: string) {
  const parts = projectId.split('/');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part))) {
    throw new Error('GitHub repository must be owner/name');
  }
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) throw new Error('GitHub repository must be owner/name');
  return { owner, repo, fullName: projectId };
}

function githubConnection(): ScmConnection {
  return {
    id: GITHUB_CONNECTION_ID, kind: 'github', instanceUrl: 'https://github.com',
    credentialRef: null, webhookMode: 'signing', webhookSecretRef: null,
    botUserId: null, botLogin: null, projectIds: [], enabled: true,
    createdAt: '', updatedAt: '',
  };
}

function githubRepository(connection: ScmConnection, repository: {
  id: number; full_name: string; html_url: string; clone_url: string;
}) {
  return {
    connectionId: connection.id, kind: 'github' as const, remoteProjectId: String(repository.id),
    pathWithNamespace: repository.full_name, webUrl: repository.html_url, cloneUrl: repository.clone_url,
    storageKey: storageKey('github', connection.id, repository.id),
  };
}

function permissionLevel(value: unknown) {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'pull': return accessLevel.pull;
    case 'triage': return accessLevel.triage;
    case 'push': return accessLevel.push;
    case 'maintain': return accessLevel.maintain;
    case 'admin': return accessLevel.admin;
    default: return null;
  }
}

function remoteError(message: string, status = 403) {
  return Object.assign(new Error(message), { status });
}

export class GitHubAdapter implements ScmAdapter {
  readonly kind = 'github' as const;
  readonly connection: ScmConnection;
  readonly botLogin: string;
  readonly botUserId?: string;

  constructor(readonly client: Octokit, botLogin: string, connection: ScmConnection = githubConnection()) {
    this.connection = { ...connection, botLogin };
    this.botLogin = botLogin;
    this.botUserId = this.connection.botUserId ?? undefined;
  }

  async readChangeRequest(projectId: string, number: number, options: { allowClosed?: boolean } = {}): Promise<ChangeRequestSnapshot> {
    const { owner, repo, fullName } = repositoryParts(projectId);
    const [{ data: repository }, { data: pullRequest }] = await Promise.all([
      this.client.rest.repos.get({ owner, repo }),
      this.client.rest.pulls.get({ owner, repo, pull_number: number }),
    ]);
    if (!options.allowClosed && pullRequest.state !== 'open') throw new Error('PR is not open');
    if (!pullRequest.head.repo) throw new Error('PR has no head repository');
    const { data: targetBranch } = await this.client.rest.repos.getBranch({ owner, repo, branch: pullRequest.base.ref });
    const scmRepository = githubRepository(this.connection, repository);
    return {
      schemaVersion: 1, kind: 'github', repository: scmRepository,
      changeRequest: { repository: scmRepository, number: pullRequest.number, webUrl: pullRequest.html_url },
      source: {
        projectId: String(pullRequest.head.repo.id), pathWithNamespace: pullRequest.head.repo.full_name,
        ref: pullRequest.head.ref, sha: pullRequest.head.sha, cloneUrl: pullRequest.head.repo.clone_url,
      },
      target: {
        projectId: String(repository.id), pathWithNamespace: fullName,
        ref: pullRequest.base.ref, sha: targetBranch.commit.sha,
      },
      diffBaseSha: pullRequest.base.sha, state: pullRequest.state,
      title: pullRequest.title, body: pullRequest.body ?? '',
      author: { id: pullRequest.user?.id === undefined ? null : String(pullRequest.user.id), login: pullRequest.user?.login ?? '' },
      receivedAt: new Date().toISOString(),
    };
  }

  async verifyInboundComment(comment: InboundScmComment): Promise<ActorAuthorization> {
    const { owner, repo } = repositoryParts(comment.repositoryPath);
    const [{ data: remoteComment }, { data: permission }, { data: user }] = await Promise.all([
      this.client.rest.issues.getComment({ owner, repo, comment_id: comment.remoteId }),
      this.client.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: comment.authorLogin }),
      this.client.rest.users.getByUsername({ username: comment.authorLogin }),
    ]);
    if (String(remoteComment.id) !== String(comment.remoteId)
        || String(remoteComment.body ?? '') !== comment.body
        || String(remoteComment.user?.id ?? '') !== comment.authorId) {
      throw remoteError('GitHub comment identity mismatch');
    }
    const level = permissionLevel(permission.permission);
    const activeHuman = user.type !== 'Bot';
    const isSelf = this.botUserId !== undefined && this.botUserId === String(user.id);
    const can = level !== null && level >= accessLevel.push && activeHuman && !isSelf;
    return {
      platform: 'github', actorId: comment.authorId, checkedAt: new Date().toISOString(),
      accessLevel: level, source: 'github_comment_and_collaborator_permission',
      canExecute: can, canApprove: can,
    };
  }

  async listComments(projectId: string, number: number) {
    const { owner, repo } = repositoryParts(projectId);
    const comments = await this.client.paginate(this.client.rest.issues.listComments, {
      owner, repo, issue_number: number, per_page: 100,
    });
    return comments.map(comment => ({
      id: comment.id, author: comment.user?.login ?? '', authorId: String(comment.user?.id ?? ''),
      body: comment.body ?? '', url: comment.html_url, createdAt: comment.created_at, system: false,
    }));
  }

  async publishComment(projectId: string, number: number, body: string, markers: string[]): Promise<ScmDeliveryReceipt> {
    const { owner, repo } = repositoryParts(projectId);
    if (markers.length) {
      const existing = (await this.listComments(projectId, number)).find(comment =>
        comment.author.toLowerCase() === this.botLogin.toLowerCase()
        && markers.some(marker => comment.body.includes(marker)));
      if (existing) return {
        id: existing.id, htmlUrl: existing.url, publishedAt: existing.createdAt ?? new Date().toISOString(),
        reused: true, remoteAdopted: true,
      };
    }
    const { data } = await this.client.rest.issues.createComment({ owner, repo, issue_number: number, body });
    return {
      id: data.id, htmlUrl: data.html_url, publishedAt: new Date().toISOString(), reused: false,
    };
  }

  async publishReview(projectId: string, number: number, headSha: string, review: ReviewPayload, mentions: string[], marker: string) {
    const result = await publishGitHubReview(this.client, projectId, number, headSha, review, mentions,
      { runId: marker, botLogin: this.botLogin, allowLegacy: false }, marker);
    return {
      id: result.id, htmlUrl: result.html_url, commitId: result.commit_id ?? undefined,
      publishedAt: result.published_at, reused: result.reused, remoteAdopted: result.reused,
    };
  }

  async readCI(projectId: string, number: number, sha: string): Promise<ScmCiState> {
    const ci = await readGitHubCI(this.client, projectId, sha);
    const state: ScmCiState['state'] = ci.state === 'red' ? 'red' : ci.state === 'green' ? 'green' : 'pending';
    return {
      sha, state, items: ci.items.map(item => ({
        name: item.name ?? 'unnamed check', status: item.status ?? 'unknown', conclusion: item.conclusion,
        url: item.url ?? undefined, sha,
      })),
      evidence: ci.workflowRuns.map(run => ({
        projectId, pipelineId: String(run.id), source: run.event, targetSha: run.head_sha,
      })),
    };
  }

  async failureEvidence(projectId: string, ci: ScmCiState) {
    const githubCi = await readGitHubCI(this.client, projectId, ci.sha);
    return readGitHubFailureEvidence(this.client, projectId, githubCi, { emit() { return undefined; } });
  }

  async installationGitToken() {
    const auth: unknown = await this.client.auth({ type: 'installation' });
    if (typeof auth !== 'object' || auth === null || !('token' in auth) || typeof auth.token !== 'string') {
      throw new Error('GitHub installation token is unavailable');
    }
    return auth.token;
  }
}
