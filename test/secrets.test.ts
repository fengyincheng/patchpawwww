import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { SecretStore } from '../src/control-plane/secrets.ts';
import { ControlPlaneError } from '../src/control-plane/errors.ts';
import { patchpawPaths } from '../src/config/paths.ts';

const execFileAsync = promisify(execFile);

test('provider slots retain strict Unix directory and file permissions', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-secret-permissions-'));
  try {
    const store = new SecretStore(root);
    const ref = await store.writeProviderSecret('unix-provider', 'unix-secret');
    const paths = patchpawPaths(root);
    assert.equal((await stat(paths.secrets)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.providerSecrets)).mode & 0o777, 0o700);
    assert.equal((await stat(store.pathForRef(ref))).mode & 0o777, 0o600);
    assert.equal(await store.read(ref), 'unix-secret');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider slots use and re-verify a restricted Windows ACL', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-secret-acl-'));
  try {
    const store = new SecretStore(root);
    const ref = await store.writeProviderSecret('windows-provider', 'windows-secret');
    const slot = store.pathForRef(ref);
    assert.equal(await store.isConfigured(ref), true);
    assert.equal(await store.read(ref), 'windows-secret');

    // Make the ACL unsafe, then prove reads fail closed and a rotation restores
    // the native protection before the new value is accepted.
    await execFileAsync('icacls', [slot, '/grant', '*S-1-1-0:R'], { windowsHide: true });
    assert.equal(await store.isConfigured(ref), false);
    await assert.rejects(store.read(ref), error => error instanceof ControlPlaneError && error.code === 'invalid_configuration');

    await store.writeProviderSecret('windows-provider', 'rotated-secret');
    assert.equal(await store.isConfigured(ref), true);
    assert.equal(await store.read(ref), 'rotated-secret');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Unix secret slots reject a mode change before reading', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-secret-read-'));
  try {
    const store = new SecretStore(root);
    const ref = await store.writeProviderSecret('mode-provider', 'mode-secret');
    const slot = store.pathForRef(ref);
    await chmod(slot, 0o644);
    assert.equal(await store.isConfigured(ref), false);
    await assert.rejects(store.read(ref), error => error instanceof ControlPlaneError && error.code === 'invalid_configuration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
