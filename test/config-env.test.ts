import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadProjectEnvIfPresent } from '../src/config/env.ts';

test('project env loading is optional and preserves injected process values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-env-test-'));
  const key = `PATCHPAW_ENV_TEST_${process.pid}`;
  const envPath = join(root, '.env');
  delete process.env[key];

  try {
    assert.doesNotThrow(() => loadProjectEnvIfPresent(join(root, 'missing.env')));
    await writeFile(envPath, `${key}=from_file\n`);
    loadProjectEnvIfPresent(envPath);
    assert.equal(process.env[key], 'from_file');

    process.env[key] = 'from_process';
    loadProjectEnvIfPresent(envPath);
    assert.equal(process.env[key], 'from_process');
  } finally {
    delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test('listen host defaults to loopback and accepts an explicit container host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-listen-test-'));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'control-plane.db'), '');

  const names = [
    'PATCHPAW_GITHUB_APP_ID', 'PATCHPAW_GITHUB_APP_SLUG', 'PATCHPAW_GITHUB_WEBHOOK_SECRET',
    'PATCHPAW_GITHUB_PRIVATE_KEY_PATH', 'PATCHPAW_GITHUB_TEST_REPO', 'PATCHPAW_PUBLIC_ORIGIN',
    'PATCHPAW_PORT', 'PATCHPAW_LISTEN_HOST', 'PATCHPAW_HOME', 'PATCHPAW_ADMIN_TOKEN',
    'PATCHPAW_GITLAB_CONNECTIONS',
  ] as const;
  const previous = new Map(names.map(name => [name, process.env[name]]));
  const setBaseConfig = (listenHost: string) => {
    Object.assign(process.env, {
      PATCHPAW_GITHUB_APP_ID: '', PATCHPAW_GITHUB_APP_SLUG: '', PATCHPAW_GITHUB_WEBHOOK_SECRET: '',
      PATCHPAW_GITHUB_PRIVATE_KEY_PATH: '', PATCHPAW_GITHUB_TEST_REPO: '', PATCHPAW_PUBLIC_ORIGIN: 'http://localhost:3000',
      PATCHPAW_PORT: '3000', PATCHPAW_LISTEN_HOST: listenHost, PATCHPAW_HOME: root,
      PATCHPAW_ADMIN_TOKEN: 'config-test-token', PATCHPAW_GITLAB_CONNECTIONS: '',
    });
  };

  try {
    setBaseConfig('');
    assert.equal(loadConfig().listenHost, '127.0.0.1');

    setBaseConfig('0.0.0.0');
    assert.equal(loadConfig().listenHost, '0.0.0.0');
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
