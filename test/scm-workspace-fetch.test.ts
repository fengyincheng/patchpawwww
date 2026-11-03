import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { statePath, readState } from '../src/runner/state.ts';
import { fixture } from './helpers/pr-fixture.ts';

test('GitHub private fork Review fetches the canonical head through base origin and records the same normalized snapshot', async t => {
  const f = await fixture(t, false);
  const firstHead = (await git(f.remote, ['rev-parse', 'feature'])).stdout.trim();
  await git(f.remote, ['checkout', 'feature']);
  await writeFile(join(f.remote, 'sample.txt'), 'advanced head\n');
  await git(f.remote, ['add', 'sample.txt']); await git(f.remote, ['commit', '-m', 'Advance feature head']);
  const finalHead = (await git(f.remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(f.remote, ['checkout', 'main']);
  f.control.prHeadRepo = 'private-contributor/lab';
  f.control.prHeadCloneUrl = 'https://github.com/private-contributor/inaccessible.git';
  f.control.prHeadSequence = [firstHead, finalHead];
  await f.mention('@patchpawwww /review');

  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'review_completed');
  assert.equal(f.modelInputs.length, 1, 'the review Agent starts after workspace creation');
  const runDir = join(f.root, 'runs', result.run_id!);
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const state = await readState(statePath(join(f.root, 'data/state'), 'owner/lab', 7));
  assert.equal(typeof manifest.scm_snapshot_path, 'string', JSON.stringify(manifest));
  const normalizedSnapshot = JSON.parse(await readFile(manifest.scm_snapshot_path, 'utf8').catch(error => {
    throw new Error(`Missing canonical SCM snapshot at ${manifest.scm_snapshot_path}: ${(error as Error).message}`);
  }));
  const events = (await readFile(join(runDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(state?.current_head_sha, finalHead);
  assert.equal(manifest.initial_head_sha, finalHead);
  assert.equal(normalizedSnapshot.source.sha, finalHead, JSON.stringify({ firstHead, finalHead, recordedHead: normalizedSnapshot.source.sha, path: manifest.scm_snapshot_path }));
  assert.equal(events.find(event => event.event === 'worktree_created')?.head_sha, finalHead);
  const fetches = events.filter(event => event.event === 'git' && event.args.includes('fetch'));
  assert.ok(fetches.some(event => event.args.includes('origin') && event.args.includes(finalHead)));
  assert.ok(fetches.every(event => !event.args.includes(f.control.prHeadCloneUrl)), 'the inaccessible fork remote is never fetched');
});
