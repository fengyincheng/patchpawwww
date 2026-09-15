import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient } from '../src/scm/gitlab/client.ts';
import { GitLabAdapter } from '../src/scm/gitlab/adapter.ts';
import type { ScmConnection } from '../src/scm/types.ts';

const connection: ScmConnection = { id: 'prod', kind: 'gitlab', instanceUrl: 'https://git.example', credentialRef: null, webhookMode: 'secret', webhookSecretRef: null,
  botUserId: '900', botLogin: 'patchpaw', projectIds: ['88'], enabled: true, createdAt: '', updatedAt: '' };

test('GitLab adapter snapshots fork source metadata and checks member authorization', async () => {
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/projects/88')) return new Response(JSON.stringify({ id: 88, path_with_namespace: 'group/repo', web_url: 'https://git.example/group/repo', http_url_to_repo: 'https://git.example/group/repo.git' }));
    if (path.endsWith('/projects/99')) return new Response(JSON.stringify({ id: 99, path_with_namespace: 'fork/repo', web_url: 'https://git.example/fork/repo', http_url_to_repo: 'https://git.example/fork/repo.git' }));
    if (path.endsWith('/repository/branches/main')) return new Response(JSON.stringify({ commit: { id: 'target-tip' } }));
    if (path.endsWith('/merge_requests/3')) return new Response(JSON.stringify({ iid: 3, state: 'opened', source_project_id: 99, target_project_id: 88, source: { path_with_namespace: 'fork/repo' }, target: { path_with_namespace: 'group/repo' }, source_branch: 'feature/x', target_branch: 'main', sha: 'head-3', diff_refs: { base_sha: 'base-1', start_sha: 'target-tip' }, title: 'Test', description: 'Body', author: { id: 17, username: 'dev' }, web_url: 'https://git.example/group/repo/-/merge_requests/3' }));
    if (path.endsWith('/merge_requests/3/notes/501')) return new Response(JSON.stringify({ id: 501, body: '@patchpaw /review', author: { id: 17, username: 'dev' } }));
    if (path.endsWith('/members/all/17')) return new Response(JSON.stringify({ access_level: 30, state: 'active' }));
    if (path.endsWith('/users/17')) return new Response(JSON.stringify({ id: 17, username: 'dev', bot: false, state: 'active' }));
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'token', fetchImpl }));
  const snapshot = await adapter.readChangeRequest('88', 3);
  assert.equal(snapshot.source.projectId, '99');
  assert.equal(snapshot.source.cloneUrl, 'https://git.example/fork/repo.git');
  const auth = await adapter.verifyInboundComment({ platform: 'gitlab', connectionId: 'prod', projectId: '88', storageKey: 'gitlab:prod:project:88', repositoryPath: 'group/repo', changeRequestNumber: 3, remoteId: 501, authorId: '17', authorLogin: 'dev', body: '@patchpaw /review', url: 'https://git.example/note', sourceEventId: 'hook-1' });
  assert.equal(auth.canExecute, true);
});

test('GitLab authorization rejects self, bots, inactive users and unknown user types', async () => {
  const users: Record<string, any> = {
    '17': { id: 17, username: 'human', bot: false, state: 'active' },
    '18': { id: 18, username: 'other-bot', bot: true, state: 'active' },
    '19': { id: 19, username: 'blocked', bot: false, state: 'blocked' },
    '20': { id: 20, username: 'unknown', state: 'active' },
  };
  let currentActor = '17';
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    const userId = path.match(/\/users\/(\d+)$/)?.[1];
    if (userId) return new Response(JSON.stringify(users[userId] ?? {}));
    const memberId = path.match(/\/members\/all\/(\d+)$/)?.[1];
    if (memberId) return new Response(JSON.stringify({ access_level: 30, state: 'active' }));
    if (path.endsWith('/merge_requests/3/notes/501')) return new Response(JSON.stringify({ id: 501, body: '@patchpaw /review', author: { id: Number(currentActor), username: 'actor' } }));
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'token', fetchImpl }));
  const authorize = async (authorId: string) => {
    currentActor = authorId;
    return adapter.verifyInboundComment({ platform: 'gitlab', connectionId: 'prod', projectId: '88', storageKey: 'gitlab:prod:project:88', repositoryPath: 'group/repo', changeRequestNumber: 3, remoteId: 501, authorId, authorLogin: 'actor', body: '@patchpaw /review', url: 'https://git.example/note', sourceEventId: `hook-${authorId}` });
  };
  assert.equal((await authorize('17')).canExecute, true);
  assert.equal((await authorize('18')).canExecute, false);
  assert.equal((await authorize('19')).canExecute, false);
  assert.equal((await authorize('20')).canExecute, false);
  assert.equal((await authorize('900')).canExecute, false);
});

