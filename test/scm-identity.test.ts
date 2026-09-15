import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRequestThreadId, normalizeGitLabPath, normalizeInstanceUrl, safeStorageDirectory, storageKey } from '../src/scm/identity.ts';

test('SCM identity preserves GitHub legacy keys and isolates GitLab instances and nested projects', () => {
  assert.equal(normalizeInstanceUrl('https://git.example/root/'), 'https://git.example/root');
  assert.equal(normalizeGitLabPath('Group/Subgroup/Repo'), 'group/subgroup/repo');
  assert.equal(storageKey('gitlab', 'one', 42), 'gitlab:one:project:42');
  assert.notEqual(storageKey('gitlab', 'one', 42), storageKey('gitlab', 'two', 42));
  assert.notEqual(safeStorageDirectory(storageKey('gitlab', 'one', 42)), safeStorageDirectory(storageKey('gitlab', 'two', 42)));
  assert.equal(changeRequestThreadId('gitlab', storageKey('gitlab', 'one', 42), 3), 'gitlab:gitlab:one:project:42:mr:3');
  assert.throws(() => normalizeGitLabPath('../repo'));
});
