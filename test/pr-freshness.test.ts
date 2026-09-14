import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Octokit } from '@octokit/rest';
import { assertCurrentPR } from '../src/github/pull-request.ts';

function githubFixture() {
  const state = { head: 'previous-head', base: 'live-main', ref: 'main', open: true };
  const client = new Octokit({ request: { fetch: async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).includes('/pulls/')
      ? { state: state.open ? 'open' : 'closed', head: { sha: state.head }, base: { ref: state.ref } }
      : { commit: { sha: state.base } },
  ), { headers: { 'Content-Type': 'application/json' } }) } });
  return { state, pr: { client, owner: 'example', repo: 'repo', pr: { number: 7, base: { ref: 'main' } } } };
}

test('own push waits for the previous PR head to converge to the published head', async () => {
  const { state, pr } = githubFixture();
  const confirmation = assertCurrentPR(pr, 'published-head', 'live-main', 'previous-head')
    .then(() => 'confirmed', (error: Error) => error.message);
  await setImmediate();
  state.head = 'published-head';
  assert.equal(await confirmation, 'confirmed');
});

test('unchanged old head times out with expected and actual state evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { pr } = githubFixture();
  const confirmation = assertCurrentPR(pr, 'published-head', 'live-main', 'previous-head')
    .then(() => 'confirmed', (error: Error) => error.message);
  await setImmediate();
  t.mock.timers.tick(30_000);
  const message = await confirmation;
  assert.match(message, /Timed out confirming pushed PR head/);
  assert.match(message, /"expected":\{"head":"published-head"/);
  assert.match(message, /"actual":\{"head":"previous-head"/);
});

test('ordinary checks and genuine PR changes still stop immediately', async () => {
  for (const change of [{ head: 'someone-elses-head' }, { base: 'new-main' }, { ref: 'release' }, { open: false }]) {
    const { state, pr } = githubFixture();
    Object.assign(state, change);
    await assert.rejects(assertCurrentPR(pr, 'published-head', 'live-main', 'previous-head'), /changed during run.*"expected".*"actual"/);
  }
  const { state, pr } = githubFixture();
  await assert.rejects(assertCurrentPR(pr, 'published-head', 'live-main'), /changed during run/);
  state.head = 'published-head';
  await assertCurrentPR(pr, 'published-head', 'live-main');
});
