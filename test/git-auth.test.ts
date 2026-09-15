import test from 'node:test';
import assert from 'node:assert/strict';
import { gitAuth } from '../src/workspace/git.ts';

test('GitLab path scoped Git credentials stay inside the configured instance path', () => {
  const env = gitAuth('secret-token', 'https://git.example/gitlab/group/repo.git', 'oauth2', 'https://git.example/gitlab');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://git.example/gitlab/.extraheader');
  assert.match(env.GIT_CONFIG_VALUE_0 ?? '', /^AUTHORIZATION: basic /);
  assert.throws(() => gitAuth('secret-token', 'https://git.example/other/repo.git', 'oauth2', 'https://git.example/gitlab'), /does not contain/);
  assert.throws(() => gitAuth('secret-token', 'https://other.example/gitlab/repo.git', 'oauth2', 'https://git.example/gitlab'), /crossed/);
  assert.throws(() => gitAuth('secret-token', 'https://git.example/gitlab/repo.git?token=secret', 'oauth2', 'https://git.example/gitlab'), /unsafe/);
});
