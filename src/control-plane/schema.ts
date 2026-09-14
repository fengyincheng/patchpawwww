import type { Client } from '@libsql/client';

export const CONTROL_PLANE_SCHEMA_VERSION = '2';
export const CONTROL_PLANE_MIGRATION_VERSION = 2;

/**
 * The control plane has its own schema and lifecycle. It deliberately does not
 * share tables with communication.db: configuration edits and outbound delivery
 * have different locking, retention, and recovery semantics.
 */
export const CONTROL_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_plane_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  full_name_normalized TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_assets (
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
  CHECK ((scope = 'public' AND repository_id IS NULL) OR
         (scope = 'repository' AND repository_id IS NOT NULL)),
  CHECK (source_public_revision IS NULL OR source_public_revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_public_slug
  ON prompt_assets(slug) WHERE scope = 'public';
CREATE UNIQUE INDEX IF NOT EXISTS prompt_repository_slug
  ON prompt_assets(repository_id, slug) WHERE scope = 'repository';
CREATE UNIQUE INDEX IF NOT EXISTS prompt_public_active_role
  ON prompt_assets(role) WHERE scope = 'public' AND role IS NOT NULL AND enabled = 1;
CREATE UNIQUE INDEX IF NOT EXISTS prompt_repository_active_role
  ON prompt_assets(repository_id, role)
  WHERE scope = 'repository' AND role IS NOT NULL AND enabled = 1;
CREATE INDEX IF NOT EXISTS prompt_assets_repository ON prompt_assets(repository_id, slug);

CREATE TABLE IF NOT EXISTS skill_assets (
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
  CHECK ((scope = 'public' AND repository_id IS NULL) OR
         (scope = 'repository' AND repository_id IS NOT NULL)),
  CHECK (source_public_revision IS NULL OR source_public_revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_public_slug
  ON skill_assets(slug) WHERE scope = 'public';
CREATE UNIQUE INDEX IF NOT EXISTS skill_repository_slug
  ON skill_assets(repository_id, slug) WHERE scope = 'repository';
CREATE INDEX IF NOT EXISTS skill_assets_repository ON skill_assets(repository_id, slug);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('zhipu', 'deepseek', 'openrouter', 'kimi', 'qwen')),
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_ref TEXT,
  request_options_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_models (
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

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  slash_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  execution_type TEXT NOT NULL CHECK (execution_type IN ('custom', 'review', 'repair', 'ci', 'conflict')),
  permission TEXT NOT NULL CHECK (permission IN ('read_only', 'read_write')),
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, slash_name)
);
CREATE INDEX IF NOT EXISTS commands_repository ON commands(repository_id, slash_name);

CREATE TABLE IF NOT EXISTS command_prompts (
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  prompt_asset_id TEXT NOT NULL REFERENCES prompt_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  binding_kind TEXT NOT NULL DEFAULT 'main' CHECK (binding_kind IN ('main', 'common', 'auxiliary')),
  PRIMARY KEY(command_id, position),
  UNIQUE(command_id, prompt_asset_id)
);

CREATE TABLE IF NOT EXISTS command_skills (
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  skill_asset_id TEXT NOT NULL REFERENCES skill_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY(command_id, position),
  UNIQUE(command_id, skill_asset_id)
);

CREATE TABLE IF NOT EXISTS conversation_profiles (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_prompts (
  profile_id TEXT NOT NULL REFERENCES conversation_profiles(id) ON DELETE CASCADE,
  prompt_asset_id TEXT NOT NULL REFERENCES prompt_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  binding_kind TEXT NOT NULL DEFAULT 'main' CHECK (binding_kind IN ('main', 'common', 'auxiliary')),
  PRIMARY KEY(profile_id, position),
  UNIQUE(profile_id, prompt_asset_id)
);

CREATE TABLE IF NOT EXISTS profile_skills (
  profile_id TEXT NOT NULL REFERENCES conversation_profiles(id) ON DELETE CASCADE,
  skill_asset_id TEXT NOT NULL REFERENCES skill_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY(profile_id, position),
  UNIQUE(profile_id, skill_asset_id)
);

CREATE TABLE IF NOT EXISTS bootstrap_markers (
  id TEXT PRIMARY KEY,
  repository_id TEXT REFERENCES repositories(id) ON DELETE RESTRICT,
  seed_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT,
  source_digest TEXT NOT NULL,
  source_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('seeded', 'override', 'disabled', 'tombstone')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bootstrap_marker_scope_key
  ON bootstrap_markers(COALESCE(repository_id, ''), seed_key);
CREATE INDEX IF NOT EXISTS bootstrap_marker_resource ON bootstrap_markers(resource_kind, resource_id);
`;

// SQLite cannot alter a CHECK constraint in place. Rebuild only the command
// tables so existing commands, prompt bindings, and skill bindings survive the
// addition of the independent custom task type.
const CUSTOM_COMMAND_MIGRATION = `
ALTER TABLE command_prompts RENAME TO command_prompts_v1;
ALTER TABLE command_skills RENAME TO command_skills_v1;
ALTER TABLE commands RENAME TO commands_v1;
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  slash_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  execution_type TEXT NOT NULL CHECK (execution_type IN ('custom', 'review', 'repair', 'ci', 'conflict')),
  permission TEXT NOT NULL CHECK (permission IN ('read_only', 'read_write')),
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
  binding_kind TEXT NOT NULL DEFAULT 'main' CHECK (binding_kind IN ('main', 'common', 'auxiliary')),
  PRIMARY KEY(command_id, position),
  UNIQUE(command_id, prompt_asset_id)
);
CREATE TABLE command_skills (
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  skill_asset_id TEXT NOT NULL REFERENCES skill_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY(command_id, position),
  UNIQUE(command_id, skill_asset_id)
);
INSERT INTO commands SELECT * FROM commands_v1;
INSERT INTO command_prompts SELECT * FROM command_prompts_v1;
INSERT INTO command_skills SELECT * FROM command_skills_v1;
DROP TABLE command_prompts_v1;
DROP TABLE command_skills_v1;
DROP TABLE commands_v1;
`;

export async function ensureControlPlaneSchema(client: Client) {
  await client.execute('PRAGMA foreign_keys=ON');
  await client.execute(`CREATE TABLE IF NOT EXISTS control_plane_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS control_plane_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const currentRows = await client.execute('SELECT value FROM control_plane_meta WHERE key = :key', { key: 'migration_version' });
  const current = currentRows.rows[0] ? Number(String(currentRows.rows[0].value)) : 0;
  if (!Number.isInteger(current) || current > CONTROL_PLANE_MIGRATION_VERSION) {
    throw new Error(`Unsupported control-plane migration version: ${current}`);
  }
  if (current < CONTROL_PLANE_MIGRATION_VERSION) {
    const transaction = await client.transaction('write');
    try {
      if (current === 1) await transaction.executeMultiple(CUSTOM_COMMAND_MIGRATION);
      await transaction.executeMultiple(CONTROL_PLANE_SCHEMA);
      await transaction.execute({ sql: `INSERT INTO control_plane_migrations(version, applied_at) VALUES (:version, :applied_at)
        ON CONFLICT(version) DO NOTHING`, args: { version: CONTROL_PLANE_MIGRATION_VERSION, applied_at: new Date().toISOString() } });
      await transaction.execute({ sql: `INSERT INTO control_plane_meta(key, value) VALUES ('schema_version', :value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: { value: CONTROL_PLANE_SCHEMA_VERSION } });
      await transaction.execute({ sql: `INSERT INTO control_plane_meta(key, value) VALUES ('migration_version', :value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: { value: String(CONTROL_PLANE_MIGRATION_VERSION) } });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally { transaction.close(); }
  } else {
    // Keep CREATE IF NOT EXISTS here so a restart can repair an interrupted
    // index/table creation without falsely advancing the migration marker.
    await client.executeMultiple(CONTROL_PLANE_SCHEMA);
  }
}
