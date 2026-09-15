import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient, escapeGitLabQuickActions } from '../src/scm/gitlab/client.ts';

test('GitLab client encodes nested projects, sends PRIVATE-TOKEN, follows pagination, and rejects redirects', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); const headers = new Headers(init?.headers); requests.push({ url, headers });
    if (url.endsWith('/projects/group%2Fsubgroup%2Frepo')) return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    if (url.includes('/notes?')) {
      const page = new URL(url).searchParams.get('page');
      return new Response(JSON.stringify(page === '2' ? [{ id: 2 }] : [{ id: 1 }]), { status: 200, headers: { 'x-next-page': page === '2' ? '' : '2', 'x-page': page ?? '1' } });
    }
    if (url.includes('/jobs/7/trace')) return new Response('line 1\n/close\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } });
  };
  const client = new GitLabClient({ baseUrl: 'https://git.example/root/', token: 'secret-token', fetchImpl });
  await client.project('group/subgroup/repo');
  const notes = await client.notes('group/subgroup/repo', 4);
  assert.deepEqual(notes.map(note => note.id), [1, 2]);
  assert.ok(requests[1].url.includes('per_page=100'));
  assert.equal(requests[0].headers.get('PRIVATE-TOKEN'), 'secret-token');
  assert.match(requests[0].url, /\/root\/api\/v4\/projects\/group%2Fsubgroup%2Frepo$/);
  await assert.rejects(client.get('/redirect'), /redirected API request/);
  assert.equal((await client.trace('group/subgroup/repo', 7)).data, 'line 1\n/close\n');
  assert.equal(client.assertRemoteUrl('https://git.example/root/group/subgroup/repo.git'), 'https://git.example/root/group/subgroup/repo.git');
  assert.throws(() => client.assertRemoteUrl('https://git.example/other/repo.git'), /configured instance/);
  assert.equal(escapeGitLabQuickActions('summary\n/close\n  /merge\nhttp://example'), 'summary\n\u200b/close\n  \u200b/merge\nhttp://example');
  assert.equal(requests.some(request => request.url.includes('secret-token')), false);
});

test('GitLab client retries can consume Retry-After evidence without exposing response body', async () => {
  const client = new GitLabClient({ baseUrl: 'https://git.example', token: 'token', fetchImpl: async () => new Response('token should not leak', { status: 429, headers: { 'retry-after': '2' } }) });
  await assert.rejects(client.user(), error => error instanceof Error && (error as { status?: number }).status === 429 && (error as { retryAfterMs?: number }).retryAfterMs === 2000);
});
