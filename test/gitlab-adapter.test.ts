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
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'token', fetchImpl }));
  const snapshot = await adapter.readChangeRequest('88', 3);
  assert.equal(snapshot.source.projectId, '99');
  assert.equal(snapshot.source.cloneUrl, 'https://git.example/fork/repo.git');
  const auth = await adapter.verifyInboundComment({ platform: 'gitlab', connectionId: 'prod', projectId: '88', storageKey: 'gitlab:prod:project:88', repositoryPath: 'group/repo', changeRequestNumber: 3, remoteId: 501, authorId: '17', authorLogin: 'dev', body: '@patchpaw /review', url: 'https://git.example/note', sourceEventId: 'hook-1' });
  assert.equal(auth.canExecute, true);
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
