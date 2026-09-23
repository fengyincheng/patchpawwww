import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const entrypoint = join(process.cwd(), 'docker-entrypoint.sh');

test('Docker entrypoint skips builtin migration for a fresh runtime home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-entrypoint-fresh-'));
  const bin = join(root, 'bin');
  const home = join(root, 'runtime');
  const marker = join(root, 'node-calls');
  await mkdir(bin);
  await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_MARKER"\n');
  await chmod(join(bin, 'node'), 0o755);

  try {
    const result = spawnSync('/bin/sh', [entrypoint, '/bin/sh', '-c', 'printf runtime-command'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PATCHPAW_HOME: home, DOCKER_TEST_MARKER: marker },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'runtime-command');
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker entrypoint applies only versioned builtin migrations before starting an existing runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-entrypoint-existing-'));
  const bin = join(root, 'bin');
  const home = join(root, 'runtime');
  const marker = join(root, 'node-calls');
  await mkdir(join(home, 'data'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, 'data', 'control-plane.db'), 'fixture');
  await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_MARKER"\n');
  await chmod(join(bin, 'node'), 0o755);

  try {
    const result = spawnSync('/bin/sh', [entrypoint, '/bin/sh', '-c', 'printf runtime-command'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PATCHPAW_HOME: home, DOCKER_TEST_MARKER: marker },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PatchPaw: applying versioned builtin asset migrations\nruntime-command');
    const calls = await readFile(marker, 'utf8');
    assert.match(calls, /^--import tsx \/app\/scripts\/migrate-builtin-assets\.ts --apply\n$/);
    assert.doesNotMatch(calls, /sync:operation|sync-operation-prompts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker entrypoint fails closed when an existing runtime builtin migration fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-entrypoint-failure-'));
  const bin = join(root, 'bin');
  const home = join(root, 'runtime');
  const marker = join(root, 'node-calls');
  await mkdir(join(home, 'data'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, 'data', 'control-plane.db'), 'fixture');
  await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_MARKER"\nexit 23\n');
  await chmod(join(bin, 'node'), 0o755);

  try {
    const result = spawnSync('/bin/sh', [entrypoint, '/bin/sh', '-c', 'printf runtime-command'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PATCHPAW_HOME: home, DOCKER_TEST_MARKER: marker },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /runtime-command/);
    assert.match(result.stderr, /builtin asset migration failed; refusing to start/);
    assert.match(await readFile(marker, 'utf8'), /migrate-builtin-assets\.ts --apply/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
