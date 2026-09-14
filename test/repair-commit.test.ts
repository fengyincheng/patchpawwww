import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/workspace/git.ts';
import { commitRepair, validateWorkspace } from '../src/workspace/manager.ts';
import { Trace } from '../src/harness/trace.ts';
import { nodeExit, nodeFileExists } from './helpers/portable-commands.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-commit-test-'));
  const path = join(root, 'workspace'); await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.name', 'Fixture']);
  await git(path, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(path, 'value.txt'), 'before\n');
  await git(path, ['add', '.']); await git(path, ['commit', '-m', 'initial']);
  const head = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ws: { path, initialHead: head, mainSha: head, unmerged: [], mergePending: false }, head, trace: new Trace(join(root, 'trace')) };
}

test('Harness commits remaining changes after an Agent commit instead of dropping them', async () => {
  const { ws, head, trace } = await fixture();
  await writeFile(join(ws.path, 'value.txt'), 'agent\n');
  await git(ws.path, ['commit', '-am', 'Agent commit']);
  const agentHead = (await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(ws.path, 'extra.txt'), 'remaining change\n');
  assert.equal((await validateWorkspace(ws, [nodeFileExists('extra.txt')], trace, head)).ok, true);
  const final = await commitRepair(ws, 'ci', trace, head);
  assert.notEqual(final, agentHead);
  assert.equal((await git(ws.path, ['rev-parse', 'HEAD^'])).stdout.trim(), agentHead);
  assert.equal((await git(ws.path, ['show', 'HEAD:extra.txt'])).stdout, 'remaining change\n');
  assert.equal((await git(ws.path, ['status', '--porcelain'])).stdout, '');
});

test('clean unchanged HEAD is explicitly rejected without fabricating an empty commit', async () => {
  const { ws, head, trace } = await fixture();
  assert.equal((await validateWorkspace(ws, [nodeExit(0)], trace, head)).ok, false);
  await assert.rejects(commitRepair(ws, 'ci', trace, head), /refusing a no-op repair/);
  assert.equal((await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim(), head);
});

test('committed whitespace is advisory, and correcting it clears the warning', async () => {
  const { ws, head, trace } = await fixture();
  await writeFile(join(ws.path, 'value.txt'), 'after  \n');
  await git(ws.path, ['commit', '-am', 'Agent bad whitespace']);
  const validation = await validateWorkspace(ws, [nodeExit(0)], trace, head);
  assert.equal(validation.staged.exitCode, 0);
  assert.equal(validation.unstaged.exitCode, 0);
  assert.equal(validation.ok, true);
  assert.ok(validation.warnings.length > 0);
  assert.match(validation.candidate?.stdout ?? '', /trailing whitespace/);
  await writeFile(join(ws.path, 'value.txt'), 'after\n');
  assert.equal((await validateWorkspace(ws, [nodeExit(0)], trace, head)).ok, true);
  await commitRepair(ws, 'ci', trace, head);
  assert.equal((await git(ws.path, ['diff', '--check', head, 'HEAD'])).exitCode, 0);
});

test('a pending merge with an identical tree still needs a merge commit', async () => {
  const { ws, head, trace } = await fixture();
  await git(ws.path, ['checkout', '-b', 'other']);
  await git(ws.path, ['commit', '--allow-empty', '-m', 'Other history']);
  const other = (await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(ws.path, ['checkout', 'main']);
  await git(ws.path, ['merge', '--no-commit', '--no-ff', other]);
  const validation = await validateWorkspace(ws, [nodeExit(0)], trace, head);
  assert.equal(validation.repair_changes?.dirty, false);
  assert.equal(validation.repair_changes?.merge_pending, true);
  assert.equal(validation.ok, true);
  await commitRepair(ws, 'conflict', trace, head);
  assert.equal((await git(ws.path, ['rev-parse', 'HEAD^2'])).stdout.trim(), other);
});

test('real commit failures are not swallowed', async () => {
  const { ws, head, trace } = await fixture();
  await writeFile(join(ws.path, 'value.txt'), 'after\n');
  await writeFile(join(ws.path, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  await assert.rejects(commitRepair(ws, 'ci', trace, head), /Git command failed: commit/);
  assert.equal((await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim(), head);
});
