import { migrateRuntime } from '../src/migration/runtime.ts';

const [legacyHome, runtimeHome, cleanup] = process.argv.slice(2);
if (!legacyHome || !runtimeHome || cleanup !== '--cleanup-terminal') {
  throw new Error('Usage: npm run migrate-runtime -- /path/to/legacy-home /path/to/.patchpaw --cleanup-terminal');
}

const report = await migrateRuntime({ legacyHome, runtimeHome, cleanupTerminalWorkspaces: true });
console.log(JSON.stringify(report, null, 2));
