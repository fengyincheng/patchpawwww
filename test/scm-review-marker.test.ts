// The GitHub SCM adapter is the path every fresh review delivery uses. Its publication
// markers must keep the run identity and the delivery identity separate, otherwise the
// dedup lookup compares nested markers that no later run can reproduce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { GitHubAdapter } from '../src/scm/github/adapter.ts';

const sha = 'c'.repeat(40);
const runId = 'fixture-run';
const deliveryMarker = '<!-- patchpaw:delivery=11111111-1111-4111-8111-111111111111 -->';

function reviewFixture() {
  const state = { creates: 0, reviews: [] as any[] };
  const client = new Octokit({ request: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    let data: unknown;
    if (init?.method === 'POST') {
      state.creates++;
      const body = JSON.parse(String(init.body));
      data = { id: state.creates, html_url: `https://github.test/review/${state.creates}`, commit_id: body.commit_id,
        body: body.body, user: { login: 'patchpawwww[bot]', type: 'Bot' }, submitted_at: '2026-11-02T17:40:00Z', state: 'COMMENTED' };
      state.reviews.push(data);
    } else {
      data = path.endsWith('/reviews') ? state.reviews
        : { state: 'open', head: { sha }, user: { login: 'author' } };
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  } } });
  return { state, client };
}

test('GitHub adapter review marker records the run id and keeps the delivery marker separate', async () => {
  const { state, client } = reviewFixture();
  const adapter = new GitHubAdapter(client, 'patchpawwww[bot]');
  await adapter.publishReview('owner/repo', 2, sha, { body: '# 代码评审\n\n实现与文档一致。' }, [], deliveryMarker, runId);
  assert.equal(state.creates, 1);
  const body = state.reviews[0].body as string;
  assert.doesNotMatch(body, /patchpaw:run=<!--/, 'the run marker must not wrap the delivery marker');
  assert.match(body, new RegExp(`<!-- patchpaw:run=${runId}:head=${sha}:kind=review -->`));
  assert.ok(body.includes(deliveryMarker), 'the delivery marker stays its own identity');
});

test('GitHub adapter adopts a pre-fix review whose run marker wrapped the delivery marker', async () => {
  const { state, client } = reviewFixture();
  const oldRunMarker = `<!-- patchpaw:run=${deliveryMarker}:head=${sha}:kind=review -->`;
  state.reviews.push({
    id: 99, html_url: 'https://github.test/review/99', commit_id: sha,
    body: `## PatchPaw review\n\nHead: \`${sha}\`\n\nold body\n\n${oldRunMarker}\n${deliveryMarker}`,
    user: { login: 'patchpawwww[bot]', type: 'Bot' }, submitted_at: '2026-11-02T17:40:00Z', state: 'COMMENTED',
  });
  const adapter = new GitHubAdapter(client, 'patchpawwww[bot]');
  const receipt = await adapter.publishReview('owner/repo', 2, sha, { body: '# 代码评审\n\n新正文' }, [], deliveryMarker, 'new-run');
  assert.equal(state.creates, 0, 'a retry must not publish a duplicate review');
  assert.equal(receipt.reused, true);
  assert.equal(receipt.id, 99);
});

test('GitHub adapter does not adopt a review carrying another delivery marker', async () => {
  const { state, client } = reviewFixture();
  const otherDelivery = '<!-- patchpaw:delivery=22222222-2222-4222-8222-222222222222 -->';
  state.reviews.push({
    id: 100, html_url: 'https://github.test/review/100', commit_id: sha,
    body: `## PatchPaw review\n\nHead: \`${sha}\`\n\nother body\n\n${otherDelivery}`,
    user: { login: 'patchpawwww[bot]', type: 'Bot' }, submitted_at: '2026-11-02T17:40:00Z', state: 'COMMENTED',
  });
  const adapter = new GitHubAdapter(client, 'patchpawwww[bot]');
  await adapter.publishReview('owner/repo', 2, sha, { body: '# 代码评审\n\n新正文' }, [], deliveryMarker, 'new-run');
  assert.equal(state.creates, 1);
});
