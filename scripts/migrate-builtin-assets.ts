import { configuredRuntimeHome, loadProjectEnvIfPresent } from '../src/config/env.ts';
import { openControlPlaneDb } from '../src/control-plane/db.ts';
import { BUILTIN_ASSET_MIGRATION_IDS, listBuiltinAssetMigrations, runBuiltinAssetMigrations } from '../src/control-plane/builtin-migrations.ts';

// Versioned builtin-asset migrations add newly required system-known assets
// without refreshing operator-owned content. This is deliberately not
// `sync:operation`: Prompt source edits stay an explicit operator action,
// while a deploy may safely install a missing builtin.
//
// Without --apply this only reports which migrations are pending.
loadProjectEnvIfPresent();

const apply = process.argv.includes('--apply');
const db = await openControlPlaneDb(configuredRuntimeHome());
try {
  if (!apply) {
    const applied = new Set((await listBuiltinAssetMigrations(db)).map(migration => migration.id));
    const pending = BUILTIN_ASSET_MIGRATION_IDS.filter(id => !applied.has(id));
    console.log(JSON.stringify({ mode: 'dry-run', applied: [...applied], pending }, null, 2));
  } else {
    const reports = await runBuiltinAssetMigrations(db);
    console.log(JSON.stringify({ mode: 'apply',
      applied: reports.map(report => ({ id: report.migrationId, actions: report.actions })) }, null, 2));
  }
} catch (error) {
  // Fail closed: a contradictory ownership marker aborts the deploy instead of
  // overwriting an asset PatchPaw does not own.
  console.error(JSON.stringify({ status: 'builtin_migration_failed', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  db.close();
}
