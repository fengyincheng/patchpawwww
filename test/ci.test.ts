import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Octokit } from '@octokit/rest';
import { readCI, failureEvidence } from '../src/github/ci.ts';
import { Trace } from '../src/harness/trace.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentPR } from '../src/github/pull-request.ts';

test('CI uses exact head and latest workflow attempt; actual failed job logs reach evidence', async () => {
  let phase = 'pending';
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    const url = req.url!;
    if (url.includes('/pulls/')) return res.end(JSON.stringify({ state: 'open', head: { sha: 'fixed-head' }, base: { ref: 'main', sha: 'cached-old-base' } }));
    if (url.includes('/branches/')) return res.end(JSON.stringify({ commit: { sha: 'live-main' } }));
    if (url.includes('/check-runs')) return res.end(JSON.stringify({ total_count: 1, check_runs: [
      { name: 'verify', status: phase === 'pending' ? 'in_progress' : 'completed', conclusion: phase === 'red' ? 'failure' : phase === 'green' ? 'success' : null }] }));
    if (url.includes('/status')) return res.end(JSON.stringify({ state: 'pending', statuses: [] }));
    if (url.includes('/jobs/9/logs')) { res.setHeader('Content-Type', 'text/plain'); return res.end('assertion failed: expected 4, received 3'); }
    if (url.includes('/runs/11/jobs')) return res.end(JSON.stringify({ total_count: 1, jobs: [{ id: 9, name: 'unit', conclusion: 'failure', steps: [{ name: 'test', conclusion: 'failure' }] }] }));
    if (url.includes('/actions/runs')) return res.end(JSON.stringify({ total_count: 2, workflow_runs: [
      { id: 11, workflow_id: 1, name: 'CI', status: phase === 'pending' ? 'in_progress' : 'completed', conclusion: phase === 'red' ? 'failure' : 'success', head_sha: 'fixed-head' },
      { id: 10, workflow_id: 1, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'fixed-head' }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Octokit({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  try {
    const pr = { client, owner: 'example', repo: 'repo', pr: { number: 7, base: { ref: 'main' } } };
    await assertCurrentPR(pr, 'fixed-head', 'live-main');
    await assert.rejects(assertCurrentPR(pr, 'fixed-head', 'cached-old-base'), /changed/);
    assert.equal((await readCI(client, 'example/repo', 'fixed-head')).state, 'pending');
    phase = 'red';
    const red = await readCI(client, 'example/repo', 'fixed-head');
    assert.equal(red.state, 'red');
    const evidence = await failureEvidence(client, 'example/repo', red, new Trace(await mkdtemp(join(tmpdir(), 'patchpaw-ci-test-'))));
    assert.equal(evidence.jobs[0].log, 'assertion failed: expected 4, received 3');
    phase = 'green';
    assert.equal((await readCI(client, 'example/repo', 'fixed-head')).state, 'green');
    assert.ok(urls.some(url => url.includes('head_sha=fixed-head')));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
