import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeControlPlaneDb, openControlPlaneDb } from '../src/control-plane/db.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import { CONTROL_PLANE_MIGRATION_VERSION, CONTROL_PLANE_SCHEMA_VERSION } from '../src/control-plane/schema.ts';

/** A minimal, data-bearing private-era v3 control-plane shape. */
const V3_FIXTURE = `
CREATE TABLE control_plane_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE control_plane_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  full_name_normalized TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE prompt_assets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('public', 'repository')),
  repository_id TEXT REFERENCES repositories(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_public_id TEXT,
  source_public_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'public' AND repository_id IS NULL) OR (scope = 'repository' AND repository_id IS NOT NULL)),
  CHECK (source_public_revision IS NULL OR source_public_revision > 0)
);
CREATE TABLE skill_assets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('public', 'repository')),
  repository_id TEXT REFERENCES repositories(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_public_id TEXT,
  source_public_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'public' AND repository_id IS NULL) OR (scope = 'repository' AND repository_id IS NOT NULL)),
  CHECK (source_public_revision IS NULL OR source_public_revision > 0)
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_ref TEXT,
  request_options_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model_identifier TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, model_identifier)
);
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  slash_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  execution_type TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read_only', 'read_write', 'read_write_approval')),
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, slash_name)
);
CREATE TABLE command_prompts (
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  prompt_asset_id TEXT NOT NULL REFERENCES prompt_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  binding_kind TEXT NOT NULL DEFAULT 'main',
  PRIMARY KEY(command_id, position), UNIQUE(command_id, prompt_asset_id)
);
CREATE TABLE command_skills (
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  skill_asset_id TEXT NOT NULL REFERENCES skill_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY(command_id, position), UNIQUE(command_id, skill_asset_id)
);
CREATE TABLE conversation_profiles (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE profile_prompts (
  profile_id TEXT NOT NULL REFERENCES conversation_profiles(id) ON DELETE CASCADE,
  prompt_asset_id TEXT NOT NULL REFERENCES prompt_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  binding_kind TEXT NOT NULL DEFAULT 'main',
  PRIMARY KEY(profile_id, position), UNIQUE(profile_id, prompt_asset_id)
);
CREATE TABLE profile_skills (
  profile_id TEXT NOT NULL REFERENCES conversation_profiles(id) ON DELETE CASCADE,
  skill_asset_id TEXT NOT NULL REFERENCES skill_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY(profile_id, position), UNIQUE(profile_id, skill_asset_id)
);

INSERT INTO control_plane_meta(key, value) VALUES ('schema_version', '3'), ('migration_version', '3');
INSERT INTO control_plane_migrations(version, applied_at) VALUES (3, '2026-09-20T00:00:00.000Z');
INSERT INTO repositories(id, full_name_normalized, display_name, revision, created_at, updated_at)
  VALUES ('repo-v3', 'owner/lab', 'Lab', 7, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO prompt_assets(id, scope, repository_id, slug, title, role, content, enabled, revision, created_at, updated_at) VALUES
  ('prompt-public', 'public', NULL, 'custom-public', 'Custom public', NULL, '# public', 1, 3, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
  ('prompt-repo', 'repository', 'repo-v3', 'custom-repo', 'Custom repo', 'custom-role', '# repo', 1, 4, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO skill_assets(id, scope, repository_id, slug, title, description, content, enabled, revision, created_at, updated_at)
  VALUES ('skill-repo', 'repository', 'repo-v3', 'custom-skill', 'Custom skill', 'custom guidance', '# skill', 1, 2, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO providers(id, type, display_name, base_url, credential_ref, request_options_json, enabled, revision, created_at, updated_at)
  VALUES ('provider-v3', 'zhipu', 'Zhipu', 'https://provider.test/v1', 'env:ZAI_API_KEY', '{}', 1, 2, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO provider_models(id, provider_id, model_identifier, display_name, enabled, revision, created_at, updated_at)
  VALUES ('model-v3', 'provider-v3', 'glm-v3', 'GLM v3', 1, 2, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO commands(id, repository_id, slash_name, display_name, description, execution_type, permission, provider_model_id, enabled, revision, created_at, updated_at)
  VALUES ('command-v3', 'repo-v3', 'custom', 'Custom', 'kept', 'custom', 'read_write_approval', 'model-v3', 1, 5, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind) VALUES ('command-v3', 'prompt-repo', 1, 1, 'main');
INSERT INTO command_skills(command_id, skill_asset_id, position, enabled) VALUES ('command-v3', 'skill-repo', 1, 1);
INSERT INTO conversation_profiles(id, repository_id, display_name, provider_model_id, enabled, revision, created_at, updated_at)
  VALUES ('profile-v3', 'repo-v3', 'Conversation', 'model-v3', 1, 3, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
INSERT INTO profile_prompts(profile_id, prompt_asset_id, position, enabled, binding_kind) VALUES ('profile-v3', 'prompt-repo', 1, 1, 'main');
INSERT INTO profile_skills(profile_id, skill_asset_id, position, enabled) VALUES ('profile-v3', 'skill-repo', 1, 1);
`;

