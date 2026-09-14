import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchpawPaths, legacyRuntimePaths, runtimeHomeFromCommunicationDb } from '../src/config/paths.ts';
import { workspaceCommandEnvironment } from '../src/platform/command-environment.ts';

test('runtime paths keep mutable data under one configurable home', () => {
  const home = join(tmpdir(), 'patchpaw-test-home');
  const paths = patchpawPaths(home);
  assert.equal(paths.home, home);
  assert.equal(paths.communicationDb, join(home, 'data/communication.db'));
  assert.equal(paths.memory, join(home, 'data/memory'));
  assert.equal(paths.state, join(home, 'data/state'));
  assert.equal(paths.outbox, join(home, 'data/outbox'));
  assert.equal(paths.repos, join(home, 'repos'));
  assert.equal(paths.workspaces, join(home, 'workspaces'));
  assert.equal(paths.runs, join(home, 'runs'));
  assert.equal(paths.snapshots, join(home, 'snapshots'));
  assert.equal(paths.logs, join(home, 'logs'));
  assert.equal(paths.cache, join(home, 'cache'));
  assert.equal(paths.tmp, join(home, 'tmp'));
  assert.equal(paths.locks, join(home, 'locks'));
  assert.equal(paths.backups, join(home, 'backups'));
  assert.equal(runtimeHomeFromCommunicationDb(paths.communicationDb), paths.home);
  assert.equal(legacyRuntimePaths(paths.home).outbox, join(home, 'var/outbox'));
});

test('workspace commands receive platform runtime variables without server secrets', () => {
  const environment = workspaceCommandEnvironment({
    PATH: 'fixture-path', HOME: 'fixture-home', ComSpec: 'fixture-cmd', SystemRoot: 'fixture-root',
    TEMP: 'fixture-temp', USERPROFILE: 'fixture-user', PATCHPAW_ADMIN_TOKEN: 'must-not-pass',
  });
  assert.equal(environment.PATH, 'fixture-path');
  assert.equal(environment.PATCHPAW_ADMIN_TOKEN, undefined);
  if (process.platform === 'win32') {
    assert.equal(environment.ComSpec, 'fixture-cmd');
    assert.equal(environment.SystemRoot, 'fixture-root');
    assert.equal(environment.TEMP, 'fixture-temp');
    assert.equal(environment.USERPROFILE, 'fixture-user');
  } else {
    assert.equal(environment.HOME, 'fixture-home');
    assert.equal(environment.ComSpec, undefined);
  }
});