test('GitLab adapter maps CI jobs and adopts a bot marker', async () => {
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/merge_requests/3/pipelines')) return new Response(JSON.stringify([{ id: 10, sha: 'head-3', source: 'merge_request_event' }]));
    if (path.endsWith('/pipelines/10/jobs')) return new Response(JSON.stringify([{ id: 11, name: 'test', status: 'failed', allow_failure: false, web_url: 'https://git.example/job/11' }]));
    if (path.endsWith('/merge_requests/3/notes')) return new Response(JSON.stringify([{ id: 9001, body: 'result MARKER', author: { id: 900, username: 'patchpaw' }, web_url: 'https://git.example/note/9001', created_at: '2026-09-15T00:00:00Z' }]));
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'token', fetchImpl }));
  const ci = await adapter.readCI('88', 3, 'head-3');
  assert.equal(ci.state, 'red');
  const receipt = await adapter.publishComment('88', 3, 'result MARKER', ['MARKER']);
  assert.equal(receipt.reused, true);
  assert.equal(receipt.remoteAdopted, true);
});

test('GitLab CI evidence stays tied to the requested SHA and treats incomplete results as unknown', async () => {
  let scenario = 'old-green';
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/merge_requests/3/pipelines')) {
      const values: Record<string, any[]> = {
        'old-green': [{ id: 1, sha: 'old-sha', source: 'merge_request_event' }],
        pending: [{ id: 2, sha: 'new-sha', source: 'merge_request_event' }],
        failed: [{ id: 3, sha: 'new-sha', source: 'merge_request_event' }],
        skipped: [{ id: 4, sha: 'new-sha', source: 'merge_request_event' }],
        'no-jobs': [{ id: 5, sha: 'new-sha', source: 'merge_request_event' }],
      };
      return new Response(JSON.stringify(values[scenario]));
    }
    if (path.endsWith('/pipelines/1/jobs')) return new Response(JSON.stringify([{ id: 11, name: 'unit', status: 'success', allow_failure: false }]));
    if (path.endsWith('/pipelines/2/jobs')) return new Response(JSON.stringify([{ id: 12, name: 'unit', status: 'running', allow_failure: false }]));
    if (path.endsWith('/pipelines/3/jobs')) return new Response(JSON.stringify([
      { id: 13, name: 'required', status: 'failed', allow_failure: false },
      { id: 14, name: 'optional', status: 'failed', allow_failure: true },
    ]));
    if (path.endsWith('/pipelines/4/jobs')) return new Response(JSON.stringify([{ id: 15, name: 'unit', status: 'skipped', allow_failure: false }]));
    if (path.endsWith('/pipelines/5/jobs')) return new Response(JSON.stringify([]));
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'token', fetchImpl }));
  assert.equal((await adapter.readCI('88', 3, 'new-sha')).state, 'unknown');
  scenario = 'pending'; assert.equal((await adapter.readCI('88', 3, 'new-sha')).state, 'pending');
  scenario = 'failed'; assert.equal((await adapter.readCI('88', 3, 'new-sha')).state, 'red');
  scenario = 'skipped'; assert.equal((await adapter.readCI('88', 3, 'new-sha')).state, 'unknown');
  scenario = 'no-jobs'; assert.equal((await adapter.readCI('88', 3, 'new-sha')).state, 'unknown');
});