test('schema 3 to 4 rehearsal preserves representative control-plane data and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-schema-v3-rehearsal-'));
  const paths = patchpawPaths(root);
  await mkdir(paths.data, { recursive: true });
  const legacy = createClient({ url: pathToFileURL(paths.controlPlaneDb).href });
  await legacy.executeMultiple(V3_FIXTURE);
  legacy.close();

  const first = await openControlPlaneDb(root);
  try {
    assert.equal(await first.getMeta('schema_version'), CONTROL_PLANE_SCHEMA_VERSION);
    assert.equal(await first.getMeta('migration_version'), String(CONTROL_PLANE_MIGRATION_VERSION));
    assert.deepEqual((await first.execute('SELECT full_name_normalized, scm_kind, storage_key, connection_id, remote_project_id FROM repositories WHERE id = :id', { id: 'repo-v3' })).rows[0], {
      full_name_normalized: 'owner/lab', scm_kind: 'github', storage_key: 'owner/lab', connection_id: null, remote_project_id: null,
    });
    assert.equal((await first.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('scm_connections', 'builtin_asset_migrations') ORDER BY name")).rows.length, 2);
    assert.deepEqual((await first.execute('SELECT id, content, revision FROM prompt_assets WHERE id IN (:public, :repo) ORDER BY id', { public: 'prompt-public', repo: 'prompt-repo' })).rows, [
      { id: 'prompt-public', content: '# public', revision: 3 },
      { id: 'prompt-repo', content: '# repo', revision: 4 },
    ]);
    assert.deepEqual((await first.execute('SELECT id, content, revision FROM skill_assets WHERE id = :id', { id: 'skill-repo' })).rows[0], {
      id: 'skill-repo', content: '# skill', revision: 2,
    });
    assert.deepEqual((await first.execute('SELECT permission, provider_model_id, revision FROM commands WHERE id = :id', { id: 'command-v3' })).rows[0], {
      permission: 'read_write_approval', provider_model_id: 'model-v3', revision: 5,
    });
    assert.equal((await first.execute('SELECT COUNT(*) AS count FROM command_prompts WHERE command_id = :id', { id: 'command-v3' })).rows[0]?.count, 1);
    assert.equal((await first.execute('SELECT COUNT(*) AS count FROM profile_skills WHERE profile_id = :id', { id: 'profile-v3' })).rows[0]?.count, 1);
    assert.equal((await first.execute('PRAGMA integrity_check')).rows[0]?.integrity_check, 'ok');
  } finally { closeControlPlaneDb(first); }

  const second = await openControlPlaneDb(root);
  try {
    assert.equal((await second.execute('SELECT COUNT(*) AS count FROM repositories')).rows[0]?.count, 1);
    assert.equal((await second.execute('SELECT COUNT(*) AS count FROM prompt_assets')).rows[0]?.count, 2);
    assert.equal((await second.execute('SELECT COUNT(*) AS count FROM skill_assets')).rows[0]?.count, 1);
    assert.equal((await second.execute('SELECT COUNT(*) AS count FROM command_prompts')).rows[0]?.count, 1);
    assert.equal((await second.execute('SELECT COUNT(*) AS count FROM profile_skills')).rows[0]?.count, 1);
    assert.equal((await second.execute('SELECT storage_key FROM repositories WHERE id = :id', { id: 'repo-v3' })).rows[0]?.storage_key, 'owner/lab');
  } finally { closeControlPlaneDb(second); }
});
