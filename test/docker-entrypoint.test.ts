import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const entrypoint = join(process.cwd(), 'docker-entrypoint.sh');
const migrationScript = '/app/scripts/migrate-builtin-assets.ts';

async function fixture(prefix: string, options: { existingRuntime?: boolean; migrationExit?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const bin = join(root, 'bin');
  const home = join(root, 'runtime');
  const marker = join(root, 'calls');
  await mkdir(bin);
  if (options.existingRuntime) {
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(join(home, 'data', 'control-plane.db'), 'fixture');
  }
  const nodeScript = [
    '#!/bin/sh',
    'printf \'node:%s\\n\' "$*" >> "$DOCKER_TEST_MARKER"',
    `if [ "$1" = "--import" ] && [ "$3" = "${migrationScript}" ]; then exit "\${DOCKER_TEST_MIGRATION_EXIT:-0}"; fi`,
    'printf node-command',
    '',
  ].join('\n');
  const npmScript = [
    '#!/bin/sh',
    'printf \'npm:%s\\n\' "$*" >> "$DOCKER_TEST_MARKER"',
    'printf npm-command',
    '',
  ].join('\n');
  await writeFile(join(bin, 'node'), nodeScript);
  await writeFile(join(bin, 'npm'), npmScript);
  await Promise.all([chmod(join(bin, 'node'), 0o755), chmod(join(bin, 'npm'), 0o755)]);

  return {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      PATCHPAW_HOME: home,
      DOCKER_TEST_MARKER: marker,
      DOCKER_TEST_MIGRATION_EXIT: String(options.migrationExit ?? 0),
    },
    run(args: string[]) {
      return spawnSync('/bin/sh', [entrypoint, ...args], { encoding: 'utf8', env: this.env });
    },
    async calls() {
      return readFile(marker, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Docker entrypoint skips builtin migration for fresh runtime on canonical server start', async () => {
  const f = await fixture('patchpaw-entrypoint-fresh-');
  try {
    const result = f.run(['node', '--import', 'tsx', 'src/index.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'node-command');
    assert.equal(await f.calls(), 'node:--import tsx src/index.ts\n');
  } finally {
    await f.cleanup();
  }
});

test('Docker entrypoint applies builtin migration before canonical server start for an existing runtime', async () => {
  const f = await fixture('patchpaw-entrypoint-existing-', { existingRuntime: true });
  try {
    const result = f.run(['node', '--import', 'tsx', 'src/index.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PatchPaw: applying versioned builtin asset migrations\nnode-command');
    assert.equal(await f.calls(), [
      `node:--import tsx ${migrationScript} --apply`,
      'node:--import tsx src/index.ts',
      '',
    ].join('\n'));
  } finally {
    await f.cleanup();
  }
});

test('Docker entrypoint fails closed when canonical server startup migration fails', async () => {
  const f = await fixture('patchpaw-entrypoint-failure-', { existingRuntime: true, migrationExit: 23 });
  try {
    const result = f.run(['node', '--import', 'tsx', 'src/index.ts']);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /node-command/);
    assert.match(result.stderr, /builtin asset migration failed; refusing to start the PatchPaw service/);
    assert.equal(await f.calls(), `node:--import tsx ${migrationScript} --apply\n`);
  } finally {
    await f.cleanup();
  }
});

test('Docker entrypoint does not migrate for backup, observer, or diagnostic commands', async () => {
  const commands = [
    { args: ['npm', 'run', 'backup-runtime'], output: 'npm-command', calls: 'npm:run backup-runtime\n' },
    { args: ['npm', 'run', 'agent:runs'], output: 'npm-command', calls: 'npm:run agent:runs\n' },
    { args: ['/bin/sh', '-c', 'printf diagnostic-command'], output: 'diagnostic-command', calls: '' },
    { args: ['node', '--version'], output: 'node-command', calls: 'node:--version\n' },
  ];

  for (const command of commands) {
    const f = await fixture('patchpaw-entrypoint-operator-', { existingRuntime: true });
    try {
      const result = f.run(command.args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, command.output);
      assert.equal(await f.calls(), command.calls);
      assert.doesNotMatch(await f.calls(), /migrate-builtin-assets/);
    } finally {
      await f.cleanup();
    }
  }
});
